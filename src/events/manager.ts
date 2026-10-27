import { syncerFor } from ".";
import { Hex, RawLog, VaultRef } from "./types";
import { toVaultId, VaultKey, VaultLedger } from "./ledger";
import { Order, OrderManager } from "../order";
import { SharedState } from "../state";
import { SgFilter } from "../subgraph/filter";
import { SubgraphManager, SubgraphVersions } from "../subgraph";
import { erc20Abi, PublicClient } from "viem";
import { DEFAULT_START_TIMEOUT, OrderbookSyncer, SnapshotReport } from "./syncer";
import { ABI, normalizeFloat, Result, sleep, TokenDetails } from "../common";
import { fetchOrderbookLogs, subscribeToOrderbookLogs } from "./stream";

/** Delay (in ms) before an errored logs subscription is opened again */
export const LOGS_RESUBSCRIBE_DELAY = 15_000;

/**
 * The blocks the poll starts below the last ws head after a drop, the logs of a block and
 * its head are separate frames, and the logs can come a few blocks after the
 * heads on a fast chain, so the head can land and the socket die before the
 * logs of those blocks do. The extra read is cheap, the syncers drop the logs
 * they have
 */
export const BACKFILL_LOOKBACK = 8n;

/** The blocks the poll reads past the block a reopened subscription started at, before the stream takes over from it */
export const BACKFILL_HEAD_MARGIN = 2n;

/**
 * The blocks of the chain a start may take by default, on a slow chain, the
 * start waits for a few blocks in the buffer before it fetches the snapshot
 */
export const START_TIMEOUT_BLOCKS = 20;

/**
 * The least time (in ms) between two start attempts of a syncer, an attempt
 * reads the subgraph and the rpc, a fast chain would do it on every block
 */
export const START_ATTEMPT_INTERVAL = 2_000;

/**
 * The most retries of a token or a vault read after its first failure. The
 * wait before each retry doubles, 2, 4 and then 8 blocks. A read that fails
 * once more gives up, see OrderbookSyncer.giveUp
 */
export const READ_MAX_RETRIES = 3;

/** How many more times init asks a subgraph that did not answer for its orderbooks */
export const INIT_SUBGRAPH_RETRIES = 2;

/** The wait (in ms) before init asks a subgraph that did not answer again */
export const INIT_SUBGRAPH_RETRY_DELAY = 5_000;

/**
 * The number of blocks below the next block that each http poll reads again,
 * to find the logs that a reorg removed. A reorg is usually 1 or 2 blocks deep
 */
export const POLL_REREAD_BLOCKS = 8n;

/**
 * The orderbook functions that the needs resolution reads the vault balances
 * with, a uint256 on a v4 orderbook, a rain float on a v5 or v6 one. The
 * multicall checks the function names against them at compile time
 */
const VAULT_BALANCE_ABI = [ABI.Orderbook.V6.Primary.Orderbook[13]] as const;
const VAULT_BALANCE_V4_ABI = [ABI.Orderbook.V4.Primary.Orderbook[3]] as const;

export type EventSyncManagerConfig = {
    state: SharedState;
    orderManager: OrderManager;
    subgraphManager: SubgraphManager;
    /** The order filters, the same the subgraph fetch applies */
    filters?: SgFilter;
    /** Delay before an errored subscription is opened again, default is LOGS_RESUBSCRIBE_DELAY */
    resubscribeDelay?: number;
    /** How long (in ms) a syncer may take to go live before its start gives up, default is DEFAULT_START_TIMEOUT or START_TIMEOUT_BLOCKS blocks of the chain, the longer */
    startTimeout?: number;
    /** The least time (in ms) between two start attempts of a syncer, default is START_ATTEMPT_INTERVAL */
    startAttemptInterval?: number;
    /** The wait (in ms) before init asks a subgraph that did not answer again, default is INIT_SUBGRAPH_RETRY_DELAY */
    subgraphRetryDelay?: number;
    /** How long (in ms) an orderbook may stay not live, or the poll may stay behind, before the report marks it out of sync, default is the start timeout */
    outOfSyncAfter?: number;
};

/** The logs of one recent block, as the poll read them or as the ws stream delivered them */
export type PolledBlock = {
    /** The block hash of the logs, undefined when the rpc did not serve it */
    hash?: Hex;
    /** The logs, by transaction hash and log index */
    logs: Map<string, RawLog>;
};

/**
 * The one log stream of every orderbook under sync, a subscription in ws mode,
 * a poll in http mode. In ws mode the poll also stands in while the
 * subscription is down, see EventSyncManager
 */
export type LogStream = {
    /** Closes the subscription, undefined while none is open, ws mode only */
    unsubscribe?: () => void;
    /** The node acknowledged the subscription, every log from now on is served, ws mode only */
    open: boolean;
    /** The sealed head when the subscription was acknowledged, ws mode only */
    openedAt?: bigint;
    /**
     * The last ws head when the subscription was acknowledged. A ws head above
     * it came after the acknowledgement, so the stream was open while its
     * block was sealed, the logs of that first block can still be partial, the
     * syncer counts its first block as partial, see coversHead, ws mode only
     */
    openedWsBlock?: bigint;
    resubscribeTimer?: ReturnType<typeof setTimeout>;
    /** The last block a log came in for, where the poll starts after a drop, ws mode only */
    lastLogBlock?: bigint;
    /** The poll stands in for the subscription, from a drop until the stream takes over again, ws mode only */
    fallback: boolean;
    /**
     * The block the poll must read before the reopened stream takes over. The
     * logs of the stream wait in the buffers of the syncers until then, they
     * are newer than the blocks the poll has not read yet, ws mode only
     */
    handoverAt?: bigint;
    /** The first block the poll read, a read again never goes below it */
    pollStart?: bigint;
    /** The next block the poll reads, undefined before the first poll */
    pollFrom?: bigint;
    /** A poll is in flight, the next block does not start another */
    polling: boolean;
    /** The logs of the recent blocks, by block number, as the poll read them or as the ws stream delivered them */
    polledBlocks: Map<bigint, PolledBlock>;
    /** The last error of the subscription or of a poll, for the report */
    lastError?: unknown;
    /**
     * When (in ms) the stream fell behind the head: the first sealed head the
     * poll has not read came then, or a drop left blocks for the poll to read.
     * A failed or slow poll keeps it, a poll that catches up with the head
     * clears it, see EventSyncManager.report
     */
    behindSince?: number;
    /** How many times the subscription dropped */
    drops: number;
    /** How many new logs the poll read while it stood in for the subscription */
    backfilled: number;
    /** How many logs the poll found removed by a reorg */
    reorged: number;
};

