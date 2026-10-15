import { Result } from "../common";
import { VaultLedger } from "./ledger";
import { toOrderBytes } from "./decode";
import { SubgraphVersions } from "../subgraph/types";
import { EventSyncManager, POLL_REREAD_BLOCKS, READ_MAX_RETRIES } from "./manager";
import { Hex, RawLog } from "./types";
import { SYNC_EVENTS, SYNC_TOPICS } from "./stream";
import { describe, it, expect, beforeEach, vi, Mock } from "vitest";
import {
    float,
    logs,
    logsV4,
    order,
    orderV3,
    ORDERBOOK,
    OWNER,
    USDC,
    VAULT_1,
    VAULT_2,
    WETH,
    HASH_A,
    HASH_B,
} from "./fixtures";

const OTHER_ORDERBOOK = "0x000000000000000000000000000000000000b007";
const URL = "https://sg.example/v6";

/** The snapshot order of the fixture order */
const snapshotOrder = () => ({
    __version: SubgraphVersions.V6,
    id: HASH_A,
    owner: OWNER,
    orderHash: HASH_A,
    orderBytes: toOrderBytes(order()),
    active: true,
    nonce: order().nonce,
    orderbook: { id: ORDERBOOK },
    inputs: [
        {
            balance: float(1_000n, 6),
            vaultId: BigInt(VAULT_1).toString(),
            token: { address: USDC, decimals: 6, symbol: "USDC" },
        },
    ],
    outputs: [
        {
            balance: float(5n, 18),
            vaultId: BigInt(VAULT_2).toString(),
            token: { address: WETH, decimals: 18, symbol: "WETH" },
        },
    ],
});

