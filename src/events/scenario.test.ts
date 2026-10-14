import { Result } from "../common";
import { VaultLedger } from "./ledger";
import { toOrderBytes } from "./decode";
import { EventSyncManager } from "./manager";
import { SubgraphVersions } from "../subgraph/types";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    float,
    logs,
    order,
    ORDERBOOK,
    OWNER,
    USDC,
    WETH,
    VAULT_1,
    VAULT_2,
    HASH_A,
    HASH_B,
    USDC_DETAILS,
    WETH_DETAILS,
} from "./fixtures";

/**
 * The whole log sync end to end, the manager over a fake ws transport, the
 * real syncer, ingestor and ledger, a fake subgraph and a fake chain, once over
 * a logs subscription and once over a pendingLogs one, the flashblocks. The
 * difference between the two is when the logs of a block come against the
 * sealed head: a logs subscription serves them once the block is sealed, the
 * pending one while the block is being built, one ahead of the sealed head.
 * Every scenario checks the one invariant that matters, each event counts
 * exactly once, whatever came in the snapshot, the buffer, the live stream or
 * the poll that stands in while the subscription is down
 */

const URL = "https://sg.example/v6";
const HASH_C = ("0x" + "c".repeat(64)) as `0x${string}`;
const HASH_D = ("0x" + "d".repeat(64)) as `0x${string}`;
const OTHER_OWNER = "0x0000000000000000000000000000000000000b22" as `0x${string}`;
const ZERO_HASH = ("0x" + "0".repeat(64)) as `0x${string}`;
const ONE_WETH = 10n ** 18n;

/** A vault of the owner, for the balance reads */
const vault = (owner: `0x${string}`, token: `0x${string}`, vaultId: `0x${string}`) => ({
    orderbook: ORDERBOOK,
    owner,
    token,
    vaultId: BigInt(vaultId),
});

/** An order as the subgraph serves it, with the balances at the snapshot block */
const sgOrder = (
    hash: `0x${string}`,
    nonce: number,
    usdc: bigint,
    weth: bigint,
    meta?: `0x${string}`,
) => ({
    __version: SubgraphVersions.V6,
    id: hash,
    owner: OWNER,
    orderHash: hash,
    orderBytes: toOrderBytes(order(OWNER, nonce)),
    active: true,
    nonce: order(OWNER, nonce).nonce,
    orderbook: { id: ORDERBOOK },
    meta,
    inputs: [{ balance: float(usdc, 6), vaultId: BigInt(VAULT_1).toString(), token: USDC_DETAILS }],
    outputs: [
        { balance: float(weth, 18), vaultId: BigInt(VAULT_2).toString(), token: WETH_DETAILS },
    ],
});