/** The failures of a token or a vault read, and the block of its next try, see READ_MAX_RETRIES */
export type ReadRetry = { failures: number; retryAt: bigint };

/** One orderbook under sync, its syncer and its subgraph */
export type OrderbookSync = {
    orderbook: Hex;
    /** The subgraph that indexes the orderbook, the snapshot source */
    url: string;
    /** The version of the subgraph, see OrderbookSyncerConfig.version */
    version: SubgraphVersions;
    syncer: OrderbookSyncer;
    /** A needs resolution is in flight, the next block waits for it */
    resolving: boolean;
    /** A needs resolution was asked for while one was in flight, it runs again after it */
    resolveAgain: boolean;
    /** The tokens whose reads failed */
    tokenRetries: Map<Hex, ReadRetry>;
    /** The vaults whose reads failed, by vault key */
    vaultRetries: Map<VaultKey, ReadRetry>;
    /** The wait before a start that gave up is tried again, see EventSyncManager.start */
    startRetryTimer?: ReturnType<typeof setTimeout>;
    /** The counts of failures, of bad logs and of given up orders at the previous report, see report */
    reported: { failed: number; badLogs: number; givenUp: number };
    /** The last error of a token or a vault read, for the report */
    lastError?: unknown;
    /** When (in ms) the start began, while the orderbook is not live, see EventSyncManager.report */
    notLiveSince?: number;
};

/** What the manager reports for an orderbook, for the round span */
export type OrderbookSyncReport = {
    orderbook: Hex;
    url: string;
    version: SubgraphVersions;
    phase: OrderbookSyncer["phase"];
    stats: OrderbookSyncer["stats"];
    needs: { tokens: number; vaults: number };
    /** How many events wait in the buffer of the syncer, for its start or for the stream to take over from the poll */
    buffered: number;
    /** How many logs carried a known event but did not decode, since the start */
    badLogs: number;
    /** How many events failed to apply since the previous report */
    newFailures: number;
    /** How many logs did not decode since the previous report */
    newBadLogs: number;
    /** How many orders were dropped since the previous report, parked or active, as a read they need gave up */
    newGivenUp: number;
    /** The orderbook is not live since the start for longer than outOfSyncAfter */
    outOfSync: boolean;
    startError?: string;
    lastError?: string;
};

/** What the manager reports, for the round span */
export type EventSyncReport = {
    mode: EventSyncManager["mode"];
    /** The one log stream of every orderbook */
    stream: {
        drops: number;
        backfilled: number;
        reorged: number;
        /** The poll reads the logs, and it is behind the head, or the block number polled over http is not read, for longer than outOfSyncAfter */
        outOfSync: boolean;
        lastError?: string;
    };
    orderbooks: OrderbookSyncReport[];
    /** The subgraphs that did not answer at init, their orderbooks are not synced */
    failedSubgraphs: string[];
};

/**
 * Runs the log sync of every orderbook the subgraphs index against one order
 * manager, of every orderbook version. It gets the logs of all orderbooks from
 * the chain on one stream, hands each log to the syncer of its orderbook,
 * starts the syncers off the subgraph snapshots, and answers what they need
 * with reads.
 *
 * The stream comes in one of two modes. Without a ws rpc, the http mode reads
 * the logs of all orderbooks with one range query on each new sealed block,
 * the poll, and the block number watcher polls the head over http. Each poll
 * reads the last POLL_REREAD_BLOCKS blocks again to find the logs that a reorg
 * removed. When a ws rpc is configured, the ws mode opens one log subscription
 * for all orderbooks and feeds the syncers with the logs and the sealed
 * blocks. A buffering syncer takes a head only when the stream covers its
 * block, see coversHead, so the start of its buffer is never below what the
 * stream delivered.
 *
 * When the subscription drops, or never opens, the poll stands in for it
 * and the syncers stay live. The poll starts at the latest proof that the
 * socket was alive, and its first read also compares the blocks below that
 * with the logs the stream delivered for them, so a reorg while the socket was
 * down is found. This holds for a logs subscription only, the pending logs of
 * flashblocks carry no block hash to compare. The subscription is opened
 * again after a delay. Once it is open, its logs wait in the buffers of the
 * syncers until the poll has read
 * past the block it opened at, then the syncers apply them in chain order and
 * the stream takes over from the poll.
 *
 * The subgraph snapshot is fetched once the syncers have buffered enough
 * blocks, at the block the subgraph is at, and a range query reads the gap
 * between that block and the buffer, see OrderbookSyncer.start. The subgraph
 * is not needed after that.
 */