describe("Test EventSyncManager", () => {
    let subs: any[];
    let wsClient: any;
    let blockListeners: ((block: bigint) => void)[];
    let state: any;
    let orderManager: any;
    let subgraphManager: any;
    /** A sealed block, served over ws unless told it was polled */
    const block = (n: bigint, polled = false) => {
        state.canonicalBlockNumber = n;
        if (!polled) state.wsBlockNumber = n;
        blockListeners.forEach((listener) => listener(n));
    };

    beforeEach(() => {
        subs = [];
        blockListeners = [];
        wsClient = {
            transport: {
                subscribe: vi.fn(async (args: any) => {
                    subs.push(args);
                    return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
                }),
            },
        };
        state = {
            appOptions: { flashblocks: false, wsRpc: "wss://rpc.example" },
            canonicalBlockNumber: 0n,
            wsBlockNumber: 0n,
            watchedTokens: new Map(),
            watchToken: vi.fn((token: any) => state.watchedTokens.set(token.address, token)),
            getWsClient: vi.fn(() => wsClient),
            openWsSocket: vi.fn(),
            onBlockNumber: vi.fn((listener: any) => {
                blockListeners.push(listener);
                return () => blockListeners.splice(blockListeners.indexOf(listener), 1);
            }),
            client: {
                readContract: vi.fn(),
                multicall: vi.fn().mockResolvedValue([]),
                getLogs: vi.fn().mockResolvedValue([]),
                getBlock: vi.fn(),
            },
        };
        orderManager = {
            ledger: new VaultLedger(),
            logSyncedOrderbooks: new Set(),
            vaultlessOrderbooks: new Set(),
            addOrder: vi.fn().mockResolvedValue(Result.ok(undefined)),
            removeOrders: vi.fn().mockResolvedValue(undefined),
            updateOrderMeta: vi.fn(),
        };
        subgraphManager = {
            getOrderbooksByUrl: vi
                .fn()
                .mockResolvedValue(new Map([[URL, new Set([ORDERBOOK, OTHER_ORDERBOOK])]])),
            getIndexedBlock: vi.fn().mockResolvedValue(10_000),
            fetchSnapshotAt: vi.fn().mockResolvedValue([snapshotOrder()]),
            subgraphs: [URL],
            getSubgraphVersion: vi.fn(() => SubgraphVersions.V6),
        };
    });

    const init = (filters?: any) =>
        EventSyncManager.init({
            state,
            orderManager,
            subgraphManager,
            filters,
            resubscribeDelay: 10,
            subgraphRetryDelay: 0,
        });

    it("should build a syncer per orderbook the subgraphs index, narrowed by the filters", async () => {
        const all = await init();
        expect(all.orderbooks).toEqual([ORDERBOOK, OTHER_ORDERBOOK]);
        expect(all.mode).toBe("ws");
        expect(all.failedSubgraphs).toEqual([]);
        expect(all.report().failedSubgraphs).toEqual([]);
        expect([...orderManager.logSyncedOrderbooks]).toEqual([ORDERBOOK, OTHER_ORDERBOOK]);
        // vault id 0 of a v6 orderbook is vaultless
        expect([...orderManager.vaultlessOrderbooks]).toEqual([ORDERBOOK, OTHER_ORDERBOOK]);
        expect(all.syncs.get(ORDERBOOK)?.syncer.ledger).toBe(orderManager.ledger);
        expect(all.syncs.get(ORDERBOOK)?.version).toBe(SubgraphVersions.V6);

        const included = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        expect(included.orderbooks).toEqual([ORDERBOOK]);
        const excluded = await init({ excludeOrderbooks: new Set([ORDERBOOK]) });
        expect(excluded.orderbooks).toEqual([OTHER_ORDERBOOK]);
    });

    it("should sync the orderbooks of every subgraph version, and keep the subgraphs that did not answer", async () => {
        const LEGACY_URL = "https://sg.example/legacy";
        const DOWN_URL = "https://sg.example/down";
        subgraphManager.subgraphs = [URL, LEGACY_URL, DOWN_URL];
        subgraphManager.getSubgraphVersion.mockImplementation((url: string) =>
            url === URL ? SubgraphVersions.V6 : SubgraphVersions.LEGACY,
        );
        subgraphManager.getOrderbooksByUrl.mockResolvedValue(
            new Map([
                [URL, new Set([ORDERBOOK])],
                [LEGACY_URL, new Set([OTHER_ORDERBOOK])],
            ]),
        );
        const manager = await init();
        expect(manager.orderbooks).toEqual([ORDERBOOK, OTHER_ORDERBOOK]);
        expect(manager.syncs.get(ORDERBOOK)?.syncer.version).toBe(SubgraphVersions.V6);
        expect(manager.syncs.get(OTHER_ORDERBOOK)?.syncer.version).toBe(SubgraphVersions.LEGACY);
        expect([...orderManager.vaultlessOrderbooks]).toEqual([ORDERBOOK]);
        expect(manager.failedSubgraphs).toEqual([DOWN_URL]);
        expect(manager.report().failedSubgraphs).toEqual([DOWN_URL]);
        // the subgraph that did not answer is asked again, the others are not
        expect(subgraphManager.getOrderbooksByUrl).toHaveBeenCalledTimes(3);
        expect(subgraphManager.getOrderbooksByUrl).toHaveBeenNthCalledWith(1);
        expect(subgraphManager.getOrderbooksByUrl).toHaveBeenNthCalledWith(2, [DOWN_URL]);
        expect(subgraphManager.getOrderbooksByUrl).toHaveBeenNthCalledWith(3, [DOWN_URL]);
    });

    it("should ask the subgraphs that did not answer again, and keep the order of the config", async () => {
        const LATE_URL = "https://sg.example/late";
        subgraphManager.subgraphs = [LATE_URL, URL];
        // both index the orderbook, the late one answers on the second ask
        subgraphManager.getOrderbooksByUrl
            .mockResolvedValueOnce(new Map([[URL, new Set([ORDERBOOK])]]))
            .mockResolvedValueOnce(new Map([[LATE_URL, new Set([ORDERBOOK])]]));
        subgraphManager.getSubgraphVersion.mockImplementation((url: string) =>
            url === URL ? SubgraphVersions.V6 : SubgraphVersions.LEGACY,
        );
        const manager = await init();
        expect(subgraphManager.getOrderbooksByUrl).toHaveBeenCalledTimes(2);
        expect(manager.failedSubgraphs).toEqual([]);
        // the first subgraph of the config that indexes the orderbook syncs it
        expect(manager.syncs.get(ORDERBOOK)?.url).toBe(LATE_URL);
        expect(manager.syncs.get(ORDERBOOK)?.syncer.version).toBe(SubgraphVersions.LEGACY);
    });

    it("should open one subscription for all orderbooks, and hand each log to the syncer of its orderbook", async () => {
        const manager = await init();
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params).toEqual([
            "logs",
            { address: [ORDERBOOK, OTHER_ORDERBOOK], topics: SYNC_TOPICS },
        ]);
        const served = (log: RawLog) => ({
            ...log,
            blockNumber: `0x${log.blockNumber.toString(16)}`,
            logIndex: `0x${log.logIndex.toString(16)}`,
        });
        const deposit = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 100n, logIndex: 0 });
        subs[0].onData({ result: served(deposit) });
        subs[0].onData({ result: served({ ...deposit, logIndex: 1, address: OTHER_ORDERBOOK }) });
        // a log of an address that is not under sync goes nowhere
        subs[0].onData({
            result: served({
                ...deposit,
                logIndex: 2,
                address: "0x0000000000000000000000000000000000000ffe",
            }),
        });
        expect(manager.syncs.get(ORDERBOOK)!.syncer.ingestor.bufferedCount).toBe(1);
        expect(manager.syncs.get(OTHER_ORDERBOOK)!.syncer.ingestor.bufferedCount).toBe(1);

        // a drop hands the logs of all orderbooks to one poll, from the latest
        // proof that the socket was alive, the log at 100
        block(101n);
        subs[0].onError(new Error("socket closed"));
        expect(manager.stream.fallback).toBe(true);
        expect(manager.stream.pollFrom).toBe(100n);
        manager.close();
    });

    it("should not open the stream with no orderbook, an empty address list matches every log", async () => {
        subgraphManager.getOrderbooksByUrl.mockResolvedValue(new Map([[URL, new Set()]]));
        const manager = await init();
        manager.open();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(subs).toHaveLength(0);
        expect(state.onBlockNumber).not.toHaveBeenCalled();
    });

    it("should take the logs of the flashblocks when they are on, and keep no record of them", async () => {
        state.appOptions.flashblocks = true;
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params).toEqual([
            "pendingLogs",
            { address: [ORDERBOOK], topics: SYNC_TOPICS },
        ]);
        // a pending log carries a zero block hash, so it is not kept for a later compare
        const pending = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 100n, logIndex: 0 });
        subs[0].onData({
            result: {
                ...pending,
                blockNumber: "0x64",
                logIndex: "0x0",
                blockHash: `0x${"0".repeat(64)}`,
            },
        });
        expect(manager.stream.lastLogBlock).toBe(100n);
        expect(manager.stream.polledBlocks.size).toBe(0);
        manager.close();
    });

    it("should keep a record of the logs of a logs subscription", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        const sealed = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 100n, logIndex: 0 });
        subs[0].onData({
            result: {
                ...sealed,
                blockNumber: "0x64",
                logIndex: "0x0",
                blockHash: `0x${"a".repeat(64)}`,
            },
        });
        expect(manager.stream.polledBlocks.get(100n)?.hash).toBe(`0x${"a".repeat(64)}`);
        // the same log mined again in a new block at the same height, then the
        // late removal of the old one, the record of the new block keeps it
        subs[0].onData({
            result: {
                ...sealed,
                blockNumber: "0x64",
                logIndex: "0x0",
                blockHash: `0x${"b".repeat(64)}`,
            },
        });
        subs[0].onData({
            result: {
                ...sealed,
                blockNumber: "0x64",
                logIndex: "0x0",
                blockHash: `0x${"a".repeat(64)}`,
                removed: true,
            },
        });
        expect(manager.stream.polledBlocks.get(100n)?.hash).toBe(`0x${"b".repeat(64)}`);
        expect(manager.stream.polledBlocks.get(100n)?.logs.size).toBe(1);
        // the removal of its only log takes the block out of the record
        subs[0].onData({
            result: {
                ...sealed,
                blockNumber: "0x64",
                logIndex: "0x0",
                blockHash: `0x${"b".repeat(64)}`,
                removed: true,
            },
        });
        expect(manager.stream.polledBlocks.has(100n)).toBe(false);
        manager.close();
    });

    it("should keep a failed read on the report, the needs stay with their reason", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        await started;

        // the tokens are known, the vault batch is refused by the provider
        state.watchedTokens.set(USDC, { address: USDC, decimals: 6, symbol: "USDC" });
        state.watchedTokens.set(WETH, { address: WETH, decimals: 18, symbol: "WETH" });
        state.client.multicall.mockRejectedValue(new Error("no multicall3 on this chain"));
        const add = logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 107n, logIndex: 0 });
        subs[0].onData({ result: { ...add, blockNumber: "0x6b", logIndex: "0x0" } });
        block(107n);
        await vi.waitFor(() =>
            expect(manager.report().orderbooks[0].lastError).toBe("no multicall3 on this chain"),
        );
        expect(manager.report().orderbooks[0].needs).toEqual({ tokens: 0, vaults: 2 });
        expect(orderManager.addOrder).not.toHaveBeenCalled();

        // a token read that fails is kept the same way, an order on a token
        // the sync never saw, the vault batch goes through this time
        state.client.multicall.mockImplementation(async ({ contracts }: any) =>
            contracts.map(() => ({ status: "success", result: float(1n, 18) })),
        );
        state.client.readContract.mockRejectedValue(new Error("decimals reverted"));
        const unknownToken = "0x00000000000000000000000000000000000000d0";
        const other = logs.addOrder(
            HASH_A,
            { ...order(OWNER, 3), validInputs: [{ token: unknownToken, vaultId: VAULT_1 }] },
            { blockNumber: 108n, logIndex: 0 },
        );
        subs[0].onData({ result: { ...other, blockNumber: "0x6c", logIndex: "0x0" } });
        block(108n);
        await vi.waitFor(() =>
            expect(manager.report().orderbooks[0].lastError).toBe("decimals reverted"),
        );
        expect(manager.report().orderbooks[0].needs.tokens).toBe(1);
    });

    it("should start the orderbooks that can, and start the others again in the background", async () => {
        // the subgraph of the other orderbook fails until it recovers
        let down = true;
        subgraphManager.fetchSnapshotAt.mockImplementation(
            async (_url: string, _block: bigint, ob: Hex) => {
                if (ob === OTHER_ORDERBOOK && down) throw new Error("subgraph down");
                return ob === ORDERBOOK ? [snapshotOrder()] : [];
            },
        );
        const manager = await EventSyncManager.init({
            state,
            orderManager,
            subgraphManager,
            resubscribeDelay: 10,
            startTimeout: 50,
            startAttemptInterval: 0,
        });
        try {
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            const { reports, failed } = await started;
            expect([...reports.keys()]).toEqual([ORDERBOOK]);
            expect(failed.get(OTHER_ORDERBOOK)).toContain("subgraph down");
            // the start that gave up forgot its buffer, the retry buffers anew
            const other = manager.syncs.get(OTHER_ORDERBOOK)!.syncer;
            expect(other.phase).toBe("buffering");
            expect(other.firstBlock).toBeUndefined();

            down = false;
            let n = 107n;
            await vi.waitFor(() => {
                for (let i = 0; i < 8; i++) block(n++);
                expect(other.phase).toBe("live");
            });
            expect(other.snapshotBlock).toBeGreaterThan(106n);
        } finally {
            manager.close();
        }
    });

    it("should give up a token read that keeps failing, and drop the order that needs it", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        await started;

        state.watchedTokens.set(WETH, { address: WETH, decimals: 18, symbol: "WETH" });
        state.client.readContract.mockRejectedValue(new Error("decimals reverted"));
        state.client.multicall.mockImplementation(async ({ contracts }: any) =>
            contracts.map(() => ({ status: "success", result: float(1n, 18) })),
        );
        const unknownToken = "0x00000000000000000000000000000000000000d0";
        const add = logs.addOrder(
            HASH_A,
            { ...order(OWNER, 3), validInputs: [{ token: unknownToken, vaultId: VAULT_1 }] },
            { blockNumber: 107n, logIndex: 0 },
        );
        subs[0].onData({ result: { ...add, blockNumber: "0x6b", logIndex: "0x0" } });
        // the park reads the token at once, at the sealed head 106
        await new Promise((resolve) => setTimeout(resolve, 5));
        const decimalsReads = () =>
            state.client.readContract.mock.calls.filter(
                ([call]: any) => call.functionName === "decimals",
            ).length;
        for (let n = 107n; n <= 130n; n++) {
            block(n);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // tries at 106, 108, 112 and 120, the wait doubles after each failure,
        // the last failure gives up and no read follows
        expect(decimalsReads()).toBe(1 + READ_MAX_RETRIES);
        const sync = manager.syncs.get(ORDERBOOK)!;
        expect(sync.syncer.stats.givenUp).toBe(1);
        expect(sync.syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(orderManager.addOrder).not.toHaveBeenCalled();
        const report = manager.report().orderbooks[0];
        expect(report.newGivenUp).toBe(1);
        expect(report.lastError).toBe("decimals reverted");
        expect(manager.report().orderbooks[0].newGivenUp).toBe(0);
        manager.close();
    });

    it.each([
        [
            "each read of the batch",
            async ({ contracts }: any) =>
                contracts.map(() => ({ status: "failure", error: new Error("reverted") })),
        ],
        [
            "the batch as a whole",
            async () => {
                throw new Error("rpc down");
            },
        ],
    ])("should give up a vault read when %s keeps failing", async (_, multicall) => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        await started;

        state.watchedTokens.set(USDC, { address: USDC, decimals: 6, symbol: "USDC" });
        state.watchedTokens.set(WETH, { address: WETH, decimals: 18, symbol: "WETH" });
        state.client.multicall.mockClear();
        state.client.multicall.mockImplementation(multicall);
        const add = logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 107n, logIndex: 0 });
        subs[0].onData({ result: { ...add, blockNumber: "0x6b", logIndex: "0x0" } });
        for (let n = 107n; n <= 130n; n++) {
            block(n);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // the vaults are tracked at 107, tries at 107, 109, 113 and 121
        const readBlocks = state.client.multicall.mock.calls.map(([call]: any) => call.blockNumber);
        expect(readBlocks).toEqual([107n, 109n, 113n, 121n]);
        expect(readBlocks).toHaveLength(1 + READ_MAX_RETRIES);
        const sync = manager.syncs.get(ORDERBOOK)!;
        expect(sync.syncer.stats.givenUp).toBe(1);
        expect(sync.syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(orderManager.addOrder).not.toHaveBeenCalled();
        expect(manager.report().orderbooks[0].newGivenUp).toBe(1);
        manager.close();
    });

    it("should wait for a socket that is opening before it subscribes", async () => {
        let open!: () => void;
        state.openWsSocket.mockReturnValueOnce(new Promise<void>((resolve) => (open = resolve)));
        const manager = await init();
        manager.open();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(subs).toHaveLength(0);
        open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        manager.close();
    });

    it("should cancel a wait for a socket that is opening when the sync closes", async () => {
        let open!: () => void;
        const opening = new Promise<void>((resolve) => (open = resolve));
        state.openWsSocket.mockReturnValueOnce(opening).mockReturnValueOnce(opening);
        const manager = await init();
        manager.open();
        manager.close();
        manager.open();
        open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(subs).toHaveLength(1);
        manager.close();
    });

    it("should refuse to open in ws mode without a ws client", async () => {
        state.getWsClient.mockReturnValue(undefined);
        const manager = await init();
        expect(() => manager.open()).toThrow("ws rpc");
    });

    it("should subscribe every orderbook, feed the blocks, start off the snapshot and go live", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params).toEqual(["logs", { address: [ORDERBOOK], topics: SYNC_TOPICS }]);
        expect(state.onBlockNumber).toHaveBeenCalledTimes(1);

        const started = manager.start();
        // a log of block 100, then the watcher from 101, six blocks buffer, the
        // snapshot is fetched pinned at 103
        const served = (n: bigint, amount: bigint) => ({
            ...logs.deposit(OWNER, USDC, VAULT_1, amount, { blockNumber: n, logIndex: 0 }),
            blockNumber: `0x${n.toString(16)}`,
            logIndex: "0x0",
        });
        subs[0].onData({ result: served(100n, 999n) });
        for (let n = 101n; n <= 106n; n++) {
            block(n);
            subs[0].onData({ result: served(n, n) });
        }
        const { reports } = await started;
        expect(subgraphManager.fetchSnapshotAt).toHaveBeenCalledWith(URL, 103n, ORDERBOOK);
        expect(reports.get(ORDERBOOK)?.snapshotBlock).toBe(103n);
        expect(orderManager.addOrder).toHaveBeenCalledTimes(1);
        // the deposits of 104, 105 and 106 landed on the snapshot balance
        const sync = manager.syncs.get(ORDERBOOK)!;
        expect(sync.syncer.phase).toBe("live");
        expect(
            orderManager.ledger.balance({
                orderbook: ORDERBOOK,
                owner: OWNER,
                token: USDC,
                vaultId: BigInt(VAULT_1),
            }),
        ).toBe(1_000n + 104n + 105n + 106n);

        const report = manager.report();
        expect(report.mode).toBe("ws");
        expect(report.stream.drops).toBe(0);
        expect(report.orderbooks).toHaveLength(1);
        expect(report.orderbooks[0]).toMatchObject({
            orderbook: ORDERBOOK,
            url: URL,
            version: SubgraphVersions.V6,
            phase: "live",
        });
    });

    it("should read the gap below the buffer with a range query when the subgraph lags", async () => {
        subgraphManager.getIndexedBlock.mockResolvedValue(90);
        state.client.getLogs.mockResolvedValue([
            logs.deposit(OWNER, USDC, VAULT_1, 7n, { blockNumber: 95n, logIndex: 0 }),
        ]);
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        const { reports } = await started;

        expect(state.client.getLogs).toHaveBeenCalledTimes(1);
        expect(state.client.getLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                address: [ORDERBOOK],
                events: SYNC_EVENTS,
                fromBlock: 91n,
                toBlock: 103n,
            }),
        );
        expect(subgraphManager.fetchSnapshotAt).toHaveBeenCalledWith(URL, 90n, ORDERBOOK);
        expect(reports.get(ORDERBOOK)?.snapshotBlock).toBe(90n);
        expect(
            orderManager.ledger.balance({
                orderbook: ORDERBOOK,
                owner: OWNER,
                token: USDC,
                vaultId: BigInt(VAULT_1),
            }),
        ).toBe(1_007n);
    });

    it("should read the vaults of a v4 orderbook with vaultBalance, in token units", async () => {
        subgraphManager.getSubgraphVersion.mockImplementation(() => SubgraphVersions.LEGACY);
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        await started;

        state.watchedTokens.set(USDC, { address: USDC, decimals: 6, symbol: "USDC" });
        state.watchedTokens.set(WETH, { address: WETH, decimals: 18, symbol: "WETH" });
        state.client.multicall.mockImplementation(async ({ contracts }: any) =>
            contracts.map(({ args }: any) => ({
                status: "success",
                result: args[1] === USDC ? 50n : 7n,
            })),
        );
        const add = logsV4.addOrder(HASH_B, orderV3(OWNER, 2), { blockNumber: 107n, logIndex: 0 });
        subs[0].onData({ result: { ...add, blockNumber: "0x6b", logIndex: "0x0" } });
        // the vaults are read once the sealed head holds the block of the add
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(state.client.multicall).not.toHaveBeenCalled();
        block(107n);
        await vi.waitFor(() => expect(orderManager.addOrder).toHaveBeenCalledTimes(1));

        const [multicall] = state.client.multicall.mock.calls[0];
        expect(multicall.contracts.map((c: any) => c.functionName)).toEqual([
            "vaultBalance",
            "vaultBalance",
        ]);
        expect(multicall.contracts.map((c: any) => c.args)).toEqual([
            [OWNER, USDC, 1n],
            [OWNER, WETH, 2n],
        ]);
        const added = orderManager.addOrder.mock.calls[0][0];
        expect(added.__version).toBe(SubgraphVersions.LEGACY);
        expect(added.inputs[0].balance).toBe("50");
        expect(added.outputs[0].balance).toBe("7");
    });

    it("should answer what a syncer needs with reads, the tokens from the cache first", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
        const started = manager.start();
        for (let n = 100n; n <= 106n; n++) block(n);
        await started;

        // an order on tokens and vaults the snapshot did not cover comes in live
        state.watchedTokens.set(USDC, { address: USDC, decimals: 6, symbol: "USDC" });
        state.client.readContract.mockImplementation(async ({ functionName }: any) => {
            if (functionName === "decimals") return 18;
            if (functionName === "symbol") return "WETH";
            throw new Error(`unexpected read ${functionName}`);
        });
        // usdc vault 1 holds 50, weth vault 2 holds 7, one read of the batch fails
        state.client.multicall.mockImplementation(async ({ contracts }: any) =>
            contracts.map(({ args }: any) => {
                if (args[1] === USDC) return { status: "success", result: float(50n, 6) };
                if (args[1] === WETH) return { status: "success", result: float(7n, 18) };
                return { status: "failure", error: new Error("reverted") };
            }),
        );
        const add = logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 107n, logIndex: 0 });
        subs[0].onData({ result: { ...add, blockNumber: "0x6b", logIndex: "0x0" } });
        // the block releases the add, which parks for its tokens and vaults, and
        // the resolution that follows reads them all at that block
        block(107n);
        await vi.waitFor(() => expect(orderManager.addOrder).toHaveBeenCalledTimes(1));
        expect(state.watchedTokens.has(WETH)).toBe(true);

        const reads = state.client.readContract.mock.calls.map((call: any) => call[0]);
        // usdc came from the cache, weth from the chain, then both vaults in one
        // multicall at the block
        expect(reads.filter((r: any) => r.functionName === "decimals")).toHaveLength(1);
        expect(state.client.multicall).toHaveBeenCalledTimes(1);
        const [multicall] = state.client.multicall.mock.calls[0];
        expect(multicall.blockNumber).toBe(107n);
        expect(multicall.allowFailure).toBe(true);
        expect(multicall.contracts).toHaveLength(2);
        expect(multicall.contracts.map((c: any) => c.functionName)).toEqual([
            "vaultBalance2",
            "vaultBalance2",
        ]);
        expect(multicall.contracts.map((c: any) => c.args)).toEqual([
            [OWNER, USDC, VAULT_1],
            [OWNER, WETH, VAULT_2],
        ]);
        expect(manager.syncs.get(ORDERBOOK)!.syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(
            orderManager.ledger.balance({
                orderbook: ORDERBOOK,
                owner: OWNER,
                token: WETH,
                vaultId: BigInt(VAULT_2),
            }),
        ).toBe(7n);
    });

    it("should read the logs with the poll while the subscription is down, and hand over to the reopened stream", async () => {
        vi.useFakeTimers();
        try {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            subgraphManager.fetchSnapshotAt.mockResolvedValue([snapshotOrder()]);
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;
            const sync = manager.syncs.get(ORDERBOOK)!;
            const balance = () =>
                orderManager.ledger.balance({
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: USDC,
                    vaultId: BigInt(VAULT_1),
                });
            // the range queries serve what the chain holds in their range
            const chain: RawLog[] = [];
            state.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: any) =>
                chain.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
            );

            // a log at 107 is the last one seen, then the subscription drops
            const deposit107 = logs.deposit(OWNER, USDC, VAULT_1, 1n, {
                blockNumber: 107n,
                logIndex: 0,
            });
            chain.push(deposit107);
            subs[0].onData({ result: { ...deposit107, blockNumber: "0x6b", logIndex: "0x0" } });
            subs[0].onError(new Error("socket closed"));
            expect(manager.report().stream.drops).toBe(1);

            // the poll stands in on each block from the log at 107, its first
            // read also reads the blocks below again, and the syncer stays live
            chain.push(logs.deposit(OWNER, USDC, VAULT_1, 20n, { blockNumber: 108n, logIndex: 0 }));
            block(108n, true);
            await vi.advanceTimersByTimeAsync(0);
            expect(manager.stream.pollFrom).toBe(109n);
            expect(state.client.getLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: [ORDERBOOK],
                    events: SYNC_EVENTS,
                    fromBlock: 99n,
                    toBlock: 108n,
                }),
            );
            await sync.syncer.settled();
            // the deposit the stream gave and the poll read again counted once
            expect(balance()).toBe(1_000n + 1n + 20n);
            expect(sync.syncer.phase).toBe("live");

            // the subscription opens again at 108, its logs wait until the poll
            // has read past the margin above that block
            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(subs).toHaveLength(2));
            // each subscription opens the socket it takes, a closed one is dropped first
            expect(state.openWsSocket).toHaveBeenCalledTimes(2);
            expect(manager.stream.handoverAt).toBe(110n);
            const deposit110 = logs.deposit(OWNER, USDC, VAULT_1, 300n, {
                blockNumber: 110n,
                logIndex: 0,
            });
            chain.push(logs.deposit(OWNER, USDC, VAULT_1, 4n, { blockNumber: 109n, logIndex: 0 }));
            chain.push(deposit110);
            subs[1].onData({ result: { ...deposit110, blockNumber: "0x6e", logIndex: "0x0" } });
            await sync.syncer.settled();
            expect(balance()).toBe(1_021n);
            block(109n);
            await vi.waitFor(() => expect(state.client.getLogs).toHaveBeenCalledTimes(2));
            await sync.syncer.settled();
            expect(manager.stream.fallback).toBe(true);
            expect(balance()).toBe(1_021n);
            block(110n);
            await vi.waitFor(() => expect(manager.stream.fallback).toBe(false));
            await sync.syncer.settled();
            // the older deposit of 109 applied before the one of 110 that waited
            expect(balance()).toBe(1_021n + 4n + 300n);
            expect(manager.report().stream.backfilled).toBe(4);

            // the stream is the source again, no more range queries
            block(111n);
            await vi.advanceTimersByTimeAsync(0);
            expect(state.client.getLogs).toHaveBeenCalledTimes(3);

            // the close leaves no listener and no timer behind
            manager.close();
            expect(blockListeners).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("should undo a log of a block that a reorg replaced while the socket was down", async () => {
        vi.useFakeTimers();
        try {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            subgraphManager.fetchSnapshotAt.mockResolvedValue([snapshotOrder()]);
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;
            const sync = manager.syncs.get(ORDERBOOK)!;
            const balance = () =>
                orderManager.ledger.balance({
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: USDC,
                    vaultId: BigInt(VAULT_1),
                });

            // the stream delivers a deposit of block 107, then the socket drops
            const deposit = logs.deposit(OWNER, USDC, VAULT_1, 5n, {
                blockNumber: 107n,
                logIndex: 0,
            });
            subs[0].onData({
                result: {
                    ...deposit,
                    blockNumber: "0x6b",
                    logIndex: "0x0",
                    blockHash: `0x${"a".repeat(64)}`,
                },
            });
            await sync.syncer.settled();
            expect(balance()).toBe(1_005n);
            subs[0].onError(new Error("socket closed"));

            // a reorg replaced block 107 while the socket was down, the deposit is gone
            state.client.getLogs.mockResolvedValue([]);
            state.client.getBlock.mockResolvedValue({ hash: `0x${"b".repeat(64)}` });
            block(108n, true);
            await vi.advanceTimersByTimeAsync(0);
            await sync.syncer.settled();
            expect(state.client.getBlock).toHaveBeenCalledWith({ blockNumber: 107n });
            expect(manager.report().stream.reorged).toBe(1);
            expect(balance()).toBe(1_000n);
            manager.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should start the poll at the last ws head less the lookback when it proves the socket alive after the last log", async () => {
        vi.useFakeTimers();
        try {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;

            // a log at 107, then a long quiet spell the ws heads run through
            const served = logs.deposit(OWNER, USDC, VAULT_1, 1n, {
                blockNumber: 107n,
                logIndex: 0,
            });
            subs[0].onData({ result: { ...served, blockNumber: "0x6b", logIndex: "0x0" } });
            for (let n = 107n; n <= 500n; n++) block(n);
            // the socket goes silent, the heads now come from the polling
            for (let n = 501n; n <= 520n; n++) block(n, true);
            subs[0].onError(new Error("socket closed"));

            block(521n, true);
            await vi.waitFor(() => expect(state.client.getLogs).toHaveBeenCalledTimes(1));
            // from the last ws head less the lookback, and the blocks below
            // that again, the polled heads do not count
            expect(state.client.getLogs).toHaveBeenCalledWith(
                expect.objectContaining({ fromBlock: 484n, toBlock: 521n }),
            );
            manager.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should try a failed poll again on the next block from the same block while the subscription is down", async () => {
        vi.useFakeTimers();
        try {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;

            subs[0].onError(new Error("socket closed"));
            // the provider refuses the first query
            state.client.getLogs.mockRejectedValueOnce(new Error("range too large"));
            block(107n, true);
            await vi.waitFor(() =>
                expect(manager.report().stream.lastError).toBe("range too large"),
            );
            expect(state.client.getLogs).toHaveBeenCalledWith(
                expect.objectContaining({ fromBlock: 90n, toBlock: 107n }),
            );

            // the next block reads from the same block again, up to the new head
            state.client.getLogs.mockResolvedValue([
                logs.deposit(OWNER, USDC, VAULT_1, 20n, { blockNumber: 108n, logIndex: 0 }),
            ]);
            block(108n, true);
            await vi.waitFor(() => expect(manager.report().stream.backfilled).toBe(1));
            expect(state.client.getLogs).toHaveBeenLastCalledWith(
                expect.objectContaining({ fromBlock: 90n, toBlock: 108n }),
            );
            expect(manager.stream.pollFrom).toBe(109n);
            manager.close();
        } finally {
            vi.useRealTimers();
        }
    });

    describe("ws coverage", () => {
        /** A log as the subscription serves it, the numbers as hex strings */
        const served = (log: RawLog) => ({
            ...log,
            blockNumber: `0x${log.blockNumber.toString(16)}`,
            logIndex: `0x${log.logIndex.toString(16)}`,
        });

        it("should not take heads into the buffer before the logs subscription opens", async () => {
            let ack!: () => void;
            wsClient.transport.subscribe.mockImplementationOnce(async (args: any) => {
                subs.push(args);
                await new Promise<void>((resolve) => (ack = resolve));
                return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            });
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            const sync = manager.syncs.get(ORDERBOOK)!;
            manager.open();
            // a head read over http and a ws head, both before the acknowledgement
            block(100n, true);
            block(101n);
            expect(manager.stream.open).toBe(false);
            expect(sync.syncer.firstBlock).toBeUndefined();

            ack();
            await vi.waitFor(() => expect(manager.stream.open).toBe(true));
            // a head read over http after the acknowledgement can be older than it
            block(102n, true);
            expect(sync.syncer.firstBlock).toBeUndefined();
            // the first ws head after the acknowledgement starts the buffer
            block(103n);
            expect(sync.syncer.firstBlock).toBe(103n);
        });

        it("should run the start on the poll when the subscription fails before anything was seen", async () => {
            vi.useFakeTimers();
            try {
                const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
                const sync = manager.syncs.get(ORDERBOOK)!;
                manager.open();
                await vi.waitFor(() => expect(subs).toHaveLength(1));
                const started = manager.start();
                // the subscription fails before any head or log, the poll starts at the head
                subs[0].onError(new Error("refused"));
                expect(manager.stream.fallback).toBe(true);
                expect(manager.stream.pollFrom).toBeUndefined();
                for (let n = 100n; n <= 106n; n++) {
                    block(n, true);
                    await vi.advanceTimersByTimeAsync(0);
                }
                expect(state.client.getLogs).toHaveBeenCalledWith(
                    expect.objectContaining({ fromBlock: 100n, toBlock: 100n }),
                );
                // the poll hands the heads to the buffer, so the start goes on
                expect(sync.syncer.firstBlock).toBe(100n);
                const { reports } = await started;
                expect(reports.get(ORDERBOOK)?.snapshotBlock).toBe(103n);
                manager.close();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should go on with the start on the poll after a drop while buffering", async () => {
            vi.useFakeTimers();
            try {
                const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
                const sync = manager.syncs.get(ORDERBOOK)!;
                manager.open();
                await vi.waitFor(() => expect(subs).toHaveLength(1));
                const started = manager.start();
                for (let n = 100n; n <= 102n; n++) block(n);
                subs[0].onError(new Error("socket closed"));
                expect(manager.stream.pollFrom).toBe(94n);

                state.client.getLogs.mockResolvedValue([
                    logs.deposit(OWNER, USDC, VAULT_1, 7n, { blockNumber: 101n, logIndex: 0 }),
                ]);
                for (let n = 103n; n <= 106n; n++) {
                    block(n, true);
                    await vi.advanceTimersByTimeAsync(0);
                }
                // the first poll reads from the proof of the socket alive, and the blocks below again
                expect(state.client.getLogs).toHaveBeenCalledWith(
                    expect.objectContaining({ fromBlock: 86n, toBlock: 103n }),
                );
                expect(sync.syncer.newestBlock).toBe(106n);
                const { reports } = await started;
                expect(reports.get(ORDERBOOK)?.snapshotBlock).toBe(103n);
                manager.close();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should keep the poll on when the subscription drops again during the handover", async () => {
            vi.useFakeTimers();
            try {
                const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
                const sync = manager.syncs.get(ORDERBOOK)!;
                manager.open();
                await vi.waitFor(() => expect(subs).toHaveLength(1));
                const started = manager.start();
                for (let n = 100n; n <= 106n; n++) block(n);
                await started;

                // the first drop at the ws head 110
                for (let n = 107n; n <= 110n; n++) block(n);
                subs[0].onError(new Error("socket closed"));
                expect(manager.stream.pollFrom).toBe(102n);

                // the subscription opens again at 110, the handover waits for the poll at 112
                await vi.advanceTimersByTimeAsync(10);
                await vi.waitFor(() => expect(subs).toHaveLength(2));
                expect(manager.stream.handoverAt).toBe(112n);
                block(111n);
                await vi.advanceTimersByTimeAsync(0);
                // it drops again before the poll gets there, the poll goes on
                subs[1].onError(new Error("socket closed again"));
                expect(manager.stream.fallback).toBe(true);
                expect(manager.stream.pollFrom).toBe(112n);

                // the poll reads past the handover block, the syncer goes live
                // again, and the poll stays the source while the socket is down
                block(112n, true);
                await vi.advanceTimersByTimeAsync(0);
                expect(manager.stream.handoverAt).toBeUndefined();
                expect(manager.stream.fallback).toBe(true);
                expect(manager.report().orderbooks[0].buffered).toBe(0);
                expect(sync.syncer.phase).toBe("live");
                manager.close();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should keep the logs of the reopened stream in the buffer until the poll read past its start, and apply them in chain order", async () => {
            vi.useFakeTimers();
            try {
                const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
                const sync = manager.syncs.get(ORDERBOOK)!;
                manager.open();
                await vi.waitFor(() => expect(subs).toHaveLength(1));
                const started = manager.start();
                for (let n = 100n; n <= 107n; n++) block(n);
                await started;
                expect(orderManager.addOrder).toHaveBeenCalledTimes(1);
                const chain: RawLog[] = [];
                state.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: any) =>
                    chain.filter(
                        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
                    ),
                );

                // the subscription drops at 107, the poll stands in for two blocks
                subs[0].onError(new Error("socket closed"));
                for (let n = 108n; n <= 109n; n++) {
                    block(n, true);
                    await vi.advanceTimersByTimeAsync(0);
                }

                // the stream opens again at 109, order B is added at 110 and removed
                // at 111, the stream delivers the removal before the poll reads the add
                await vi.advanceTimersByTimeAsync(10);
                await vi.waitFor(() => expect(subs).toHaveLength(2));
                expect(manager.stream.handoverAt).toBe(111n);
                const add = logs.addOrder(HASH_B, order(OWNER, 2), {
                    blockNumber: 110n,
                    logIndex: 0,
                });
                const removal = logs.removeOrder(HASH_B, order(OWNER, 2), {
                    blockNumber: 111n,
                    logIndex: 0,
                });
                chain.push(add, removal);
                subs[1].onData({ result: served(removal) });
                expect(manager.report().orderbooks[0].buffered).toBe(1);
                block(110n);
                await vi.advanceTimersByTimeAsync(0);
                expect(orderManager.removeOrders).not.toHaveBeenCalled();

                // the poll reads past the start of the stream, the add goes in before the removal
                block(111n);
                await vi.waitFor(() => expect(orderManager.removeOrders).toHaveBeenCalledTimes(1));
                expect(orderManager.addOrder).toHaveBeenCalledTimes(2);
                expect(orderManager.addOrder.mock.calls[1][0].orderHash).toBe(HASH_B);
                expect(orderManager.addOrder.mock.invocationCallOrder[1]).toBeLessThan(
                    orderManager.removeOrders.mock.invocationCallOrder[0],
                );
                expect(sync.syncer.orders.get(HASH_B)?.active).toBe(false);
                expect(manager.stream.fallback).toBe(false);
                expect(manager.report().orderbooks[0].buffered).toBe(0);

                // with the stream back, its logs go to the syncer at once
                subs[1].onData({
                    result: served(
                        logs.deposit(OWNER, USDC, VAULT_1, 3n, { blockNumber: 112n, logIndex: 0 }),
                    ),
                });
                expect(manager.report().orderbooks[0].buffered).toBe(0);
                await sync.syncer.settled();
                expect(
                    orderManager.ledger.balance({
                        orderbook: ORDERBOOK,
                        owner: OWNER,
                        token: USDC,
                        vaultId: BigInt(VAULT_1),
                    }),
                ).toBe(1_003n);
                manager.close();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should add an order at once, and give it the meta that comes after it", async () => {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            const sync = manager.syncs.get(ORDERBOOK)!;
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;
            expect(orderManager.addOrder).toHaveBeenCalledTimes(1);

            // the add goes to the order manager with no wait, and with no meta
            const tx = ("0x" + "e".repeat(64)) as Hex;
            const at = (logIndex: number) => ({ blockNumber: 107n, logIndex, transactionHash: tx });
            subs[0].onData({ result: served(logs.addOrder(HASH_B, order(OWNER, 2), at(0))) });
            await vi.waitFor(() => expect(orderManager.addOrder).toHaveBeenCalledTimes(2));
            expect(orderManager.addOrder.mock.calls[1][0].meta).toBeUndefined();

            // the meta that comes after it updates the order
            subs[0].onData({ result: served(logs.meta(HASH_B, "0xabcd", at(1))) });
            await vi.waitFor(() =>
                expect(orderManager.updateOrderMeta).toHaveBeenCalledWith(
                    ORDERBOOK,
                    OWNER,
                    HASH_B,
                    "0xabcd",
                ),
            );
            expect(sync.syncer.orders.get(HASH_B)?.meta).toBe("0xabcd");
            expect(orderManager.addOrder).toHaveBeenCalledTimes(2);
        });

        it("should read the needs of a new order at once, not on the next block", async () => {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            await vi.waitFor(() => expect(subs).toHaveLength(1));
            subgraphManager.fetchSnapshotAt.mockResolvedValue([]);
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) block(n);
            await started;

            state.watchedTokens.set(USDC, { address: USDC, decimals: 6, symbol: "USDC" });
            state.watchedTokens.set(WETH, { address: WETH, decimals: 18, symbol: "WETH" });
            state.client.multicall.mockImplementation(async ({ contracts }: any) =>
                contracts.map(() => ({ status: "success", result: float(1n, 18) })),
            );
            // the add and its meta come in the same frame batch, no new block follows
            const tx = ("0x" + "e".repeat(64)) as Hex;
            const at = (logIndex: number) => ({ blockNumber: 106n, logIndex, transactionHash: tx });
            subs[0].onData({ result: served(logs.addOrder(HASH_B, order(OWNER, 2), at(0))) });
            subs[0].onData({ result: served(logs.meta(HASH_B, "0xabcd", at(1))) });
            await vi.waitFor(() => expect(orderManager.addOrder).toHaveBeenCalledTimes(1));
            expect(state.client.multicall).toHaveBeenCalledTimes(1);
            // the meta came while the add was parked, so the add applied with it
            expect(orderManager.addOrder.mock.calls[0][0].meta).toBe("0xabcd");
            expect(orderManager.updateOrderMeta).not.toHaveBeenCalled();
        });
    });

    it("should clear the last errors once they are reported", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        manager.stream.lastError = new Error("socket closed");
        manager.syncs.get(ORDERBOOK)!.lastError = new Error("decimals reverted");
        const first = manager.report();
        expect(first.stream.lastError).toBe("socket closed");
        expect(first.orderbooks[0].lastError).toBe("decimals reverted");
        const second = manager.report();
        expect(second.stream.lastError).toBeUndefined();
        expect(second.orderbooks[0].lastError).toBeUndefined();
    });

    it("should report the bad logs, and the failures and bad logs since the previous report", async () => {
        const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
        const { syncer } = manager.syncs.get(ORDERBOOK)!;
        // a log of a known event that does not decode
        syncer.onLog({
            ...logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 100n, logIndex: 0 }),
            data: "0x12",
        });
        const first = manager.report().orderbooks[0];
        expect(first.badLogs).toBe(1);
        expect(first.newBadLogs).toBe(1);
        expect(first.newFailures).toBe(0);
        // the totals stay, the counts since the previous report start over
        const second = manager.report().orderbooks[0];
        expect(second.badLogs).toBe(1);
        expect(second.newBadLogs).toBe(0);
    });

    describe("http mode", () => {
        /** The logs on the chain, the range query serves the ones in the range it asks for */
        let chain: RawLog[];
        /** The hash of a block, a fork of the block gets another hash */
        const hashOf = (n: bigint, fork = 0) =>
            ("0x" + (n * 10n + BigInt(fork)).toString(16).padStart(64, "0")) as Hex;
        const deposit = (n: bigint, amount: bigint, fork = 0, transactionHash?: Hex) => ({
            ...logs.deposit(OWNER, USDC, VAULT_1, amount, {
                blockNumber: n,
                logIndex: 0,
                transactionHash,
            }),
            blockHash: hashOf(n, fork),
        });
        const usdcBalance = () =>
            orderManager.ledger.balance({
                orderbook: ORDERBOOK,
                owner: OWNER,
                token: USDC,
                vaultId: BigInt(VAULT_1),
            });
        /** A sealed block from the http head watcher, resolves once its poll is done */
        const sealed = async (manager: EventSyncManager, n: bigint) => {
            const sync = manager.syncs.get(ORDERBOOK)!;
            block(n, true);
            await vi.waitFor(() => expect(manager.stream.pollFrom).toBe(n + 1n), { interval: 1 });
            await sync.syncer.settled();
        };
        /** A manager in http mode that went live off the snapshot at 103, its poll read up to 106 */
        const live = async () => {
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            manager.open();
            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) await sealed(manager, n);
            await started;
            return manager;
        };

        beforeEach(() => {
            state.appOptions.wsRpc = undefined;
            chain = [];
            state.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: any) =>
                chain.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
            );
        });

        it("should read the logs on each sealed block, start off the snapshot and go live", async () => {
            chain = [deposit(100n, 999n)];
            for (let n = 101n; n <= 106n; n++) chain.push(deposit(n, n));
            const manager = await init({ includeOrderbooks: new Set([ORDERBOOK]) });
            expect(manager.mode).toBe("http");
            manager.open();
            expect(state.getWsClient).not.toHaveBeenCalled();
            expect(subs).toHaveLength(0);

            const started = manager.start();
            for (let n = 100n; n <= 106n; n++) await sealed(manager, n);
            const { reports } = await started;
            // the first poll read the head only, the coverage starts there, and
            // each poll after it read the new block and the blocks before it again
            expect(state.client.getLogs.mock.calls[0][0]).toMatchObject({
                address: [ORDERBOOK],
                events: SYNC_EVENTS,
                fromBlock: 100n,
                toBlock: 100n,
            });
            expect(state.client.getLogs.mock.calls[1][0]).toMatchObject({
                fromBlock: 100n,
                toBlock: 101n,
            });
            expect(subgraphManager.fetchSnapshotAt).toHaveBeenCalledWith(URL, 103n, ORDERBOOK);
            expect(reports.get(ORDERBOOK)?.snapshotBlock).toBe(103n);
            expect(orderManager.addOrder).toHaveBeenCalledTimes(1);
            // the deposits above the snapshot block landed once, the reads again dropped
            expect(usdcBalance()).toBe(1_000n + 104n + 105n + 106n);

            chain.push(deposit(107n, 7n));
            await sealed(manager, 107n);
            await sealed(manager, 108n);
            expect(usdcBalance()).toBe(1_000n + 104n + 105n + 106n + 7n);
            const report = manager.report();
            expect(report.mode).toBe("http");
            expect(report.stream.reorged).toBe(0);
            expect(report.orderbooks[0]).toMatchObject({ orderbook: ORDERBOOK, phase: "live" });
        });

        it("should undo the logs of a block that a reorg replaced", async () => {
            const manager = await live();
            chain.push(deposit(107n, 40n));
            await sealed(manager, 107n);
            expect(usdcBalance()).toBe(1_040n);

            // block 107 is replaced, with another deposit in it
            chain = chain.filter((log) => log.blockNumber !== 107n);
            chain.push(deposit(107n, 7n, 1, HASH_B));
            await sealed(manager, 108n);
            expect(usdcBalance()).toBe(1_007n);
            expect(manager.report().stream.reorged).toBe(1);

            // the reads again that follow change nothing
            await sealed(manager, 109n);
            expect(usdcBalance()).toBe(1_007n);
            expect(manager.report().stream.reorged).toBe(1);
        });

        it("should apply the new data of a log that a reorg kept at the same transaction and index", async () => {
            const manager = await live();
            chain.push(deposit(107n, 40n));
            await sealed(manager, 107n);
            expect(usdcBalance()).toBe(1_040n);

            // the same transaction at the same index of a new block 107, with another amount
            chain = [deposit(107n, 7n, 1)];
            expect(chain[0].transactionHash).toBe(deposit(107n, 40n).transactionHash);
            await sealed(manager, 108n);
            expect(usdcBalance()).toBe(1_007n);
            expect(manager.report().stream.reorged).toBe(1);

            await sealed(manager, 109n);
            expect(usdcBalance()).toBe(1_007n);
        });

        it("should read the block hash when a read again gives no logs for a block", async () => {
            const manager = await live();
            chain.push(deposit(107n, 40n));
            await sealed(manager, 107n);
            expect(usdcBalance()).toBe(1_040n);
            chain = [];

            // the block cannot be read, the logs stay
            state.client.getBlock.mockRejectedValueOnce(new Error("unknown block"));
            await sealed(manager, 108n);
            expect(state.client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 107n });
            expect(usdcBalance()).toBe(1_040n);

            // the block is the same one, a node that lags served the range, the logs stay
            state.client.getBlock.mockResolvedValueOnce({ hash: hashOf(107n) });
            await sealed(manager, 109n);
            expect(usdcBalance()).toBe(1_040n);

            // the block is another one, the logs are undone
            state.client.getBlock.mockResolvedValueOnce({ hash: hashOf(107n, 1) });
            await sealed(manager, 110n);
            expect(usdcBalance()).toBe(1_000n);
            expect(manager.report().stream.reorged).toBe(1);

            // the block is forgotten, it is not read again
            await sealed(manager, 111n);
            expect(state.client.getBlock).toHaveBeenCalledTimes(3);
        });

        it("should add an order with its meta, and remove it when a reorg removes the add", async () => {
            const manager = await live();
            const at = (logIndex: number) => ({
                blockNumber: 107n,
                logIndex,
                transactionHash: HASH_B,
            });
            chain.push(
                { ...logs.addOrder(HASH_B, order(OWNER, 2), at(0)), blockHash: hashOf(107n) },
                { ...logs.meta(HASH_B, "0xabcd", at(1)), blockHash: hashOf(107n) },
            );
            await sealed(manager, 107n);
            expect(orderManager.addOrder).toHaveBeenCalledTimes(2);
            const added = orderManager.addOrder.mock.calls[1][0];
            expect(added.orderHash).toBe(HASH_B);
            // the add goes in at once, the meta right after it updates the order
            expect(orderManager.updateOrderMeta).toHaveBeenCalledWith(
                ORDERBOOK,
                OWNER,
                HASH_B,
                "0xabcd",
            );

            // block 107 is replaced by one with no logs of the orderbook
            chain = [];
            state.client.getBlock.mockResolvedValue({ hash: hashOf(107n, 1) });
            await sealed(manager, 108n);
            expect(orderManager.removeOrders).toHaveBeenCalledTimes(1);
            expect(orderManager.removeOrders.mock.calls[0][0][0].orderHash).toBe(HASH_B);
            expect(manager.report().stream.reorged).toBe(2);
        });

        it("should pick up a log that a node that lags did not serve the first time", async () => {
            const manager = await live();
            await sealed(manager, 107n);
            chain.push(deposit(107n, 40n));
            await sealed(manager, 108n);
            await sealed(manager, 109n);
            expect(usdcBalance()).toBe(1_040n);
            expect(manager.report().stream.reorged).toBe(0);
        });

        it("should try a failed poll again on the next block from the same block", async () => {
            const manager = await live();
            state.client.getLogs.mockRejectedValueOnce(new Error("rate limited"));
            block(107n, true);
            await vi.waitFor(() => expect(manager.report().stream.lastError).toBe("rate limited"));
            expect(manager.report().stream.lastError).toBeUndefined();
            expect(manager.stream.pollFrom).toBe(107n);

            chain.push(deposit(107n, 40n));
            await sealed(manager, 150n);
            expect(state.client.getLogs).toHaveBeenLastCalledWith(
                expect.objectContaining({ fromBlock: 100n, toBlock: 150n }),
            );
            expect(usdcBalance()).toBe(1_040n);

            // far from the first block, a poll reads POLL_REREAD_BLOCKS blocks again
            await sealed(manager, 151n);
            expect(state.client.getLogs).toHaveBeenLastCalledWith(
                expect.objectContaining({ fromBlock: 151n - POLL_REREAD_BLOCKS, toBlock: 151n }),
            );
        });

        it("should name the orderbook and the last poll error when the start fails, and not reject", async () => {
            state.client.getLogs.mockRejectedValue(new Error("getLogs is disabled"));
            const manager = await EventSyncManager.init({
                state,
                orderManager,
                subgraphManager,
                filters: { includeOrderbooks: new Set([ORDERBOOK]) },
                startTimeout: 20,
            });
            manager.open();
            const started = manager.start();
            block(100n, true);
            const { reports, failed } = await started;
            expect(reports.size).toBe(0);
            expect(failed.get(ORDERBOOK)).toBe(
                `orderbook ${ORDERBOOK}: the log sync did not go live within 20ms, last log source error: getLogs is disabled`,
            );
            manager.close();
        });
    });
});

// the mock type is only for the casts above
export type { Mock };
