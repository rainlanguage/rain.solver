import { Order } from "../order";
import { readable, VaultKey, VaultLedger } from "./ledger";
import { applyFilters, SgFilter } from "../subgraph/filter";
import { SgOrder, SubgraphVersions } from "../subgraph/types";
import { LOGS_RANGE_CHUNK } from "./stream";
import { IngestedEvent, LogIngestor } from "./ingestor";
import { normalizeFloat, Result, toFloat, TokenDetails } from "../common";
import {
    Hex,
    RawLog,
    VaultRef,
    MetaEvent,
    VaultEvent,
    AddOrderEvent,
    RemoveOrderEvent,
    OrderbookEvent,
} from "./types";

/**
 * Where the synced state goes, the order manager fits it as it is, the shape
 * is the one it takes from the subgraph so nothing downstream changes
 */
export type EventSink = {
    addOrder(order: SgOrder): Promise<Result<void, unknown>> | Result<void, unknown>;
    removeOrder(order: SgOrder): Promise<void> | void;
    /** Gives an added order the meta that came after its add */
    updateMeta(orderbook: Hex, owner: Hex, orderHash: Hex, meta: Hex): Promise<void> | void;
};

export type OrderbookSyncerConfig = {
    /** The orderbook the logs and the snapshot belong to */
    orderbook: Hex;
    /** Where the synced orders go */
    sink: EventSink;
    /**
     * The ledger the vault balances live in, the order manager's own so the
     * round reads what the logs wrote with no copy in between, a fresh one
     * when none is given
     */
    ledger?: VaultLedger;
    /** The order filters, the same the subgraph fetch applies */
    filters?: SgFilter;
    /**
     * The version of the subgraph that indexes the orderbook, the order manager
     * tells a v5 orderbook order from a v6 one by it, default is v6
     */
    version?: SubgraphVersions;
    /**
     * Called when an event parks for the first time, so the client layer can
     * read what the syncer needs at once, not on the next block. A throw of it
     * does not stop the sync
     */
    onPark?: () => void;
};

/** An order the syncer knows, from the snapshot or from an add */
export type KnownOrder = {
    orderHash: Hex;
    order: Order;
    orderBytes: Hex;
    meta?: Hex;
    active: boolean;
    /** The block the order was removed at, when it is not active */
    removedAt?: bigint;
};

/** What a snapshot application did */
export type SnapshotReport = {
    snapshotBlock: bigint;
    ordersAdded: number;
    ordersFailed: Record<string, string>;
    eventsReplayed: number;
    eventsParked: number;
};

/**
 * Where the snapshot and the logs below the buffer come from, injected by the
 * client layer so the syncer holds no subgraph client and no rpc client
 */
export type SnapshotSource = {
    /** The block the subgraph has indexed up to */
    getIndexedBlock: () => Promise<bigint | number>;
    /** The active orders of the orderbook pinned at the given block */
    fetchOrders: (block: bigint) => Promise<SgOrder[]>;
    /**
     * The logs of the orderbook from the first block to the last block, both
     * included, in chain order. The start reads the gap between the snapshot
     * block and the buffer with it
     */
    fetchLogs: (fromBlock: bigint, toBlock: bigint) => Promise<RawLog[]>;
};

/** How the syncer starts itself, see OrderbookSyncer.start */
export type StartConfig = SnapshotSource & {
    /** How many blocks past the start block to have seen before the snapshot is fetched, default is 6 */
    bufferBlocks?: number;
    /** How many blocks past the start block the buffer covers for sure, at least 1, default is 3 */
    snapshotOffset?: number;
    /** The most blocks of the gap that the start reads with logs, default is DEFAULT_MAX_GAP_BLOCKS */
    maxGapBlocks?: bigint;
    /** How long (in ms) the start may take before it gives up, default is DEFAULT_START_TIMEOUT */
    timeout?: number;
    /**
     * The least time (in ms) between two attempts of the start, an attempt
     * reads the subgraph and the rpc, so a subgraph that lags or is down is
     * not read on every block of a fast chain, default is 0
     */
    attemptInterval?: number;
};

/** The blocks to have seen past the start block before the snapshot is fetched */
export const DEFAULT_BUFFER_BLOCKS = 6;
/** The blocks past the start block that the buffer covers for sure */
export const DEFAULT_SNAPSHOT_OFFSET = 3;
/**
 * The most blocks of the gap between the snapshot block and the buffer that
 * the start reads with logs, 10 range queries of LOGS_RANGE_CHUNK blocks. The
 * cap is the cost of the read, so a subgraph that lags tens of minutes is
 * bridged on any chain. A subgraph that is further behind is not used until it
 * comes nearer, so a stuck subgraph does not cause a very large log read
 */