export class EventSyncManager {
    readonly state: SharedState;
    readonly orderManager: OrderManager;
    readonly subgraphManager: SubgraphManager;
    readonly filters?: SgFilter;
    readonly resubscribeDelay: number;
    readonly startTimeout: number;
    readonly startAttemptInterval: number;
    /** How long (in ms) an orderbook may stay not live, or the poll may stay behind, see report */
    readonly outOfSyncAfter: number;
    /** Where the logs come from, a subscription over the ws rpc or a range query over http */
    readonly mode: "ws" | "http";
    readonly syncs = new Map<Hex, OrderbookSync>();
    /** The one log stream of every orderbook */
    readonly stream: LogStream = {
        open: false,
        fallback: false,
        polling: false,
        polledBlocks: new Map(),
        drops: 0,
        backfilled: 0,
        reorged: 0,
    };
    /** The subgraphs that did not answer the orderbooks query at init, their orderbooks are not synced */
    readonly failedSubgraphs: string[];
    /** Removes the block listener, undefined while not open */
    private stopBlocks?: () => void;

    private constructor(
        config: EventSyncManagerConfig,
        orderbooks: Map<Hex, string>,
        failedSubgraphs: string[],
    ) {
        this.state = config.state;
        this.orderManager = config.orderManager;
        this.subgraphManager = config.subgraphManager;
        this.filters = config.filters;
        this.resubscribeDelay = config.resubscribeDelay ?? LOGS_RESUBSCRIBE_DELAY;
        this.startTimeout =
            config.startTimeout ??
            Math.max(
                DEFAULT_START_TIMEOUT,
                START_TIMEOUT_BLOCKS * (Number(config.state.appOptions.blockTime) || 0),
            );
        this.startAttemptInterval = config.startAttemptInterval ?? START_ATTEMPT_INTERVAL;
        this.outOfSyncAfter = config.outOfSyncAfter ?? this.startTimeout;
        this.mode = config.state.appOptions.wsRpc ? "ws" : "http";
        this.failedSubgraphs = failedSubgraphs;
        for (const [orderbook, url] of orderbooks) {
            const version = config.subgraphManager.getSubgraphVersion(url);
            this.syncs.set(orderbook, {
                orderbook,
                url,
                version,
                syncer: syncerFor(config.orderManager, orderbook, version, config.filters, () =>
                    this.resolveSoon(orderbook),
                ),
                resolving: false,
                resolveAgain: false,
                tokenRetries: new Map(),
                vaultRetries: new Map(),
                reported: { failed: 0, badLogs: 0, givenUp: 0 },
            });
        }
    }

    /**
     * Builds the manager with a syncer per orderbook the subgraphs index, of any
     * version, narrowed by the orderbook filters, an orderbook two subgraphs
     * index is synced off the first one. A subgraph that does not answer, a
     * timeout at a deploy say, is asked again INIT_SUBGRAPH_RETRIES times, and
     * one that still does not answer is kept in failedSubgraphs. Nothing is
     * subscribed yet, see open
     * @param config - The manager config
     */
    static async init(config: EventSyncManagerConfig): Promise<EventSyncManager> {
        const { subgraphManager } = config;
        const answered = await subgraphManager.getOrderbooksByUrl();
        for (let i = 0; i < INIT_SUBGRAPH_RETRIES; i++) {
            const missing = subgraphManager.subgraphs.filter((url) => !answered.has(url));
            if (!missing.length) break;
            await sleep(config.subgraphRetryDelay ?? INIT_SUBGRAPH_RETRY_DELAY);
            for (const [url, addresses] of await subgraphManager.getOrderbooksByUrl(missing)) {
                answered.set(url, addresses);
            }
        }
        // the subgraphs in config order, so the first one that indexes an orderbook syncs it
        const byUrl = new Map<string, Set<string>>();
        for (const url of subgraphManager.subgraphs) {
            const addresses = answered.get(url);
            if (addresses) byUrl.set(url, addresses);
        }
        const orderbooks = new Map<Hex, string>();
        for (const [url, addresses] of byUrl) {
            for (const address of addresses) {
                const orderbook = address.toLowerCase() as Hex;
                if (orderbooks.has(orderbook)) continue;
                if (
                    config.filters?.includeOrderbooks &&
                    !config.filters.includeOrderbooks.has(orderbook)
                ) {
                    continue;
                }
                if (config.filters?.excludeOrderbooks?.has(orderbook)) continue;
                orderbooks.set(orderbook, url);
            }
        }
        const failed = subgraphManager.subgraphs.filter((url) => !byUrl.has(url));
        return new EventSyncManager(config, orderbooks, failed);
    }

    /** The orderbooks under sync */
    get orderbooks(): Hex[] {
        return [...this.syncs.keys()];
    }

    /**
     * Opens the one log subscription of all orderbooks in ws mode and hooks the
     * syncers to the block watcher, call before the block watcher starts. Does
     * nothing with no orderbook, an empty address list matches every log of
     * the chain. Throws in ws mode when the state has no ws client
     */
    open() {
        if (!this.syncs.size) return;
        if (this.mode === "ws") {
            const wsClient = this.state.getWsClient();
            if (!wsClient) throw new Error("the ws log sync needs a ws rpc");
            this.subscribe(wsClient);
        }
        this.stopBlocks = this.state.onBlockNumber((blockNumber) => {
            // the poll hands the heads to the syncers once their logs are in
            if (this.mode === "http" || this.stream.fallback) {
                // a new sealed head is a head the poll has not read yet
                this.stream.behindSince ??= Date.now();
                void this.poll();
                return;
            }
            const covered = this.coversHead();
            for (const sync of this.syncs.values()) {
                // a buffering syncer takes a head only when the stream covers
                // its block, the buffer start is set from the heads, a live one
                // takes every head
                if (sync.syncer.phase !== "buffering" || covered) this.onBlock(sync, blockNumber);
            }
            this.pruneBlocks(blockNumber);
        });
    }

