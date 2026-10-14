import { ABI } from "../common";
import { describe, it, expect, vi } from "vitest";
import { AbiEvent, getAbiItem, toEventSelector } from "viem";
import { logs, ORDERBOOK, OWNER, USDC, VAULT_1 } from "./fixtures";
import {
    LOGS_RANGE_CHUNK,
    fetchOrderbookLogs,
    subscribeToOrderbookLogs,
    SYNC_EVENTS,
    SYNC_TOPICS,
    toRawLog,
} from "./stream";

/** The events the sync reads of a v5 or v6 orderbook, every one of them must be in the filter */
const SYNC_EVENT_NAMES = [
    "AddOrderV3",
    "RemoveOrderV3",
    "DepositV2",
    "WithdrawV2",
    "TakeOrderV3",
    "ClearV3",
    "AfterClearV2",
    "MetaV1_2",
] as const;

/** The events the sync reads of a v4 orderbook, it emits no meta */
const SYNC_EVENT_NAMES_V4 = [
    "AddOrderV2",
    "RemoveOrderV2",
    "Deposit",
    "Withdraw",
    "TakeOrderV2",
    "ClearV2",
    "AfterClear",
] as const;

describe("Test the sync filter", () => {
    it("should hold the selectors of every sync event, as one list at the first topic", () => {
        // the selectors off the full orderbook abi, so the filter is checked
        // against the contract, not against the list it was built from
        const selectors = [
            ...SYNC_EVENT_NAMES.map((name) =>
                toEventSelector(
                    getAbiItem({ abi: ABI.Orderbook.V6.Primary.Orderbook, name }) as AbiEvent,
                ),
            ),
            ...SYNC_EVENT_NAMES_V4.map((name) =>
                toEventSelector(
                    getAbiItem({ abi: ABI.Orderbook.V4.Primary.Orderbook, name }) as AbiEvent,
                ),
            ),
        ];
        // one nested list, any of the selectors at topic zero, not one per position
        expect(SYNC_TOPICS).toHaveLength(1);
        expect([...SYNC_TOPICS[0]].sort()).toEqual([...selectors].sort());
        expect(new Set(selectors).size).toBe(selectors.length);
        expect(SYNC_EVENTS.map((event) => event.name).sort()).toEqual(
            [...SYNC_EVENT_NAMES, ...SYNC_EVENT_NAMES_V4].sort(),
        );
    });
});

describe("Test toRawLog", () => {
    const served = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 10n, logIndex: 2 });

    it("should read a log as a subscription serves it, the numbers as hex strings", () => {
        const raw = toRawLog({
            ...served,
            blockNumber: "0xa",
            logIndex: "0x2",
            removed: false,
        });
        expect(raw).toEqual({ ...served, blockNumber: 10n, logIndex: 2, removed: false });
    });

    it("should read a log as a range query serves it, the numbers as a bigint and a number", () => {
        const raw = toRawLog({ ...served, removed: true });
        expect(raw).toEqual({ ...served, removed: true });
    });

    it("should keep the block hash lower cased when the log has one", () => {
        const blockHash = ("0x" + "AB".repeat(32)) as `0x${string}`;
        expect(toRawLog({ ...served, blockHash })?.blockHash).toBe(blockHash.toLowerCase());
        expect(toRawLog({ ...served, blockHash: null })).not.toHaveProperty("blockHash");
    });

    it("should leave out a pending log and anything that is not a log", () => {
        expect(toRawLog({ ...served, blockNumber: null, logIndex: null })).toBeUndefined();
        expect(toRawLog({ ...served, topics: "0x" })).toBeUndefined();
        expect(toRawLog(undefined)).toBeUndefined();
        expect(toRawLog("0x")).toBeUndefined();
    });
});