export const DEFAULT_MAX_GAP_BLOCKS = 10n * LOGS_RANGE_CHUNK;
/**
 * How long (in ms) a start may take before it gives up, well past the buffer
 * blocks of a slow chain plus the read of a gap. A fetch that keeps failing is
 * a failed start, not a wait
 */
export const DEFAULT_START_TIMEOUT = 2 * 60_000;

/** What the client layer still has to read for the state to be complete */
export type SyncNeeds = {
    /** Token addresses with no details yet */
    tokens: Hex[];
    /** Vaults with no balance baseline yet */
    vaults: VaultRef[];
};

/**
 * Keeps the state of one orderbook in step with the chain from its logs, after
 * a start from a subgraph snapshot. The logs go in from the moment the client
 * layer opens the subscription, before the snapshot is fetched, so no event
 * falls between the two. The snapshot is applied as the state at its block,
 * then the buffered events above that block are replayed in chain order, and
 * from then on every event applies as it comes. The subgraph is not needed
 * again. The client layer feeds logs through onLog and blocks through onBlock
 * and calls start, which picks the snapshot block, reads the gap between it
 * and the buffer when there is one, and does the rest, see start.
 *
 * Logs report changes, not balances, so a vault balance is a baseline plus the
 * changes since, see VaultLedger. An event that needs a token or a vault
 * baseline the state does not have yet is parked, and the client layer reads
 * what needs() lists and hands it in through resolveToken and
 * resolveVaultBalance, which retries the parked events.
 *
 * A log the chain removes in a reorg applies in reverse, an add becomes a
 * removal, a removal an add, and a vault change flips its sign.
 */
export class OrderbookSyncer {
    readonly orderbook: Hex;
    readonly ledger: VaultLedger;
    readonly ingestor: LogIngestor;
    readonly sink: EventSink;
    readonly filters?: SgFilter;
    /** The version of the subgraph that indexes the orderbook, see OrderbookSyncerConfig */
    readonly version: SubgraphVersions;
    /** Called when an event parks for the first time, see OrderbookSyncerConfig */
    readonly onPark?: () => void;
    /**
     * The struct type of the orders of the orderbook, known from the first
     * order the syncer sees. A v4 orderbook has v3 orders, its vault balances
     * are read with another call, see EventSyncManager
     */
    orderType?: Order.Type;
    /** Buffering until the snapshot is in, replaying the buffer, then live */
    phase: "buffering" | "replaying" | "live" = "buffering";
    /** The block the snapshot held at */
    snapshotBlock?: bigint;
    /** The orders known, by hash, active or removed within the last INACTIVE_ORDER_BLOCKS blocks */
    readonly orders = new Map<Hex, KnownOrder>();
    /**
     * How many blocks a removed order is kept for, so a reorg of its removal
     * can add it again with its meta, as deep as the seen logs, see
     * LogIngestor.SEEN_BLOCKS
     */
    static readonly INACTIVE_ORDER_BLOCKS = 24n;
    /** Events waiting for a token or a vault baseline, in the order they came */
    private parked: IngestedEvent[] = [];
    /** Every event that was ever parked, so a retry that parks again does not count twice */
    private readonly everParked = new WeakSet<IngestedEvent>();
    /** Live events apply one after the other, an async add never overtakes the next event */
    private queue: Promise<void> = Promise.resolve();
    /** A retry of the parked events is queued and has not started yet, see scheduleRetry */
    private retryQueued = false;
    /** The client layer reads the blocks below a reopened stream, the events wait in the buffer, see holdLive */
    private holding = false;
    /** Counters of what happened since the start, see stats */
    private readonly counts = {
        applied: 0,
        reverted: 0,
        parked: 0,
        dropped: 0,
        givenUp: 0,
        failed: 0,
    };

    /**
     * Counters of what happened since the start, applied, reverted, parked,
     * dropped (a parked add its removal came before it applied), givenUp (a
     * parked add or an active order dropped as a read it needs gave up, see
     * giveUp), failed (the sink refused or threw) and filtered (an add or a
     * removal the filters left out at the ingestor, before anything was spent
     * on it)
     */
    get stats() {
        return { ...this.counts, filtered: this.ingestor.filtered };
    }
    /**
     * The lowest block seen, from a log or from the block watcher, the stream
     * may have opened in the middle of it, so the buffer holds every log from
     * the block after it on
     */
    firstBlock?: bigint;
    /** The highest block seen, from a log or from the block watcher */
    newestBlock?: bigint;
    /** The start in progress, see start */
    private starter?: {
        config: Required<StartConfig>;
        resolve: (report: SnapshotReport) => void;
        reject: (error: unknown) => void;
        attempting: boolean;
        /** When (in ms) the last attempt began, see StartConfig.attemptInterval */
        lastAttemptAt?: number;
        /** Why the last attempt did not go through, for the report */
        lastError?: unknown;
    };