    /**
     * Whether the log stream covers the head that the block watcher reports
     * now, ws mode only. The stream must be open and not stand behind the poll,
     * and a ws head must have come after the acknowledgement of the
     * subscription. The heads come over the same socket in order, so the node
     * sent that head after the logs subscription was in place. A head read over
     * http can be older than the acknowledgement, so it does not count
     */
    private coversHead(): boolean {
        const { stream } = this;
        return (
            stream.open &&
            !stream.fallback &&
            stream.openedWsBlock !== undefined &&
            this.state.wsBlockNumber > stream.openedWsBlock
        );
    }

    /**
     * Starts every syncer off its subgraph snapshot. Resolves once each syncer
     * is live or has given up, with the reports of the live ones and the errors
     * of the others, each error names the orderbook and the last error of the
     * log stream, also when none goes live. A syncer that gave up while it
     * still buffers tries its start again in the background, behind a subgraph
     * that lags say, and its orderbook goes live once it can
     */
    async start(): Promise<{ reports: Map<Hex, SnapshotReport>; failed: Map<Hex, string> }> {
        const reports = new Map<Hex, SnapshotReport>();
        const failed = new Map<Hex, string>();
        const now = Date.now();
        for (const sync of this.syncs.values()) {
            if (sync.syncer.phase !== "live") sync.notLiveSince = now;
        }
        await Promise.all(
            [...this.syncs.values()].map(async (sync) => {
                try {
                    reports.set(sync.orderbook, await this.startSync(sync));
                } catch (error) {
                    failed.set(sync.orderbook, this.describeStartError(sync, error));
                    this.retryStart(sync);
                }
            }),
        );
        return { reports, failed };
    }

    /** Starts one syncer off the snapshot of its subgraph */
    private startSync(sync: OrderbookSync): Promise<SnapshotReport> {
        return sync.syncer.start({
            getIndexedBlock: () => this.subgraphManager.getIndexedBlock(sync.url),
            fetchOrders: (block) =>
                this.subgraphManager.fetchSnapshotAt(sync.url, block, sync.orderbook),
            fetchLogs: async (fromBlock, toBlock) => {
                const logs: RawLog[] = [];
                await fetchOrderbookLogs(
                    this.state.client,
                    [sync.orderbook],
                    fromBlock,
                    toBlock,
                    (log) => logs.push(log),
                );
                return logs;
            },
            timeout: this.startTimeout,
            attemptInterval: this.startAttemptInterval,
        });
    }

    /** The error of a start that gave up, with the orderbook and the last error of the log stream */
    private describeStartError(sync: OrderbookSync, error: unknown): string {
        const last = describe(this.stream.lastError);
        return (
            `orderbook ${sync.orderbook}: ${describe(error)}` +
            (last ? `, last log source error: ${last}` : "")
        );
    }

    /**
     * Starts a syncer that gave up again after the resubscribe delay, until it
     * goes live or the sync closes. A syncer past its buffering phase cannot
     * start again, it is left as it is, the report shows its phase
     */
    private retryStart(sync: OrderbookSync) {
        if (sync.syncer.phase !== "buffering") return;
        sync.startRetryTimer = setTimeout(() => {
            sync.startRetryTimer = undefined;
            // the sync was closed meanwhile
            if (this.stopBlocks === undefined) return;
            this.startSync(sync).catch((error) => {
                sync.lastError = this.describeStartError(sync, error);
                this.retryStart(sync);
            });
        }, this.resubscribeDelay);
        // the wait must not keep the process alive on its own
        sync.startRetryTimer.unref?.();
    }

    /** Closes the subscription and the block hook, and clears the resubscribe and the start retry timers */
    close() {
        this.stopBlocks?.();
        this.stopBlocks = undefined;
        this.stream.unsubscribe?.();
        this.stream.unsubscribe = undefined;
        this.stream.open = false;
        if (this.stream.resubscribeTimer !== undefined) {
            clearTimeout(this.stream.resubscribeTimer);
            this.stream.resubscribeTimer = undefined;
        }
        for (const sync of this.syncs.values()) {
            if (sync.startRetryTimer === undefined) continue;
            clearTimeout(sync.startRetryTimer);
            sync.startRetryTimer = undefined;
        }
    }