describe.each([
    ["logs", false],
    ["pendingLogs", true],
])("Test the log sync end to end over a %s subscription", (method, flashblocks) => {
    let subs: any[];
    let blockListeners: ((block: bigint) => void)[];
    let state: any;
    let orderManager: any;
    let subgraphManager: any;
    /** Every log the chain holds, the range queries answer from it */
    let chain: any[];

    /**
     * The changes of the owner's usdc vault the chain holds up to the start,
     * by block, the snapshot answers from it, the balance at a block is the
     * base plus the changes at or below the block
     */
    const USDC_BASE = 1_000n;
    const usdcHistory: [bigint, bigint][] = [
        [100n, 5n], // hidden, the stream opened after it, the snapshot holds it
        [100n, 999n],
        [101n, 10n],
        [104n, 100n],
        [106n, 20n], // the take pays 20 usdc in
    ];
    const WETH_BASE = 5n * ONE_WETH;
    const wethHistory: [bigint, bigint][] = [[106n, -ONE_WETH]]; // the take takes 1 weth out
    const at = (history: [bigint, bigint][], base: bigint, block: bigint) =>
        history.filter(([b]) => b <= block).reduce((sum, [, d]) => sum + d, base);

    /** A log as the subscription serves it, the numbers as hex strings */
    const served = (log: any, removed = false) => ({
        ...log,
        blockNumber: `0x${log.blockNumber.toString(16)}`,
        logIndex: `0x${log.logIndex.toString(16)}`,
        blockHash: flashblocks ? ZERO_HASH : `0x${"f".repeat(64)}`,
        removed,
    });
    /** Serves a log over the open subscription and records it on the chain */
    const serve = (log: any) => {
        chain.push(log);
        subs[subs.length - 1].onData({ result: served(log) });
    };
    /** Seals a block, the head watcher reports it over ws, or polled while the socket is down */
    const seal = (n: bigint, polled = false) => {
        state.canonicalBlockNumber = n;
        if (!polled) state.wsBlockNumber = n;
        blockListeners.forEach((listener) => listener(n));
    };
    /**
     * A block happens with the given logs. Over a logs subscription the head
     * seals first and its logs follow, over a pending one the logs come while
     * the block is built, the head below it sealed
     */
    const produce = (n: bigint, blockLogs: any[]) => {
        seal(flashblocks ? n - 1n : n);
        blockLogs.forEach(serve);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        subs = [];
        blockListeners = [];
        chain = [];
        const wsClient = {
            transport: {
                subscribe: vi.fn(async (args: any) => {
                    subs.push(args);
                    return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
                }),
            },
        };
        state = {
            appOptions: { flashblocks, wsRpc: "wss://rpc.example" },
            canonicalBlockNumber: 0n,
            wsBlockNumber: 0n,
            watchedTokens: new Map([
                [USDC, USDC_DETAILS],
                [WETH, WETH_DETAILS],
            ]),
            watchToken: vi.fn(),
            getWsClient: vi.fn(() => wsClient),
            openWsSocket: vi.fn(),
            onBlockNumber: vi.fn((listener: any) => {
                blockListeners.push(listener);
                return () => blockListeners.splice(blockListeners.indexOf(listener), 1);
            }),
            client: {
                readContract: vi.fn(async ({ functionName }: any) => {
                    throw new Error(`unexpected read ${functionName}`);
                }),
                // the other owner's vaults hold 50 usdc and 7 weth on chain
                multicall: vi.fn(async ({ contracts }: any) =>
                    contracts.map(({ args }: any) => ({
                        status: "success",
                        result: args[1] === USDC ? float(50n, 6) : float(7n, 18),
                    })),
                ),
                getLogs: vi.fn(async ({ fromBlock, toBlock }: any) =>
                    chain.filter(
                        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
                    ),
                ),
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
            getOrderbooksByUrl: vi.fn().mockResolvedValue(new Map([[URL, new Set([ORDERBOOK])]])),
            subgraphs: [URL],
            getSubgraphVersion: vi.fn(() => SubgraphVersions.V6),
            getIndexedBlock: vi.fn().mockResolvedValue(10_000),
            // the state at the block, order A always, order B once added at 102
            fetchSnapshotAt: vi.fn(async (_url: string, block: bigint) => {
                const usdc = at(usdcHistory, USDC_BASE, block);
                const weth = at(wethHistory, WETH_BASE, block);
                const orders = [sgOrder(HASH_A, 1, usdc, weth)];
                if (block >= 102n) orders.push(sgOrder(HASH_B, 2, usdc, weth, "0xb0b0"));
                return orders;
            }),
        };
    });

    it("should start off the snapshot mid block, replay the buffer, run live, survive a reorg and a drop, and count every event once", async () => {
        const manager = await EventSyncManager.init({
            state,
            orderManager,
            subgraphManager,
            resubscribeDelay: 10,
        });
        manager.open();
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params[0]).toBe(method);
        const started = manager.start();

        // the stream opens in the middle of block 100, its first log is the
        // second deposit of the block, the first one is only in the snapshot
        chain.push(logs.deposit(OWNER, USDC, VAULT_1, 5n, { blockNumber: 100n, logIndex: 0 }));
        produce(100n, [
            logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 100n, logIndex: 5 }),
        ]);
        produce(101n, [
            logs.deposit(OWNER, USDC, VAULT_1, 10n, { blockNumber: 101n, logIndex: 0 }),
        ]);
        // order B is added with its meta, the snapshot block is above it so
        // the snapshot carries it and the buffered add is dropped
        const tx102 = ("0x" + "102".padStart(64, "0")) as `0x${string}`;
        produce(102n, [
            logs.addOrder(HASH_B, order(OWNER, 2), {
                blockNumber: 102n,
                logIndex: 0,
                transactionHash: tx102,
            }),
            logs.meta(HASH_B, "0xb0b0", { blockNumber: 102n, logIndex: 1, transactionHash: tx102 }),
        ]);
        produce(103n, []);
        produce(104n, [
            logs.deposit(OWNER, USDC, VAULT_1, 100n, { blockNumber: 104n, logIndex: 0 }),
        ]);
        // order C is added above the snapshot block, it replays with its meta
        const tx105 = ("0x" + "105".padStart(64, "0")) as `0x${string}`;
        produce(105n, [
            logs.addOrder(HASH_C, order(OWNER, 3), {
                blockNumber: 105n,
                logIndex: 0,
                transactionHash: tx105,
            }),
            logs.meta(HASH_C, "0xc0c0", { blockNumber: 105n, logIndex: 1, transactionHash: tx105 }),
        ]);
        // a take of order A, 1 weth out of vault 2, 20 usdc into vault 1
        produce(106n, [
            logs.takeOrder(order(), float(ONE_WETH, 18), float(20n, 6), {
                blockNumber: 106n,
                logIndex: 0,
            }),
        ]);
        if (flashblocks) seal(106n);

        const { reports } = await started;
        const report = reports.get(ORDERBOOK)!;
        // the first block seen is 100 over logs, 99 over pending logs since the
        // head watcher reported the sealed block below the one being built
        expect(report.snapshotBlock).toBe(flashblocks ? 102n : 103n);
        expect(subgraphManager.fetchSnapshotAt).toHaveBeenCalledWith(
            URL,
            report.snapshotBlock,
            ORDERBOOK,
        );
        const sync = manager.syncs.get(ORDERBOOK)!;
        expect(sync.syncer.phase).toBe("live");

        // A and B came off the snapshot, C off the replay with its meta
        expect(orderManager.addOrder.mock.calls.map((call: any) => call[0].orderHash)).toEqual([
            HASH_A,
            HASH_B,
            HASH_C,
        ]);
        expect(orderManager.addOrder.mock.calls[1][0].meta).toBe("0xb0b0");
        expect(orderManager.addOrder.mock.calls[2][0].meta).toBe("0xc0c0");
        // every change once, the hidden one through the snapshot
        const usdcAfterStart = USDC_BASE + 5n + 999n + 10n + 100n + 20n;
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdcAfterStart);
        expect(orderManager.ledger.balance(vault(OWNER, WETH, VAULT_2))).toBe(WETH_BASE - ONE_WETH);
        expect(sync.syncer.needs()).toEqual({ tokens: [], vaults: [] });

        // live, a withdrawal and the removal of B
        produce(107n, [
            logs.withdraw(OWNER, USDC, VAULT_1, 50n, 6, { blockNumber: 107n, logIndex: 0 }),
            logs.removeOrder(HASH_B, order(OWNER, 2), { blockNumber: 107n, logIndex: 1 }),
        ]);
        await sync.syncer.settled();
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdcAfterStart - 50n);
        expect(orderManager.removeOrders).toHaveBeenCalledTimes(1);
        expect(orderManager.removeOrders.mock.calls[0][0][0].orderHash).toBe(HASH_B);
        expect(sync.syncer.orders.get(HASH_B)?.active).toBe(false);

        // a deposit the chain removes again in a reorg, a logs subscription flags
        // the removed log, a pending one sends no removal for it, so the
        // deposit stays, a case we accept as rare
        let usdc = usdcAfterStart - 50n;
        const deposit108 = logs.deposit(OWNER, USDC, VAULT_1, 7n, {
            blockNumber: 108n,
            logIndex: 0,
        });
        produce(108n, [deposit108]);
        if (!flashblocks) {
            subs[0].onData({ result: served(deposit108, true) });
            chain.pop();
        } else {
            usdc += 7n;
        }
        await sync.syncer.settled();
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdc);

        // the socket dies after a deposit at 109, block 110 seals while it is
        // down and holds a deposit the stream never served, the poll stands in
        produce(109n, [logs.deposit(OWNER, USDC, VAULT_1, 3n, { blockNumber: 109n, logIndex: 0 })]);
        subs[0].onError(new Error("socket closed"));
        chain.push(logs.deposit(OWNER, USDC, VAULT_1, 4n, { blockNumber: 110n, logIndex: 0 }));
        seal(109n, true);
        await vi.advanceTimersByTimeAsync(0);
        seal(110n, true);
        await vi.advanceTimersByTimeAsync(0);
        await sync.syncer.settled();
        // the deposit of 109 came twice and counted once, the one of 110 landed
        // while the socket was still down
        usdc += 3n + 4n;
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdc);
        // the poll started at the last log, and read the blocks below again
        expect(state.client.getLogs.mock.calls[0][0]).toMatchObject({
            fromBlock: 101n,
            toBlock: 109n,
        });

        // the new stream is on at 110, the poll reads up to two blocks past it
        // and then the stream takes over
        await vi.advanceTimersByTimeAsync(10);
        await vi.waitFor(() => expect(subs).toHaveLength(2));
        expect(subs[1].params[0]).toBe(method);
        produce(111n, []);
        await vi.advanceTimersByTimeAsync(0);
        produce(112n, []);
        await vi.advanceTimersByTimeAsync(0);
        if (flashblocks) seal(112n);
        await vi.waitFor(() => expect(manager.stream.fallback).toBe(false));
        const polls = state.client.getLogs.mock.calls.length;
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdc);

        // an order of another owner on vaults the sync never saw, the add parks,
        // the balances are read at the block and the order goes through
        produce(113n, [
            logs.addOrder(HASH_D, order(OTHER_OWNER), { blockNumber: 113n, logIndex: 0 }),
        ]);
        // the vaults are read once a sealed head is at or above the block of the
        // add, over logs the head of 113 sealed before its logs came, over
        // pending logs the seal of 113 comes after them
        if (flashblocks) seal(113n);
        const readAt = 113n;
        await vi.waitFor(() => expect(orderManager.addOrder).toHaveBeenCalledTimes(4));
        expect(orderManager.addOrder.mock.calls[3][0].orderHash).toBe(HASH_D);
        // both vaults in one multicall at the sealed head, no other read
        expect(state.client.readContract).not.toHaveBeenCalled();
        expect(state.client.multicall).toHaveBeenCalledTimes(1);
        const [multicall] = state.client.multicall.mock.calls[0];
        expect(multicall.blockNumber).toBe(readAt);
        expect(multicall.contracts).toHaveLength(2);
        expect(orderManager.ledger.balance(vault(OTHER_OWNER, USDC, VAULT_1))).toBe(50n);
        // a deposit on the new vault lands on the read baseline
        produce(115n, [
            logs.deposit(OTHER_OWNER, USDC, VAULT_1, 8n, { blockNumber: 115n, logIndex: 0 }),
        ]);
        await sync.syncer.settled();
        expect(orderManager.ledger.balance(vault(OTHER_OWNER, USDC, VAULT_1))).toBe(58n);
        // the owner's vault is untouched by all of it
        expect(orderManager.ledger.balance(vault(OWNER, USDC, VAULT_1))).toBe(usdc);

        // the stream is the source since the handover, no more range queries
        expect(state.client.getLogs).toHaveBeenCalledTimes(polls);
        const final = manager.report();
        expect(final.stream).toMatchObject({ drops: 1, backfilled: 2 });
        expect(final.orderbooks[0].phase).toBe("live");
        expect(final.orderbooks[0].needs).toEqual({ tokens: 0, vaults: 0 });
        expect(sync.syncer.stats.failed).toBe(0);
        manager.close();
    });
});