describe("Test subscribeToOrderbookLogs", () => {
    /** A ws client whose transport records the subscription it is asked for */
    const fakeClient = () => {
        const subs: any[] = [];
        const unsubscribe = vi.fn().mockResolvedValue(undefined);
        const client = {
            transport: {
                subscribe: vi.fn(async (args: any) => {
                    subs.push(args);
                    return { unsubscribe };
                }),
            },
        } as any;
        return { client, subs, unsubscribe };
    };

    it("should subscribe to the logs of the orderbook and hand every log over as raw", async () => {
        const { client, subs } = fakeClient();
        const onLog = vi.fn();
        const onError = vi.fn();
        subscribeToOrderbookLogs(client, [ORDERBOOK], onLog, onError);
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params).toEqual(["logs", { address: [ORDERBOOK], topics: SYNC_TOPICS }]);

        const served = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 10n, logIndex: 2 });
        subs[0].onData({ result: { ...served, blockNumber: "0xa", logIndex: "0x2" } });
        subs[0].onData({
            result: { ...served, blockNumber: "0xa", logIndex: "0x2", removed: true },
        });
        subs[0].onData({ result: null }); // a pending log, dropped
        expect(onLog).toHaveBeenCalledTimes(2);
        expect(onLog.mock.calls[0][0]).toEqual({ ...served, removed: false });
        expect(onLog.mock.calls[1][0]).toEqual({ ...served, removed: true });

        subs[0].onError(new Error("dropped"));
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("should subscribe to the pending logs when told to take the flashblocks", async () => {
        const { client, subs } = fakeClient();
        subscribeToOrderbookLogs(client, [ORDERBOOK], vi.fn(), vi.fn(), true);
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        expect(subs[0].params).toEqual([
            "pendingLogs",
            { address: [ORDERBOOK], topics: SYNC_TOPICS },
        ]);
    });

    it("should stop handing logs over once unsubscribed, and close the subscription", async () => {
        const { client, subs, unsubscribe } = fakeClient();
        const onLog = vi.fn();
        const stop = subscribeToOrderbookLogs(client, [ORDERBOOK], onLog, vi.fn());
        await vi.waitFor(() => expect(subs).toHaveLength(1));
        stop();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        const served = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 10n, logIndex: 2 });
        subs[0].onData({ result: served });
        expect(onLog).not.toHaveBeenCalled();
    });

    it("should report a subscription that cannot open", async () => {
        const client = {
            transport: { subscribe: vi.fn().mockRejectedValue(new Error("no ws")) },
        } as any;
        const onError = vi.fn();
        subscribeToOrderbookLogs(client, [ORDERBOOK], vi.fn(), onError);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    });
});

describe("Test fetchOrderbookLogs", () => {
    it("should query the range in chunks and hand the logs over in order", async () => {
        const getLogs = vi.fn(async ({ fromBlock }: any) => [
            logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: fromBlock, logIndex: 0 }),
            logs.deposit(OWNER, USDC, VAULT_1, 2n, { blockNumber: fromBlock, logIndex: 1 }),
        ]);
        const client = { getLogs } as any;
        const onLog = vi.fn();
        const from = 100n;
        const to = from + LOGS_RANGE_CHUNK * 2n + 10n;
        const count = await fetchOrderbookLogs(client, [ORDERBOOK], from, to, onLog);

        // three chunks cover the range, the last one short
        expect(getLogs.mock.calls.map((call) => [call[0].fromBlock, call[0].toBlock])).toEqual([
            [from, from + LOGS_RANGE_CHUNK - 1n],
            [from + LOGS_RANGE_CHUNK, from + 2n * LOGS_RANGE_CHUNK - 1n],
            [from + 2n * LOGS_RANGE_CHUNK, to],
        ]);
        // every query is for the orderbook and the sync events only
        expect(
            getLogs.mock.calls.every(
                (call) =>
                    call[0].address.length === 1 &&
                    call[0].address[0] === ORDERBOOK &&
                    call[0].events === SYNC_EVENTS,
            ),
        ).toBe(true);
        expect(count).toBe(6);
        expect(onLog.mock.calls.map((call) => call[0].logIndex)).toEqual([0, 1, 0, 1, 0, 1]);
    });

    it("should do nothing for an empty range", async () => {
        const getLogs = vi.fn();
        await fetchOrderbookLogs({ getLogs } as any, [ORDERBOOK], 10n, 9n, vi.fn());
        expect(getLogs).not.toHaveBeenCalled();
    });
});