    /**
     * The state of the stream and of every orderbook, for the round span. The
     * last errors, the new failures and the new bad logs are the ones since the
     * previous report, the report clears them. The stream is out of sync when
     * the poll reads the logs and it is behind the head for longer than
     * outOfSyncAfter, see LogStream.behindSince, or the block number polled
     * over http is not read for longer than that, an rpc that is down say. A
     * quiet chain with no new block is not out of sync. An orderbook is out of
     * sync when it is not live for longer than outOfSyncAfter since the start
     */
    report(): EventSyncReport {
        const { stream } = this;
        const now = Date.now();
        const streamError = describe(stream.lastError);
        stream.lastError = undefined;
        const polls = this.mode === "http" || stream.fallback;
        const behind =
            stream.behindSince !== undefined && now - stream.behindSince > this.outOfSyncAfter;
        // the http polling reads the block number on an interval, a ws head comes
        // only with a new block, so only the http reads stop when the rpc is down
        const { blockNumberReadAt, isPollingBlockNumber } = this.state;
        const headsStopped =
            !!isPollingBlockNumber &&
            blockNumberReadAt > 0 &&
            now - blockNumberReadAt > this.outOfSyncAfter;
        return {
            mode: this.mode,
            failedSubgraphs: this.failedSubgraphs,
            stream: {
                drops: stream.drops,
                backfilled: stream.backfilled,
                reorged: stream.reorged,
                outOfSync: polls && (behind || headsStopped),
                lastError: streamError,
            },
            orderbooks: [...this.syncs.values()].map((sync) => {
                if (sync.syncer.phase === "live") sync.notLiveSince = undefined;
                const needs = sync.syncer.needs();
                const lastError = describe(sync.lastError);
                sync.lastError = undefined;
                const stats = { ...sync.syncer.stats };
                const badLogs = sync.syncer.ingestor.badLogCount;
                const { reported } = sync;
                const newFailures = stats.failed - reported.failed;
                const newBadLogs = badLogs - reported.badLogs;
                const newGivenUp = stats.givenUp - reported.givenUp;
                sync.reported = { failed: stats.failed, badLogs, givenUp: stats.givenUp };
                return {
                    orderbook: sync.orderbook,
                    url: sync.url,
                    version: sync.version,
                    phase: sync.syncer.phase,
                    stats,
                    needs: { tokens: needs.tokens.length, vaults: needs.vaults.length },
                    buffered: sync.syncer.ingestor.bufferedCount,
                    badLogs,
                    newFailures,
                    newBadLogs,
                    newGivenUp,
                    outOfSync:
                        sync.notLiveSince !== undefined &&
                        now - sync.notLiveSince > this.outOfSyncAfter,
                    startError: describe(sync.syncer.startError),
                    lastError,
                };
            }),
        };
    }

    /** Hands a log to the syncer of its orderbook, a log of another address is dropped */
    private route(log: RawLog) {
        this.syncs.get(log.address.toLowerCase() as Hex)?.syncer.onLog(log);
    }

    /**
     * Hands a sealed block to a syncer, the logs up to it must be in already,
     * and reads what the syncer needs once the events of the block have applied
     * or parked. Not while the snapshot replays, the replay applies outside the
     * queue and a retry of a parked add would run beside it, the first live
     * block reads them
     * @param sync - The orderbook sync
     * @param blockNumber - The sealed block
     */
    private onBlock(sync: OrderbookSync, blockNumber: bigint) {
        sync.syncer.onBlock(blockNumber);
        this.resolveSoon(sync.orderbook);
    }

    /**
     * Reads what a live syncer needs once the events handed in so far have
     * applied or parked. A new block calls it, so a read that failed is tried
     * again, and a new park calls it, so a new order is read at once, see
     * OrderbookSyncerConfig.onPark. The look for the needs only reads the
     * vaults with no balance yet, so it costs nothing when there are none
     */
    private resolveSoon(orderbook: Hex) {
        const sync = this.syncs.get(orderbook);
        if (!sync || sync.syncer.phase !== "live") return;
        void sync.syncer
            .settled()
            .then(() => this.resolveNeeds(sync))
            .catch(() => {});
    }

    /** Opens the one subscription of all orderbooks, and opens it again after a drop */
    private subscribe(wsClient: PublicClient) {
        const { stream } = this;
        const onLog = (log: RawLog) => {
            stream.lastLogBlock =
                stream.lastLogBlock === undefined || log.blockNumber > stream.lastLogBlock
                    ? log.blockNumber
                    : stream.lastLogBlock;
            // a pending log of a flashblock carries a zero block hash, a later read
            // cannot compare it, so only the logs of sealed blocks are kept
            if (!this.state.appOptions.flashblocks) this.recordStreamLog(log);
            this.route(log);
        };
        const onError = (error: unknown) => {
            stream.lastError = error;
            stream.drops++;
            stream.unsubscribe?.();
            stream.unsubscribe = undefined;
            stream.open = false;
            // the poll stands in for the stream and the syncers stay live, it
            // reads from the latest proof that the socket was alive, and its
            // first read also reads the blocks below that again. A poll that
            // stands in already, a drop during the handover say, goes on
            if (!stream.fallback) {
                stream.fallback = true;
                // the blocks since the last proof of the socket wait for the poll
                stream.behindSince = Date.now();
                const from = this.backfillStart();
                stream.pollFrom = from;
                stream.pollStart =
                    from === undefined
                        ? undefined
                        : from > POLL_REREAD_BLOCKS
                          ? from - POLL_REREAD_BLOCKS
                          : 0n;
                // the blocks since then are read now, a quiet chain gives no head to wait for
                this.pollSoon();
            }
            if (stream.resubscribeTimer !== undefined) return;
            stream.resubscribeTimer = setTimeout(() => {
                stream.resubscribeTimer = undefined;
                this.subscribe(wsClient);
            }, this.resubscribeDelay);
            // the wait must not keep the process alive on its own
            stream.resubscribeTimer.unref?.();
        };
        const onOpen = () => {
            stream.open = true;
            stream.openedAt = this.state.canonicalBlockNumber;
            stream.openedWsBlock = this.state.wsBlockNumber;
            // the stream takes over once the poll has read past the block it
            // opened at, its logs are newer than the blocks the poll has not
            // read yet, so they wait in the buffers until then, see poll
            if (stream.fallback) {
                stream.handoverAt = stream.openedAt + BACKFILL_HEAD_MARGIN;
                for (const sync of this.syncs.values()) sync.syncer.holdLive();
            }
        };
        stream.open = false;
        // the subscription takes the socket this opens, in the same tick, a
        // closed socket is dropped first, see SharedState.openWsSocket, or it
        // waits for a socket that is opening and then subscribes
        const opening = this.state.openWsSocket();
        if (opening) {
            // a close while it waits cancels the wait, as it would unsubscribe
            let waiting = true;
            stream.unsubscribe = () => (waiting = false);
            void opening.then(() => {
                if (waiting) this.subscribe(wsClient);
            });
            return;
        }
        stream.unsubscribe = subscribeToOrderbookLogs(
            wsClient,
            this.orderbooks,
            onLog,
            onError,
            this.state.appOptions.flashblocks,
            onOpen,
        );
    }