    constructor(config: OrderbookSyncerConfig) {
        this.orderbook = config.orderbook.toLowerCase() as Hex;
        this.sink = config.sink;
        this.ledger = config.ledger ?? new VaultLedger();
        this.filters = config.filters;
        this.version = config.version ?? SubgraphVersions.V6;
        this.onPark = config.onPark;
        this.ingestor = new LogIngestor(
            this.orderbook,
            (ingested) => this.enqueue(ingested),
            this.filters,
        );
    }

    /**
     * Takes a raw log from the client layer, any time from the start on
     * @param log - The raw log
     */
    onLog(log: RawLog) {
        // a removed log can be of a block below the start of the stream, a reorg
        // deeper than the buffer say, so it does not move the buffer start
        if (!log.removed) this.noteBlock(log.blockNumber);
        this.ingestor.push(log);
    }

    /**
     * Takes a block number from the client layer's block watcher, the watcher
     * starts after the log stream so the first block it reports is never below
     * the coverage of the buffer. Each block is a chance for a pending start to
     * go through
     */
    onBlock(blockNumber: bigint) {
        this.noteBlock(blockNumber);
        this.pruneOrders(blockNumber);
        void this.tryStart();
        // a parked event whose token or baseline came in through another
        // syncer of the shared ledger gets its turn here, the resolve that
        // brought it retried that syncer's parked events only
        if (this.phase === "live" && this.parked.length) this.scheduleRetry();
    }

    /**
     * Forgets the orders removed long enough ago, they are kept only so a
     * removal the chain reorgs away can re-add them with their meta, which a
     * reorg never needs past this depth
     */
    private pruneOrders(blockNumber: bigint) {
        const floor = blockNumber - OrderbookSyncer.INACTIVE_ORDER_BLOCKS;
        for (const [orderHash, known] of this.orders) {
            if (!known.active && known.removedAt !== undefined && known.removedAt < floor) {
                this.orders.delete(orderHash);
            }
        }
    }