    /**
     * Where the poll starts after a drop, the latest proof that the socket was
     * alive. The block watcher runs over the same socket, so the last sealed
     * head it served proves every log below it, less a margin, was delivered,
     * a silent death stops both streams together. The block of the last log
     * is the other proof, it can sit above the head with flashblocks, and it
     * is included since the rest of its logs may have been lost, the poll waits
     * until that block seals. Without any proof the poll starts at the newest block a
     * syncer saw, or at the sealed head when none saw one
     */
    private backfillStart(): bigint | undefined {
        const head = this.state.wsBlockNumber;
        const fromHead = head > BACKFILL_LOOKBACK ? head - BACKFILL_LOOKBACK : undefined;
        const fromLog = this.stream.lastLogBlock;
        if (fromHead === undefined) return fromLog ?? this.newestBlock();
        if (fromLog === undefined) return fromHead;
        return fromLog > fromHead ? fromLog : fromHead;
    }

    /** The newest block any syncer saw, undefined when none saw one */
    private newestBlock(): bigint | undefined {
        let newest: bigint | undefined;
        for (const sync of this.syncs.values()) {
            const block = sync.syncer.newestBlock;
            if (block !== undefined && (newest === undefined || block > newest)) newest = block;
        }
        return newest;
    }

    /**
     * Keeps a log of a sealed block the ws stream delivered, with its block, so
     * the first poll after a drop finds a block that a reorg replaced while the
     * socket was down, see findRemoved. A log of another hash at the same height
     * starts the record of that block anew. A removed log leaves the record of
     * its own block hash only, and a block with no log left leaves the record
     */
    private recordStreamLog(log: RawLog) {
        const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
        const hash = log.blockHash?.toLowerCase() as Hex | undefined;
        let block = this.stream.polledBlocks.get(log.blockNumber);
        if (log.removed) {
            // a removal of the old block leaves the record of the new one alone,
            // the same log mined again at the same height can come before it
            if (!block || (hash && block.hash && block.hash !== hash)) return;
            block.logs.delete(key);
            if (!block.logs.size) this.stream.polledBlocks.delete(log.blockNumber);
            return;
        }
        if (!block || (hash && block.hash && block.hash !== hash)) {
            block = { hash, logs: new Map() };
            this.stream.polledBlocks.set(log.blockNumber, block);
        }
        block.logs.set(key, log);
    }

    /**
     * Forgets the logs of the blocks below the ones a poll reads again. In ws
     * mode it keeps the blocks a poll after a drop can read again too, the
     * poll starts up to BACKFILL_LOOKBACK blocks below the last ws head
     * @param head - The sealed head
     */
    private pruneBlocks(head: bigint) {
        const keep =
            this.mode === "ws" ? BACKFILL_LOOKBACK + POLL_REREAD_BLOCKS : POLL_REREAD_BLOCKS;
        for (const blockNumber of this.stream.polledBlocks.keys()) {
            if (blockNumber + keep < head) this.stream.polledBlocks.delete(blockNumber);
        }
    }

    /**
     * Reads the logs of all orderbooks from the next block up to the sealed
     * head with one range query, in http mode, and in ws mode while it stands
     * in for the subscription. The first poll reads the sealed head only, so the
     * coverage of the syncers starts there. Each poll also reads the last
     * POLL_REREAD_BLOCKS blocks again. A log that the poll read before, or that
     * the ws stream delivered, and that is not on the chain anymore goes to its
     * syncer as removed, see findRemoved, and the syncer drops the logs it saw
     * before. The sealed head goes to the syncers only after its logs are in.
     * Once the poll has read past the block a reopened subscription started at,
     * the syncers apply the stream logs that waited, and the stream takes over.
     * A poll that fails is tried again on the next block, from the same block.
     * A poll that ends behind a head that came during its read polls again at
     * once. One poll runs at a time
     */
    private async poll() {
        const { stream } = this;
        const head = this.state.canonicalBlockNumber;
        const from = stream.pollFrom ?? head;
        if (stream.polling || head < from) return;
        const start = stream.pollStart ?? from;
        const rereadFrom = from - POLL_REREAD_BLOCKS > start ? from - POLL_REREAD_BLOCKS : start;
        // a slow read can end behind a newer head, the poll was caught up only
        // to the head as it was when the read started
        const startedAt = Date.now();
        stream.polling = true;
        let succeeded = false;
        try {
            // the logs go to the syncers only once the whole range is read, a
            // poll that fails half way hands over nothing
            const logs: RawLog[] = [];
            await fetchOrderbookLogs(this.state.client, this.orderbooks, rereadFrom, head, (log) =>
                logs.push(log),
            );
            const read = groupByBlock(logs);
            const removed = await this.findRemoved(rereadFrom, head + 1n, read);
            stream.reorged += removed.length;
            for (const log of removed) this.route(log);
            for (const log of logs) this.route(log);
            if (this.mode === "ws") {
                stream.backfilled += logs.filter((log) => log.blockNumber >= from).length;
            }
            for (const [blockNumber, block] of read) stream.polledBlocks.set(blockNumber, block);
            this.pruneBlocks(head);
            stream.pollStart = start;
            stream.pollFrom = head + 1n;
            stream.behindSince = this.state.canonicalBlockNumber > head ? startedAt : undefined;
            for (const sync of this.syncs.values()) this.onBlock(sync, head);
            if (stream.handoverAt !== undefined && head >= stream.handoverAt) {
                stream.handoverAt = undefined;
                for (const sync of this.syncs.values()) sync.syncer.resumeLive();
                // a subscription that dropped again during the handover leaves the poll on
                if (stream.open) stream.fallback = false;
            }
            succeeded = true;
        } catch (error) {
            stream.lastError = error;
        } finally {
            stream.polling = false;
        }
        // a head that came during the read does not wait for the next block, a
        // quiet chain would leave it unread, a failed read waits for it though
        if (succeeded && this.state.canonicalBlockNumber > head) this.pollSoon();
    }

    /**
     * Polls now, when the poll reads the logs, the sync is open and a head is
     * known, a poll before the first head would read from the first block of
     * the chain
     */
    private pollSoon() {
        if (this.stopBlocks === undefined || this.state.canonicalBlockNumber <= 0n) return;
        if (this.mode === "http" || this.stream.fallback) void this.poll();
    }

    /**
     * Finds the logs that a reorg removed from the blocks that a poll read,
     * the blocks from the given first block up to, and not including, the
     * given end block, against the logs a poll read before or the ws stream
     * delivered for them. Such a block is replaced when the new read gives it
     * another block hash. When the new read gives no logs for the block, the
     * block hash is read from the chain, and a block that cannot be read is
     * left for the next poll. All the logs of a replaced block are removed.
     * They are returned as removed logs, newest first, so the syncers undo them
     * in reverse chain order
     * @param fromBlock - The first block that the poll read
     * @param endBlock - The block after the last block that the poll read
     * @param read - The logs that the poll read, by block number
     */
    private async findRemoved(
        fromBlock: bigint,
        endBlock: bigint,
        read: Map<bigint, PolledBlock>,
    ): Promise<RawLog[]> {
        const removed: RawLog[] = [];
        for (const [blockNumber, before] of this.stream.polledBlocks) {
            if (blockNumber < fromBlock || blockNumber >= endBlock) continue;
            const now = read.get(blockNumber);
            let hash = now?.hash;
            if (!now) {
                if (!before.hash) continue;
                hash = await this.state.client
                    .getBlock({ blockNumber })
                    .then((block) => block.hash?.toLowerCase() as Hex | undefined)
                    .catch(() => undefined);
                if (!hash) continue;
            }
            if (before.hash && hash && before.hash === hash) continue;
            // a block with another hash is another block, so every log of the old
            // block is removed, a log of the same transaction and index can carry
            // other data in the new block, and the syncer applies the logs of the
            // new block again. Without both hashes, only the logs that the new read
            // does not give are removed
            const replaced = !!before.hash && !!hash;
            for (const [key, log] of before.logs) {
                if (replaced || !now?.logs.has(key)) removed.push({ ...log, removed: true });
            }
            if (!now) this.stream.polledBlocks.delete(blockNumber);
        }
        return removed.sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
            return b.logIndex - a.logIndex;
        });
    }

    /**
     * Answers what a syncer needs with reads, the tokens from the state's cache
     * or from the token contracts, the vault balances from the orderbook in one
     * multicall, viem splits it up as needed, at the sealed head as it is when
     * the reads start, not as it was when the resolution was scheduled, so an
     * event parked since then is read at or above its block, one resolution
     * runs at a time per orderbook. A v4 orderbook serves a vault balance in
     * token units, a v5 or v6 one as a rain float. A read that fails more than
     * READ_MAX_RETRIES times gives up, and the syncer drops the orders that
     * need it, see OrderbookSyncer.giveUp
     */
    private async resolveNeeds(sync: OrderbookSync) {
        if (sync.resolving) {
            sync.resolveAgain = true;
            return;
        }
        const { syncer } = sync;
        // the vaults tracked above the sealed head wait for a read that holds their block
        const blockNumber = this.state.canonicalBlockNumber;
        const needs = syncer.needs(blockNumber);
        // a read that is not needed anymore forgets its failures, a later need starts anew
        const vaultKeys = new Set(needs.vaults.map((vault) => VaultLedger.key(vault)));
        for (const address of sync.tokenRetries.keys()) {
            if (!needs.tokens.includes(address)) sync.tokenRetries.delete(address);
        }
        for (const key of sync.vaultRetries.keys()) {
            if (!vaultKeys.has(key)) sync.vaultRetries.delete(key);
        }
        if (!needs.tokens.length && !needs.vaults.length) return;
        sync.resolving = true;
        try {
            for (const address of needs.tokens) {
                // a token that keeps failing, one with no decimals say, is tried
                // less often, so it does not cost reads on every block
                if (!isDue(sync.tokenRetries.get(address), blockNumber)) continue;
                const token = await this.readToken(address);
                if (token.isOk()) {
                    sync.tokenRetries.delete(address);
                    syncer.resolveToken(token.value);
                    continue;
                }
                sync.lastError = token.error;
                noteFailure(sync.tokenRetries, address, blockNumber);
            }
            // a vault is read once its token is known, a rain float balance
            // needs the decimals to become units
            const vaults = needs.vaults.filter(
                (vault) =>
                    syncer.ledger.tokens.has(vault.token) &&
                    isDue(sync.vaultRetries.get(VaultLedger.key(vault)), blockNumber),
            );
            if (vaults.length) await this.readVaults(sync, vaults, blockNumber);
            syncer.giveUp(
                needs.tokens.filter((address) => gaveUp(sync.tokenRetries.get(address))),
                needs.vaults.filter((vault) =>
                    gaveUp(sync.vaultRetries.get(VaultLedger.key(vault))),
                ),
            );
        } finally {
            sync.resolving = false;
            // a call that came while this one ran reads its needs now
            if (sync.resolveAgain) {
                sync.resolveAgain = false;
                this.resolveSoon(sync.orderbook);
            }
        }
    }

    /**
     * Reads the balances of the given vaults of a syncer at the block in one
     * multicall, viem splits it up as needed, and hands them in. One vault that
     * fails to read is left for a later block, the rest go through. Each
     * failure counts toward READ_MAX_RETRIES, a batch that fails as a whole
     * counts for every vault of it. Each failure is kept for the report, so a
     * chain with no multicall or a provider that keeps refusing shows why the
     * needs stay
     */
    private async readVaults(sync: OrderbookSync, vaults: VaultRef[], blockNumber: bigint) {
        const { syncer } = sync;
        const v4 = syncer.orderType === Order.Type.V3;
        const multicallAddress = this.state.client.chain?.contracts?.multicall3?.address as Hex;
        const results = await (
            v4
                ? this.state.client.multicall({
                      multicallAddress,
                      allowFailure: true,
                      blockNumber,
                      contracts: vaults.map((vault) => ({
                          address: vault.orderbook,
                          abi: VAULT_BALANCE_V4_ABI,
                          functionName: "vaultBalance" as const,
                          args: [vault.owner, vault.token, vault.vaultId] as const,
                      })),
                  })
                : this.state.client.multicall({
                      multicallAddress,
                      allowFailure: true,
                      blockNumber,
                      contracts: vaults.map((vault) => ({
                          address: vault.orderbook,
                          abi: VAULT_BALANCE_ABI,
                          functionName: "vaultBalance2" as const,
                          args: [vault.owner, vault.token, toVaultId(vault.vaultId)] as const,
                      })),
                  })
        ).catch((error) => {
            sync.lastError = error;
            return undefined;
        });
        if (!results) {
            for (const vault of vaults) {
                noteFailure(sync.vaultRetries, VaultLedger.key(vault), blockNumber);
            }
            return;
        }
        vaults.forEach((vault, i) => {
            const key = VaultLedger.key(vault);
            const result = results[i];
            if (result?.status !== "success") {
                sync.lastError = result?.error ?? new Error("no result for a vault read");
                noteFailure(sync.vaultRetries, key, blockNumber);
                return;
            }
            // the balance in token units on a v4 orderbook
            if (typeof result.result === "bigint") {
                sync.vaultRetries.delete(key);
                syncer.resolveVaultBalance(vault, result.result, blockNumber);
                return;
            }
            // the balance as a rain float, a bytes32 hex, on a v5 or v6 one
            if (typeof result.result !== "string") return;
            const token = syncer.ledger.tokens.get(vault.token)!;
            const units = normalizeFloat(result.result, token.decimals);
            if (units.isErr()) {
                // a float that does not fit the token is a failure of the vault
                sync.lastError = units.error;
                noteFailure(sync.vaultRetries, key, blockNumber);
                return;
            }
            sync.vaultRetries.delete(key);
            syncer.resolveVaultBalance(vault, units.value, blockNumber);
        });
    }

    /** The details of a token, from the state's cache or from the token contract, cached once read */
    private async readToken(address: Hex): Promise<Result<TokenDetails, unknown>> {
        const cached = this.state.watchedTokens.get(address.toLowerCase());
        if (cached) return Result.ok(cached);
        try {
            const [decimals, symbol] = await Promise.all([
                this.state.client.readContract({
                    address,
                    abi: erc20Abi,
                    functionName: "decimals",
                }),
                this.state.client
                    .readContract({ address, abi: erc20Abi, functionName: "symbol" })
                    .catch(() => "UnknownSymbol"),
            ]);
            const token: TokenDetails = { address: address.toLowerCase(), decimals, symbol };
            this.state.watchToken(token);
            return Result.ok(token);
        } catch (error) {
            return Result.err(error);
        }
    }
}