    /**
     * Starts the sync by itself. The syncer waits until it has seen the
     * configured number of blocks past the start block, the lowest block a log
     * or the block watcher reported. The buffer covers for sure the blocks from
     * the start block plus the offset, since the stream may have opened in the
     * middle of the start block. The snapshot is pinned at the block that the
     * subgraph has indexed, and never above that covered block. When the
     * snapshot block is below the covered block, the logs of the gap are read
     * into the buffer, so the start does not wait for a subgraph that lags.
     * Then the snapshot is fetched and applied, and the syncer goes live.
     * Resolves with the snapshot report once the syncer is live. Blocks come in
     * through onBlock.
     * @param config - The snapshot source and the block margins
     */
    start(config: StartConfig): Promise<SnapshotReport> {
        if (this.starter || this.phase !== "buffering") {
            return Promise.reject(new Error("the syncer is started already"));
        }
        const offset = config.snapshotOffset ?? DEFAULT_SNAPSHOT_OFFSET;
        const bufferBlocks = config.bufferBlocks ?? DEFAULT_BUFFER_BLOCKS;
        if (offset < 1 || bufferBlocks < offset) {
            return Promise.reject(
                new Error("the snapshot offset must be at least 1 and at most the buffer blocks"),
            );
        }
        const maxGapBlocks = config.maxGapBlocks ?? DEFAULT_MAX_GAP_BLOCKS;
        const timeout = config.timeout ?? DEFAULT_START_TIMEOUT;
        return new Promise((resolve, reject) => {
            // the start gives up at the deadline with the reason it waited for,
            // an attempt still in flight then finds the starter gone and stops.
            // Once the snapshot apply runs, the start ends with its outcome
            const timer = setTimeout(() => {
                if (this.starter !== starter || this.phase !== "buffering") return;
                this.starter = undefined;
                this.resetBuffer();
                const last = starter.lastError;
                const reason = last
                    ? `, ${last instanceof Error ? last.message : String(last)}`
                    : "";
                reject(new Error(`the log sync did not go live within ${timeout}ms${reason}`));
            }, timeout);
            // the deadline must not keep the process alive on its own
            timer.unref?.();
            const starter: NonNullable<OrderbookSyncer["starter"]> = {
                config: {
                    ...config,
                    snapshotOffset: offset,
                    bufferBlocks,
                    maxGapBlocks,
                    timeout,
                    attemptInterval: config.attemptInterval ?? 0,
                },
                resolve: (report) => {
                    clearTimeout(timer);
                    resolve(report);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
                attempting: false,
            };
            this.starter = starter;
            void this.tryStart();
        });
    }

    /** Why the last start attempt did not go through, undefined when it did or none was made */
    get startError(): unknown {
        return this.starter?.lastError;
    }

    /**
     * Forgets the buffer of a start that gave up, so the next start buffers
     * from the stream as it is then. A buffer kept from an old start pins the
     * snapshot at an old block, which a subgraph that prunes its history
     * cannot serve, and it grows for as long as the start waits. While the
     * stream takes over from the poll the buffer stays, the handover needs it whole
     */
    private resetBuffer() {
        if (this.holding) return;
        this.firstBlock = undefined;
        this.newestBlock = undefined;
        this.ingestor.reset();
    }

    /** Keeps the lowest and highest block seen */
    private noteBlock(blockNumber: bigint) {
        if (this.firstBlock === undefined || blockNumber < this.firstBlock) {
            this.firstBlock = blockNumber;
        }
        if (this.newestBlock === undefined || blockNumber > this.newestBlock) {
            this.newestBlock = blockNumber;
        }
    }

    /**
     * Fetches and applies the snapshot once the buffer has enough blocks, pinned
     * where the subgraph is, after the logs of the gap below the buffer are read
     */
    private async tryStart(): Promise<void> {
        const starter = this.starter;
        if (!starter || starter.attempting || this.phase !== "buffering") return;
        if (this.firstBlock === undefined || this.newestBlock === undefined) return;
        const { config } = starter;
        if (this.newestBlock - this.firstBlock < BigInt(config.bufferBlocks)) return;
        const covered = this.firstBlock + BigInt(config.snapshotOffset);

        if (
            starter.lastAttemptAt !== undefined &&
            Date.now() - starter.lastAttemptAt < config.attemptInterval
        ) {
            return;
        }
        starter.lastAttemptAt = Date.now();
        starter.attempting = true;
        try {
            const indexed = BigInt(await config.getIndexedBlock());
            // the start gave up while the read was out
            if (this.starter !== starter) return;
            const block = indexed < covered ? indexed : covered;
            if (block < covered) {
                const gap = covered - block;
                if (gap > config.maxGapBlocks) {
                    starter.lastError = new Error(
                        `the subgraph is at block ${indexed}, ${gap} blocks behind the buffer, more than ${config.maxGapBlocks}`,
                    );
                    return;
                }
                // the gap and some blocks of overlap go in the buffer, the
                // ingestor drops the logs it has already, the stream logs keep
                // going in the buffer while the read is out
                const logs = await config.fetchLogs(block + 1n, covered);
                if (this.starter !== starter) return;
                for (const log of logs) this.ingestor.push(log);
            }
            const orders = await config.fetchOrders(block);
            if (this.starter !== starter) return;
            const report = await this.applySnapshot(orders, block);
            starter.lastError = undefined;
            starter.resolve(report);
        } catch (error) {
            starter.lastError = error;
            // a failed apply cannot be retried, the buffer is drained, a failed
            // fetch or head read waits for the next block
            if (this.phase !== "buffering") starter.reject(error);
        } finally {
            starter.attempting = false;
        }
    }

    /**
     * Keeps the events in the buffer from now on, while the client layer reads
     * the blocks below the start of a reopened stream. Those logs are older
     * than the logs the stream delivers meanwhile, so they apply together in
     * chain order once they are read, see resumeLive. While the syncer buffers
     * for its start, the start replays the buffer itself
     */
    holdLive() {
        this.holding = true;
        if (this.phase === "live") this.ingestor.goBuffer();
    }

    /**
     * Applies the events that waited in the buffer during the handover, in
     * chain order, and goes live again, see holdLive. The events at or below
     * the snapshot block are dropped, the snapshot holds them. There is no
     * await between the drain and going live, so no log slips through
     */
    resumeLive() {
        if (!this.holding) return;
        this.holding = false;
        if (this.phase !== "live") return;
        for (const ingested of this.ingestor.drain(this.snapshotBlock)) this.enqueue(ingested);
        this.ingestor.goLive();
    }

    /**
     * Resolves once every event that went to the apply queue so far is
     * applied or parked, the events that wait in the buffer, while the syncer
     * buffers, replays or holds, are not in the queue
     */
    async settled(): Promise<void> {
        await this.queue;
    }

    /**
     * Applies the subgraph snapshot as the state at its block, replays the
     * buffered events above that block, and goes live. The orders must have
     * been fetched pinned to the given block, see SubgraphManager.fetchSnapshotAt.
     * @param orders - The active orders of the orderbook at the block
     * @param block - The block the snapshot holds at
     */
    async applySnapshot(orders: SgOrder[], block: bigint): Promise<SnapshotReport> {
        if (this.phase !== "buffering") {
            throw new Error("the snapshot can only be applied once, from the buffering phase");
        }
        // a start in progress applies the snapshot itself, one from outside
        // would leave its promise hanging
        if (this.starter && !this.starter.attempting) {
            throw new Error("a start is pending, the snapshot is applied by it");
        }
        this.phase = "replaying";
        this.snapshotBlock = block;
        this.ingestor.snapshotBlock = block;
        const report: SnapshotReport = {
            snapshotBlock: block,
            ordersAdded: 0,
            ordersFailed: {},
            eventsReplayed: 0,
            eventsParked: 0,
        };

        for (const sgOrder of orders) {
            try {
                if (sgOrder.orderbook.id.toLowerCase() !== this.orderbook) continue;
                // an order the filters leave out is not seeded nor recorded, the
                // events of it get dropped at the ingestor the same way
                if (!applyFilters(sgOrder, this.filters)) continue;
                const orderHash = sgOrder.orderHash.toLowerCase() as Hex;
                // a v4 orderbook has v3 orders, the others v4 orders
                const struct = Order.tryFromBytes(sgOrder.orderBytes);
                if (struct.isErr()) {
                    report.ordersFailed[orderHash] = "order bytes do not decode";
                    continue;
                }
                this.orderType ??= struct.value.type;
                // the snapshot carries the token details and the balances at the block
                this.seedVaults(sgOrder, block);
                // a sink that throws fails the order, not the snapshot
                const result = await Promise.resolve()
                    .then(() => this.sink.addOrder(sgOrder))
                    .catch((error: unknown) => Result.err(error));
                if (result.isErr()) {
                    report.ordersFailed[orderHash] = String(result.error);
                } else {
                    // only an order the sink took is known as active
                    this.orders.set(orderHash, {
                        orderHash,
                        order: struct.value,
                        orderBytes: sgOrder.orderBytes as Hex,
                        meta: sgOrder.meta as Hex | undefined,
                        active: true,
                    });
                    report.ordersAdded++;
                }
            } catch (error) {
                // a malformed order fails on its own, the snapshot goes on
                report.ordersFailed[String(sgOrder?.orderHash).toLowerCase()] = String(error);
            }
        }

        // the buffered events above the snapshot block, in chain order, logs keep
        // coming while the replay awaits the sink and go to the buffer, so it is
        // drained again until nothing is left, and only then does live mode start,
        // with no await in between for a log to slip through. A handover that starts
        // during the replay stops the drain, the rest waits for resumeLive
        for (;;) {
            if (this.holding) break;
            const events = this.ingestor.drain(block);
            if (!events.length) break;
            for (const ingested of events) {
                try {
                    await this.apply(ingested);
                } catch {
                    this.counts.failed++;
                }
                report.eventsReplayed++;
            }
        }
        report.eventsParked = this.parked.length;

        // while the client layer hands the stream over, the events stay in the buffer
        // until it is filled, see resumeLive
        if (!this.holding) this.ingestor.goLive();
        this.phase = "live";
        return report;
    }

    /**
     * What the client layer has to read for the parked events to apply, the
     * vaults of this orderbook only, the ledger is shared by the syncers of
     * every orderbook, so each one asks for its own and the reads are not
     * doubled
     * @param readBlock - (optional) The block the vault reads are at, a vault
     * tracked by an event above it is left out until a read can hold that block
     */
    needs(readBlock?: bigint): SyncNeeds {
        // only the vaults with no baseline or no token details, not every vault
        const mine = this.ledger
            .unresolvedVaults()
            .filter((state) => state.ref.orderbook === this.orderbook);
        const tokens = new Set<Hex>();
        for (const state of mine) {
            if (!this.ledger.tokens.has(state.ref.token)) tokens.add(state.ref.token);
        }
        // a vaultless io is not tracked, a parked add still needs its token
        for (const ingested of this.parked) {
            if (!isAdd(ingested)) continue;
            const { order } = ingested.event;
            for (const io of [...order.validInputs, ...order.validOutputs]) {
                const token = io.token.toLowerCase() as Hex;
                if (this.isVaultless(io.vaultId) && !this.ledger.tokens.has(token)) {
                    tokens.add(token);
                }
            }
        }
        return {
            tokens: [...tokens],
            vaults: mine
                .filter((state) => state.baseline === undefined && readable(state, readBlock))
                .map((state) => state.ref),
        };
    }

    /** Hands in the details of a token, retries what waited on them */
    resolveToken(details: TokenDetails) {
        this.ledger.setToken(details);
        this.scheduleRetry();
    }

    /**
     * Hands in the balance of a vault read at a block, retries what waited on
     * it, the changes the logs reported at or below that block are dropped as
     * the read holds them. A read of a vault that is not tracked anymore, or
     * that was tracked again above the read block, is dropped, it does not hold
     * every change the ledger dropped
     */
    resolveVaultBalance(vault: VaultRef, balance: bigint, blockNumber: bigint) {
        const ref = normalizeVault(vault);
        const state = this.ledger.vaults.get(VaultLedger.key(ref));
        if (!state || !readable(state, blockNumber)) return;
        this.ledger.setBaseline(ref, balance, blockNumber);
        this.scheduleRetry();
    }

    /**
     * Gives up the reads of the given tokens and vaults, the client layer calls
     * it when a read keeps failing. The orders that need one of them are dropped
     * and counted as given up, the parked adds and also the active orders, as a
     * reorg can clear the balance of a vault that an active order uses. An
     * active order goes out through the sink. Their other vaults with no
     * balance stop being read, unless another order uses them, see
     * untrackVaults, and the given vaults stop being read
     * @param tokens - The tokens whose reads gave up
     * @param vaults - The vaults whose reads gave up
     */
    giveUp(tokens: Hex[], vaults: VaultRef[]) {
        if (!tokens.length && !vaults.length) return;
        const lostTokens = new Set(tokens.map((token) => token.toLowerCase()));
        const lostVaults = new Set(vaults.map((vault) => VaultLedger.key(vault)));
        const needsLost = (order: Order) =>
            [...order.validInputs, ...order.validOutputs].some((io) => {
                const vault = vaultOf(this.orderbook, order.owner, io);
                return (
                    lostTokens.has(vault.token.toLowerCase()) ||
                    lostVaults.has(VaultLedger.key(vault))
                );
            });
        // in the queue, so it does not race a retry of the parked events
        this.enqueue(async () => {
            const dropped: Order[] = [];
            this.parked = this.parked.filter((ingested) => {
                if (!isAdd(ingested) || !needsLost(ingested.event.order)) return true;
                dropped.push(ingested.event.order);
                return false;
            });
            const removed: KnownOrder[] = [];
            for (const known of this.orders.values()) {
                if (!known.active || !needsLost(known.order)) continue;
                known.active = false;
                known.removedAt = this.newestBlock;
                removed.push(known);
                dropped.push(known.order);
            }
            this.counts.givenUp += dropped.length;
            for (const order of dropped) this.untrackVaults(order);
            for (const vault of vaults) this.ledger.untrackUnresolved(vault);
            for (const known of removed) {
                try {
                    const { orderHash, order, orderBytes, meta } = known;
                    await this.sink.removeOrder(
                        this.toSgOrder(orderHash, order, orderBytes, meta, true)!,
                    );
                } catch {
                    this.counts.failed++;
                }
            }
        });
    }

    /**
     * Queues one retry of the parked events. A retry that is queued and has not
     * started yet covers the later calls too, so the reads of one batch cause
     * one retry
     */
    private scheduleRetry() {
        if (this.retryQueued) return;
        this.retryQueued = true;
        this.enqueue(() => {
            this.retryQueued = false;
            return this.retryParked();
        });
    }

    /**
     * Runs a step after the ones before it, so the order of events holds across
     * async sink calls. A step that throws counts as failed and the next steps
     * still run
     */
    private enqueue(step: IngestedEvent | (() => Promise<void>)) {
        const run = typeof step === "function" ? step : () => this.apply(step);
        this.queue = this.queue.then(run).catch(() => {
            this.counts.failed++;
        });
    }

    /**
     * Applies one event to the ledger and the sink, or parks it
     * @param ingested - The event
     */
    private async apply(ingested: IngestedEvent): Promise<void> {
        // the ingested event itself goes to addOrder, a retry that parks it
        // again then finds it in everParked
        const { event, reverted } = ingested;
        switch (event.type) {
            case "AddOrder": {
                if (reverted) {
                    this.counts.reverted++;
                    await this.removeOrder(
                        event.orderHash,
                        event.order,
                        event.orderBytes,
                        event.ref.blockNumber,
                    );
                } else {
                    await this.addOrder(event, ingested);
                }
                return;
            }
            case "RemoveOrder": {
                if (reverted) {
                    this.counts.reverted++;
                    await this.addOrder(
                        {
                            ...event,
                            type: "AddOrder",
                            meta: this.orders.get(event.orderHash)?.meta,
                        },
                        ingested,
                    );
                } else {
                    await this.removeOrder(
                        event.orderHash,
                        event.order,
                        event.orderBytes,
                        event.ref.blockNumber,
                    );
                }
                return;
            }
            case "Meta":
                await this.applyMeta(event, reverted);
                return;
            default:
                this.applyVaultEvent(event, reverted);
        }
    }

    /**
     * Gives an order the meta that came after its add. A parked add of the order
     * takes the meta, so it applies with it. An order in the sink gets it as an
     * update. A meta that a reorg removed is ignored, the reorg undoes the add of
     * the same transaction with it
     */
    private async applyMeta(event: MetaEvent, reverted: boolean) {
        if (reverted) return;
        let found = false;
        for (const { event: parkedEvent } of this.parked) {
            if (parkedEvent.type === "AddOrder" && parkedEvent.orderHash === event.orderHash) {
                parkedEvent.meta = event.meta;
                found = true;
            }
        }
        const known = this.orders.get(event.orderHash);
        if (known) {
            found = true;
            if (known.meta !== event.meta) {
                known.meta = event.meta;
                if (known.active) {
                    await this.sink.updateMeta(
                        this.orderbook,
                        known.order.owner,
                        event.orderHash,
                        event.meta,
                    );
                }
            }
        }
        if (found) this.counts.applied++;
    }

    /**
     * Adds an order, or parks the event when a token or a vault balance of it
     * is not known yet. A removal seen before the add applies drops the add.
     */
    private async addOrder(event: AddOrderEvent, ingested: IngestedEvent): Promise<void> {
        const { orderHash, order } = event;
        this.orderType ??= order.type;
        // the vaults of the order are of interest from now on
        for (const io of [...order.validInputs, ...order.validOutputs]) {
            if (this.isVaultless(io.vaultId)) continue;
            this.ledger.track(vaultOf(this.orderbook, order.owner, io), event.ref.blockNumber);
        }
        const sgOrder = this.toSgOrder(orderHash, order, event.orderBytes, event.meta);
        if (!sgOrder) {
            if (!this.parked.includes(ingested)) this.parked.push(ingested);
            // a retry that parks again is not a new park
            if (!this.everParked.has(ingested)) {
                this.everParked.add(ingested);
                this.counts.parked++;
                try {
                    this.onPark?.();
                } catch {
                    // the listener's trouble is its own, the sync goes on
                }
            }
            return;
        }
        const result = await this.sink.addOrder(sgOrder);
        if (result.isErr()) {
            this.counts.failed++;
            return;
        }
        // only an order the sink took is known as active
        this.orders.set(orderHash, {
            orderHash,
            order,
            orderBytes: event.orderBytes,
            meta: event.meta,
            active: true,
        });
        this.counts.applied++;
    }

    /**
     * Removes an order, and drops a parked add of the same order, a reverted
     * removal is an add too. The vaults of the order with no balance yet stop
     * being read, unless another order references them
     */
    private async removeOrder(
        orderHash: Hex,
        order: Order,
        orderBytes: Hex,
        blockNumber: bigint,
    ): Promise<void> {
        const wasParked = this.parked.length;
        this.parked = this.parked.filter(
            (ingested) => !(isAdd(ingested) && ingested.event.orderHash === orderHash),
        );
        this.counts.dropped += wasParked - this.parked.length;
        const known = this.orders.get(orderHash);
        if (known) {
            known.active = false;
            known.removedAt = blockNumber;
        }
        this.untrackVaults(order);
        // the removal only needs the token addresses, unknown details do no harm
        await this.sink.removeOrder(
            this.toSgOrder(orderHash, order, orderBytes, known?.meta, true)!,
        );
        this.counts.applied++;
    }

    /** Applies the vault changes of an event to the ledger, the round reads them from there */
    private applyVaultEvent(event: VaultEvent, reverted: boolean) {
        for (const change of event.changes) {
            this.ledger.apply(change, event.ref.blockNumber, reverted);
        }
        if (reverted) this.counts.reverted++;
        else this.counts.applied++;
    }

    /**
     * Stops the reads for the vaults of a removed order that have no balance
     * yet, when no active order and no parked add of this orderbook references
     * them, so an order whose token or vault never resolves is not read forever
     */
    private untrackVaults(order: Order) {
        const vaults = [...order.validInputs, ...order.validOutputs]
            .map((io) => vaultOf(this.orderbook, order.owner, io))
            .filter((vault) => this.ledger.balance(vault) === undefined);
        if (!vaults.length) return;
        const referenced = new Set<VaultKey>();
        const reference = (other: Order) => {
            for (const io of [...other.validInputs, ...other.validOutputs]) {
                referenced.add(VaultLedger.key(vaultOf(this.orderbook, other.owner, io)));
            }
        };
        for (const known of this.orders.values()) if (known.active) reference(known.order);
        for (const ingested of this.parked) {
            if (isAdd(ingested)) reference(ingested.event.order);
        }
        for (const vault of vaults) {
            if (!referenced.has(VaultLedger.key(vault))) this.ledger.untrackUnresolved(vault);
        }
    }

    /**
     * Retries the parked events in the order they came, the ones still waiting
     * stay parked, an event whose apply throws counts as failed and the rest go on
     */
    private async retryParked(): Promise<void> {
        const parked = this.parked;
        this.parked = [];
        for (const ingested of parked) {
            try {
                await this.apply(ingested);
            } catch {
                this.counts.failed++;
            }
        }
    }

    /**
     * Whether a vault id is a vaultless io, vault id 0 on a v6 orderbook. It
     * draws from and pays to the owner's wallet, no log tells its balance, so
     * the ledger does not track it, see OrderManager.isVaultless
     * @param vaultId - The vault id, a bytes32 hex, a uint256 or a bigint
     */
    private isVaultless(vaultId: Hex | bigint | string): boolean {
        return this.version === SubgraphVersions.V6 && BigInt(vaultId) === 0n;
    }

    /** Seeds the ledger with the tokens and the vault balances a snapshot order carries */
    private seedVaults(sgOrder: SgOrder, block: bigint) {
        const owner = sgOrder.owner.toLowerCase() as Hex;
        for (const io of [...sgOrder.inputs, ...sgOrder.outputs]) {
            const token: TokenDetails = {
                address: io.token.address.toLowerCase(),
                decimals: Number(io.token.decimals),
                symbol: io.token.symbol,
            };
            this.ledger.setToken(token);
            const balance = parseBalance(io.balance, token.decimals);
            const vault: VaultRef = {
                orderbook: this.orderbook,
                owner,
                token: token.address as Hex,
                // the subgraph serves the id as a number or a hex, either way a bigint
                vaultId: BigInt(io.vaultId),
            };
            // a vaultless io has no vault to seed, its token is still known
            if (this.isVaultless(vault.vaultId)) continue;
            this.ledger.track(vault, block);
            if (balance !== undefined) this.ledger.setBaseline(vault, balance, block);
        }
    }

    /**
     * Builds the order in the shape the sink takes, undefined when a token or a
     * vault balance of it is not known yet, unless told to make do, which fills
     * the unknowns with blanks, enough for a removal
     */
    private toSgOrder(
        orderHash: Hex,
        order: Order,
        orderBytes: Hex,
        meta: Hex | undefined,
        makeDo = false,
    ): SgOrder | undefined {
        const ios = (list: (Order.V3.IO | Order.V4.IO)[]): SgOrder["inputs"] | undefined => {
            const result: SgOrder["inputs"] = [];
            for (const io of list) {
                const token = this.ledger.tokens.get(io.token);
                // a vaultless io needs no balance, the round does not gate on it
                const balance = this.isVaultless(io.vaultId)
                    ? 0n
                    : this.ledger.balance(vaultOf(this.orderbook, order.owner, io));
                if (!makeDo && (!token || balance === undefined)) return undefined;
                const decimals = token?.decimals ?? 0;
                // the order manager reads the balance of a v4 orderbook order as a
                // decimal string of token units, of the others as a rain float
                let value: string;
                if (order.type === Order.Type.V3) {
                    value = (balance ?? 0n).toString();
                } else {
                    const float = toFloat(balance ?? 0n, decimals);
                    if (!makeDo && float.isErr()) return undefined;
                    value = float.isOk() ? float.value : "0x0";
                }
                result.push({
                    vaultId: BigInt(io.vaultId).toString(),
                    balance: value,
                    token: {
                        address: io.token,
                        decimals,
                        symbol: token?.symbol ?? "",
                    },
                });
            }
            return result;
        };
        const inputs = ios(order.validInputs);
        const outputs = ios(order.validOutputs);
        if (!inputs || !outputs) return undefined;
        return {
            __version: this.version,
            id: orderHash,
            owner: order.owner,
            orderHash,
            orderBytes,
            meta,
            active: true,
            nonce: order.nonce,
            orderbook: { id: this.orderbook },
            inputs,
            outputs,
        };
    }
}

/** The vault an order io points at, the id a bytes32 hex or a uint256 alike */
function vaultOf(orderbook: Hex, owner: Hex, io: Order.V3.IO | Order.V4.IO): VaultRef {
    return { orderbook, owner, token: io.token, vaultId: BigInt(io.vaultId) };
}

/** Whether the event adds an order, an add or a reverted removal */
function isAdd(
    ingested: IngestedEvent,
): ingested is IngestedEvent & { event: AddOrderEvent | RemoveOrderEvent } {
    const { event, reverted } = ingested;
    return (event.type === "AddOrder" && !reverted) || (event.type === "RemoveOrder" && reverted);
}

/** Lower cases a vault ref the client layer hands in */
function normalizeVault(vault: VaultRef): VaultRef {
    return {
        orderbook: vault.orderbook.toLowerCase() as Hex,
        owner: vault.owner.toLowerCase() as Hex,
        token: vault.token.toLowerCase() as Hex,
        vaultId: vault.vaultId,
    };
}

/**
 * A subgraph balance in token units, undefined when it does not parse. A v5 or
 * v6 orderbook balance is a float hex, a v4 one a decimal string of token units
 */
function parseBalance(balance: string, decimals: number): bigint | undefined {
    if (balance.startsWith("0x")) {
        const normalized = normalizeFloat(balance, decimals);
        return normalized.isOk() ? normalized.value : undefined;
    }
    try {
        return BigInt(balance);
    } catch {
        return undefined;
    }
}

export type { OrderbookEvent };