/** Whether a read with the given retry record may run at the block, see READ_MAX_RETRIES */
function isDue(retry: ReadRetry | undefined, blockNumber: bigint): boolean {
    return !retry || (!gaveUp(retry) && retry.retryAt <= blockNumber);
}

/** Whether a read with the given retry record gave up, see READ_MAX_RETRIES */
function gaveUp(retry: ReadRetry | undefined): boolean {
    return retry !== undefined && retry.failures > READ_MAX_RETRIES;
}

/** Counts a failure of a read, the wait before the next try doubles with each one */
function noteFailure<K>(retries: Map<K, ReadRetry>, key: K, blockNumber: bigint) {
    const failures = (retries.get(key)?.failures ?? 0) + 1;
    retries.set(key, { failures, retryAt: blockNumber + (1n << BigInt(failures)) });
}

/** Groups the logs that a poll read by block, with the block hash of each block */
function groupByBlock(logs: RawLog[]): Map<bigint, PolledBlock> {
    const blocks = new Map<bigint, PolledBlock>();
    for (const log of logs) {
        let block = blocks.get(log.blockNumber);
        if (!block) {
            block = { hash: log.blockHash?.toLowerCase() as Hex | undefined, logs: new Map() };
            blocks.set(log.blockNumber, block);
        }
        block.logs.set(`${log.transactionHash.toLowerCase()}:${log.logIndex}`, log);
    }
    return blocks;
}

/** A short text of an error for a span, undefined for none */
function describe(error: unknown): string | undefined {
    if (error === undefined || error === null) return undefined;
    return error instanceof Error ? error.message : String(error);
}
