import { IngestedEvent, LogIngestor } from "./ingestor";
import { describe, it, expect, beforeEach } from "vitest";
import {
    logs,
    order,
    float,
    OWNER,
    USDC,
    WETH,
    HASH_A,
    HASH_B,
    VAULT_1,
    VAULT_3,
    ORDERBOOK,
    Where,
} from "./fixtures";

describe("Test LogIngestor", () => {
    let ingestor: LogIngestor;
    let live: IngestedEvent[];

    beforeEach(() => {
        live = [];
        ingestor = new LogIngestor(ORDERBOOK, (event) => live.push(event));
    });

    it("should ignore logs of another address and events it does not read", () => {
        ingestor.push({
            ...logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }),
            address: "0x0000000000000000000000000000000000000ffe",
        });
        ingestor.push(logs.orderNotFound(HASH_A, { blockNumber: 1n, logIndex: 1 }));
        expect(ingestor.buffered).toEqual([]);
    });

    it("should drop a log it has seen, by transaction hash and log index, whatever its letter case", () => {
        const log = logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 });
        ingestor.push(log);
        ingestor.push({ ...log });
        // the same log served in upper case hex is the same log
        const upper = (hex: string) => ("0x" + hex.slice(2).toUpperCase()) as `0x${string}`;
        ingestor.push({
            ...log,
            address: upper(log.address),
            transactionHash: upper(log.transactionHash),
            topics: log.topics.map(upper),
            data: upper(log.data),
        });
        expect(ingestor.buffered).toHaveLength(1);
    });

    it("should read a log served in upper case hex and lower case what it keeps", () => {
        const upper = (hex: string) => ("0x" + hex.slice(2).toUpperCase()) as `0x${string}`;
        const log = logs.deposit(OWNER, USDC, VAULT_1, 7n, { blockNumber: 1n, logIndex: 0 });
        ingestor.push({
            ...log,
            address: upper(log.address),
            transactionHash: upper(log.transactionHash),
            topics: log.topics.map(upper),
            data: upper(log.data),
        });
        const [{ event }] = ingestor.buffered;
        expect(event.type).toBe("Deposit");
        expect(event.orderbook).toBe(ORDERBOOK);
        expect(event.ref.transactionHash).toBe(log.transactionHash);
        expect((event as any).changes[0].vault).toEqual({
            orderbook: ORDERBOOK,
            owner: OWNER,
            token: USDC,
            vaultId: BigInt(VAULT_1),
        });
    });

    it("should buffer in chain order and drain only the events above the given block", () => {
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 3n, { blockNumber: 12n, logIndex: 0 }));
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 10n, logIndex: 5 }));
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 2n, { blockNumber: 10n, logIndex: 7 }));
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 4n, { blockNumber: 11n, logIndex: 0 }));
        expect(live).toEqual([]);

        const drained = ingestor.drain(10n);
        expect(drained.map(({ event }) => event.ref.blockNumber)).toEqual([11n, 12n]);
        expect(drained.every(({ reverted }) => !reverted)).toBe(true);
        expect(ingestor.buffered).toEqual([]);
    });

    it("should hand events to the listener once live", () => {
        ingestor.goLive();
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }));
        expect(live).toHaveLength(1);
        expect(live[0].event.type).toBe("Deposit");
        expect(ingestor.buffered).toEqual([]);
    });

    it("should pair the two halves of a clear into one event, whichever comes first", () => {
        ingestor.goLive();
        const tx = ("0x" + "c".repeat(64)) as `0x${string}`;
        const change = {
            aliceOutput: float(1n, 18),
            bobOutput: float(1n, 6),
            aliceInput: float(1n, 6),
            bobInput: float(1n, 18),
        };
        const start = logs.clear(
            order(),
            order(),
            { alice: VAULT_3, bob: VAULT_3 },
            {
                blockNumber: 5n,
                logIndex: 1,
                transactionHash: tx,
            },
        );
        const after = logs.afterClear(change, {
            blockNumber: 5n,
            logIndex: 2,
            transactionHash: tx,
        });

        ingestor.push(start);
        expect(live).toEqual([]);
        ingestor.push(after);
        expect(live).toHaveLength(1);
        // the pair leaves no key behind in the waiting halves
        expect((ingestor as any).clearStarts.size).toBe(0);
        expect((ingestor as any).afterClears.size).toBe(0);
        expect(live[0].event.type).toBe("Clear");
        expect(live[0].event.ref).toEqual({ blockNumber: 5n, logIndex: 2, transactionHash: tx });
        expect((live[0].event as any).changes).toHaveLength(8);

        // and the other way round, for another transaction
        const tx2 = ("0x" + "d".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.afterClear(change, { blockNumber: 6n, logIndex: 2, transactionHash: tx2 }),
        );
        expect(live).toHaveLength(1);
        ingestor.push(
            logs.clear(
                order(),
                order(),
                { alice: VAULT_3, bob: VAULT_3 },
                {
                    blockNumber: 6n,
                    logIndex: 1,
                    transactionHash: tx2,
                },
            ),
        );
        expect(live).toHaveLength(2);
    });

    it("should pair the clears of one transaction by adjacency, whatever order they arrive in", () => {
        ingestor.goLive();
        const tx = ("0x" + "1".repeat(64)) as `0x${string}`;
        const at = (logIndex: number) => ({ blockNumber: 5n, logIndex, transactionHash: tx });
        const bounty = { alice: VAULT_3, bob: VAULT_3 };
        const change = (units: bigint) => ({
            aliceOutput: float(units, 18),
            bobOutput: float(units, 6),
            aliceInput: float(units, 6),
            bobInput: float(units, 18),
        });
        // two clears in one multicall, log indexes 1 and 2, then 3 and 4, the
        // second start arrives before the first after clear
        ingestor.push(logs.clear(order(), order(), bounty, at(1)));
        ingestor.push(logs.clear(order(), order(), bounty, at(3)));
        ingestor.push(logs.afterClear(change(1n), at(2)));
        expect(live).toHaveLength(1);
        expect(live[0].event.ref.logIndex).toBe(2);
        expect((live[0].event as any).changes[0].amount).toEqual({ float: float(1n, 18) });

        ingestor.push(logs.afterClear(change(2n), at(4)));
        expect(live).toHaveLength(2);
        expect(live[1].event.ref.logIndex).toBe(4);
        expect((live[1].event as any).changes[0].amount).toEqual({ float: float(2n, 18) });

        // and both after clears first, then both starts, in reverse
        const tx2 = ("0x" + "2".repeat(64)) as `0x${string}`;
        const at2 = (logIndex: number) => ({ blockNumber: 6n, logIndex, transactionHash: tx2 });
        ingestor.push(logs.afterClear(change(4n), at2(4)));
        ingestor.push(logs.afterClear(change(3n), at2(2)));
        ingestor.push(logs.clear(order(), order(), bounty, at2(3)));
        expect(live).toHaveLength(3);
        expect(live[2].event.ref.logIndex).toBe(4);
        expect((live[2].event as any).changes[0].amount).toEqual({ float: float(4n, 18) });
        ingestor.push(logs.clear(order(), order(), bounty, at2(1)));
        expect(live).toHaveLength(4);
        expect(live[3].event.ref.logIndex).toBe(2);
        expect((live[3].event as any).changes[0].amount).toEqual({ float: float(3n, 18) });
    });

    it("should pair the clears of one transaction in log index order at the drain in buffer mode", () => {
        const tx = ("0x" + "3".repeat(64)) as `0x${string}`;
        const at = (logIndex: number) => ({ blockNumber: 7n, logIndex, transactionHash: tx });
        const bounty = { alice: VAULT_3, bob: VAULT_3 };
        const change = (units: bigint) => ({
            aliceOutput: float(units, 18),
            bobOutput: float(units, 6),
            aliceInput: float(units, 6),
            bobInput: float(units, 18),
        });
        // the stream gave the tail of the transaction, a range query the rest
        ingestor.push(logs.afterClear(change(2n), at(4)));
        ingestor.push(logs.clear(order(), order(), bounty, at(1)));
        ingestor.push(logs.afterClear(change(1n), at(2)));
        ingestor.push(logs.clear(order(), order(), bounty, at(3)));
        expect(ingestor.bufferedCount).toBe(0);

        const drained = ingestor.drain();
        expect(
            drained.map(({ event }) => [event.ref.logIndex, (event as any).changes[0].amount]),
        ).toEqual([
            [2, { float: float(1n, 18) }],
            [4, { float: float(2n, 18) }],
        ]);
        expect((ingestor as any).clearStarts.size).toBe(0);
        expect((ingestor as any).afterClears.size).toBe(0);
    });

    it("should take a clear mined again after a reorg once in buffer mode, and reverse one applied before", () => {
        const bounty = { alice: VAULT_3, bob: VAULT_3 };
        const change = {
            aliceOutput: float(1n, 18),
            bobOutput: float(1n, 6),
            aliceInput: float(1n, 6),
            bobInput: float(1n, 18),
        };
        const clear = (tx: `0x${string}`, block: bigint, index: number, removed = false) => {
            const where = { blockNumber: block, transactionHash: tx, removed };
            ingestor.push(logs.clear(order(), order(), bounty, { ...where, logIndex: index }));
            ingestor.push(logs.afterClear(change, { ...where, logIndex: index + 1 }));
        };
        const refs = (events: IngestedEvent[]) =>
            events.map(({ event, reverted }) => [
                event.ref.blockNumber,
                event.ref.logIndex,
                reverted,
            ]);

        // mined again in the same block at the same indexes
        const tx = ("0x" + "4".repeat(64)) as `0x${string}`;
        clear(tx, 7n, 5);
        clear(tx, 7n, 5, true);
        clear(tx, 7n, 5);
        expect(refs(ingestor.drain())).toEqual([[7n, 6, false]]);

        // mined again in the next block at other indexes
        const tx2 = ("0x" + "5".repeat(64)) as `0x${string}`;
        clear(tx2, 7n, 5);
        clear(tx2, 7n, 5, true);
        clear(tx2, 8n, 4);
        expect(refs(ingestor.drain())).toEqual([[8n, 5, false]]);

        // a clear applied live, then removed while the syncer buffers, is reversed
        const tx3 = ("0x" + "6".repeat(64)) as `0x${string}`;
        ingestor.goLive();
        clear(tx3, 9n, 1);
        expect(refs(live)).toEqual([[9n, 2, false]]);
        ingestor.goBuffer();
        clear(tx3, 9n, 1, true);
        expect(refs(ingestor.drain())).toEqual([[9n, 2, true]]);
        expect((ingestor as any).clearStarts.size).toBe(0);
        expect((ingestor as any).afterClears.size).toBe(0);
    });

    it("should reverse a clear of a multicall applied before and apply its copy mined again in the same block", () => {
        const tx = ("0x" + "7".repeat(64)) as `0x${string}`;
        const bounty = { alice: VAULT_3, bob: VAULT_3 };
        const change = {
            aliceOutput: float(1n, 18),
            bobOutput: float(1n, 6),
            aliceInput: float(1n, 6),
            bobInput: float(1n, 18),
        };
        const at = (logIndex: number, removed = false) => ({
            blockNumber: 7n,
            logIndex,
            transactionHash: tx,
            removed,
        });
        const refs = (events: IngestedEvent[]) =>
            events.map(({ event, reverted }) => [event.ref.logIndex, reverted]);

        // the first clear goes out, the start of the second waits for its half
        ingestor.push(logs.clear(order(), order(), bounty, at(1)));
        ingestor.push(logs.afterClear(change, at(2)));
        expect(refs(ingestor.drain())).toEqual([[2, false]]);
        ingestor.push(logs.clear(order(), order(), bounty, at(3)));

        // the block is replaced by one with the same transaction
        ingestor.push(logs.clear(order(), order(), bounty, at(1, true)));
        ingestor.push(logs.afterClear(change, at(2, true)));
        ingestor.push(logs.clear(order(), order(), bounty, at(1)));
        ingestor.push(logs.afterClear(change, at(2)));
        ingestor.push(logs.clear(order(), order(), bounty, at(3, true)));
        ingestor.push(logs.clear(order(), order(), bounty, at(3)));
        ingestor.push(logs.afterClear(change, at(4)));
        expect(refs(ingestor.drain())).toEqual([
            [2, true],
            [2, false],
            [4, false],
        ]);
    });

    it("should send a live add out at once, and its meta after it as its own event", () => {
        ingestor.goLive();
        const tx = ("0x" + "f".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.addOrder(HASH_A, order(), { blockNumber: 6n, logIndex: 1, transactionHash: tx }),
        );
        expect(live).toHaveLength(1);
        expect(live[0].event.type).toBe("AddOrder");
        expect((live[0].event as any).meta).toBeUndefined();
        ingestor.push(
            logs.meta(HASH_A, "0x1234", { blockNumber: 6n, logIndex: 2, transactionHash: tx }),
        );
        expect(live).toHaveLength(2);
        expect(live[1].event).toMatchObject({ type: "Meta", orderHash: HASH_A, meta: "0x1234" });
    });

    it("should land a meta that comes before its add in buffer mode on the add", () => {
        // the meta sits right above the add on chain, here it arrives first, as a
        // range query that serves the add after the stream served the meta
        const tx = ("0x" + "e".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.meta(HASH_A, "0xabcd", { blockNumber: 5n, logIndex: 2, transactionHash: tx }),
        );
        ingestor.push(
            logs.addOrder(HASH_A, order(), { blockNumber: 5n, logIndex: 1, transactionHash: tx }),
        );
        const events = ingestor.drain(0n);
        expect(events.map(({ event }) => event.type)).toEqual(["AddOrder", "Meta"]);
        expect((events[0].event as any).meta).toBe("0xabcd");
    });

    it("should keep the order of an add and a removal of the same transaction", () => {
        ingestor.goLive();
        const tx = ("0x" + "3".repeat(64)) as `0x${string}`;
        const at = (logIndex: number) => ({ blockNumber: 6n, logIndex, transactionHash: tx });
        // an add and a removal of the same order in one multicall, no meta
        ingestor.push(logs.addOrder(HASH_A, order(), at(0)));
        ingestor.push(logs.removeOrder(HASH_A, order(), at(1)));
        expect(live.map(({ event }) => event.type)).toEqual(["AddOrder", "RemoveOrder"]);
        expect((live[0].event as any).meta).toBeUndefined();
    });

    it("should pair a buffered meta with the add right below it, and keep adds of one hash apart", () => {
        const tx = ("0x" + "4".repeat(64)) as `0x${string}`;
        const at = (logIndex: number) => ({ blockNumber: 6n, logIndex, transactionHash: tx });
        // add, remove, add of the same order in one multicall, each add with its meta
        ingestor.push(logs.addOrder(HASH_A, order(), at(0)));
        ingestor.push(logs.meta(HASH_A, "0xaa", at(1)));
        ingestor.push(logs.removeOrder(HASH_A, order(), at(2)));
        ingestor.push(logs.addOrder(HASH_A, order(), at(3)));
        ingestor.push(logs.meta(HASH_A, "0xbb", at(4)));
        // a meta that is not right above an add of its hash goes out on its own
        ingestor.push(logs.meta(HASH_A, "0xcc", at(9)));
        const events = ingestor.drain(0n);
        expect(events.map(({ event }) => event.type)).toEqual([
            "AddOrder",
            "RemoveOrder",
            "AddOrder",
            "Meta",
        ]);
        expect((events[0].event as any).meta).toBe("0xaa");
        expect((events[2].event as any).meta).toBe("0xbb");
        expect((events[3].event as any).meta).toBe("0xcc");
    });

    it("should send a meta out on its own once the drain has handed out its add", () => {
        const tx = ("0x" + "5".repeat(64)) as `0x${string}`;
        const at = (logIndex: number) => ({ blockNumber: 6n, logIndex, transactionHash: tx });
        ingestor.push(logs.addOrder(HASH_A, order(), at(0)));
        expect(ingestor.drain(0n)).toHaveLength(1);
        ingestor.push(logs.meta(HASH_A, "0xaa", at(1)));
        const events = ingestor.drain(0n);
        expect(events).toHaveLength(1);
        expect(events[0].event).toMatchObject({ type: "Meta", orderHash: HASH_A, meta: "0xaa" });
    });

    it("should buffer again after goBuffer, and drain the whole buffer when no block is given", () => {
        ingestor.goLive();
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 6n, logIndex: 0 }));
        expect(live).toHaveLength(1);
        ingestor.goBuffer();
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 2n, { blockNumber: 8n, logIndex: 0 }));
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 3n, { blockNumber: 7n, logIndex: 0 }));
        expect(live).toHaveLength(1);
        expect(ingestor.bufferedCount).toBe(2);
        const events = ingestor.drain();
        expect(events.map(({ event }) => event.ref.blockNumber)).toEqual([7n, 8n]);
        expect(ingestor.bufferedCount).toBe(0);
    });

    it("should land a meta on a buffered add before the drain", () => {
        const tx = ("0x" + "a".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.addOrder(HASH_A, order(), { blockNumber: 6n, logIndex: 1, transactionHash: tx }),
        );
        ingestor.push(
            logs.meta(HASH_A, "0x1234", { blockNumber: 6n, logIndex: 2, transactionHash: tx }),
        );
        const drained = ingestor.drain(0n);
        expect(drained).toHaveLength(1);
        expect((drained[0].event as any).meta).toBe("0x1234");
    });

    it("should turn a removed log into a reverted event, apart from the log it undoes", () => {
        ingestor.goLive();
        const at = { blockNumber: 9n, logIndex: 0 };
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, at));
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { ...at, removed: true }));
        // the removed log is not a repeat of the one it undoes
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { ...at, removed: true }));
        expect(live.map(({ reverted }) => reverted)).toEqual([false, true]);

        // the transaction mined again in the next block, same hash and log index,
        // is a new log and not a repeat either
        const tx = logs.deposit(OWNER, WETH, VAULT_1, 1n, at).transactionHash;
        ingestor.push(
            logs.deposit(OWNER, WETH, VAULT_1, 1n, {
                blockNumber: 10n,
                logIndex: 0,
                transactionHash: tx,
            }),
        );
        expect(live.map(({ reverted }) => reverted)).toEqual([false, true, false]);
        expect(live[2].event.ref.blockNumber).toBe(10n);
    });

    it("should take a log mined again at the same height after its removal, and its removal again", () => {
        ingestor.goLive();
        const at = { blockNumber: 9n, logIndex: 0 };
        const log = logs.deposit(OWNER, WETH, VAULT_1, 1n, at);
        // the block is replaced by one that holds the same transaction at the
        // same index, the removal comes, then the log again, keyed the same
        ingestor.push(log);
        ingestor.push({ ...log, removed: true });
        ingestor.push(log);
        expect(live.map(({ reverted }) => reverted)).toEqual([false, true, false]);
        // and once more round, a second reorg of the same height
        ingestor.push({ ...log, removed: true });
        ingestor.push(log);
        expect(live.map(({ reverted }) => reverted)).toEqual([false, true, false, true, false]);
        // a plain repeat is still a repeat
        ingestor.push(log);
        expect(live).toHaveLength(5);
    });

    it("should cancel a buffered log and its removal, and undo the logs applied before the buffer first", () => {
        const add = (hash: `0x${string}`, at: Where) => logs.addOrder(hash, order(), at);
        // an add applied live, then a hole, the removal of that add comes, and the
        // same transaction mined again at a lower index of the same block
        ingestor.goLive();
        const applied = add(HASH_A, { blockNumber: 10n, logIndex: 5 });
        ingestor.push(applied);
        ingestor.goBuffer();
        ingestor.push({ ...applied, removed: true });
        ingestor.push(
            add(HASH_A, {
                blockNumber: 10n,
                logIndex: 2,
                transactionHash: applied.transactionHash,
            }),
        );
        // an add and its removal that both came while buffering cancel out
        const both = add(HASH_B, { blockNumber: 11n, logIndex: 0 });
        ingestor.push(both);
        ingestor.push({ ...both, removed: true });

        const drained = ingestor.drain();
        expect(
            drained.map(({ event, reverted }) => [event.ref.logIndex, event.type, reverted]),
        ).toEqual([
            [5, "AddOrder", true],
            [2, "AddOrder", false],
        ]);
    });

    it("should drop a second copy of a log or of a removal in the buffer", () => {
        const deposit = logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 10n, logIndex: 0 });
        // the seen logs forget the copies, a prune after many logs say
        const forget = () => (ingestor as any).seen.clear();
        ingestor.push(deposit);
        forget();
        ingestor.push(deposit);
        expect(ingestor.drain().map(({ reverted }) => reverted)).toEqual([false]);

        // a log, its removal, and a copy of each again cancel out in turns
        forget();
        ingestor.push(deposit);
        ingestor.push({ ...deposit, removed: true });
        forget();
        ingestor.push(deposit);
        ingestor.push({ ...deposit, removed: true });
        expect(ingestor.drain()).toEqual([]);
    });

    it("should drop the removal of a log it never saw above the snapshot block only", () => {
        ingestor.goLive();
        // before the snapshot, a removal of a log never seen undoes nothing
        ingestor.push(
            logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 5n, logIndex: 0, removed: true }),
        );
        expect(live).toHaveLength(0);
        // the snapshot at 10 may hold a log at or below it, so its removal goes through
        ingestor.snapshotBlock = 10n;
        ingestor.push(
            logs.deposit(OWNER, WETH, VAULT_1, 1n, {
                blockNumber: 10n,
                logIndex: 0,
                removed: true,
            }),
        );
        ingestor.push(
            logs.deposit(OWNER, WETH, VAULT_1, 1n, {
                blockNumber: 11n,
                logIndex: 0,
                removed: true,
            }),
        );
        expect(live.map(({ event, reverted }) => [event.ref.blockNumber, reverted])).toEqual([
            [10n, true],
        ]);
    });

    it("should keep the clear halves of an old block that a deep backfill reads after many logs", () => {
        ingestor.goLive();
        const many = LogIngestor.SEEN_PRUNE_AT;
        for (let i = 0; i < many; i++) {
            ingestor.push(
                logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 5_000n, logIndex: i }),
            );
        }
        // the start and the after clear of one clear, far below the newest block
        const tx = ("0x" + "c".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.clear(
                order(),
                order(),
                { alice: VAULT_3, bob: VAULT_3 },
                { blockNumber: 1n, logIndex: 0, transactionHash: tx },
            ),
        );
        ingestor.push(
            logs.afterClear(
                {
                    aliceOutput: float(1n, 18),
                    bobOutput: float(1n, 6),
                    aliceInput: float(1n, 6),
                    bobInput: float(1n, 18),
                },
                { blockNumber: 1n, logIndex: 1, transactionHash: tx },
            ),
        );
        expect(live.at(-1)?.event.type).toBe("Clear");
    });

    it("should keep the waiting clear halves of a backfill in buffer mode until the drain", () => {
        const many = LogIngestor.SEEN_PRUNE_AT;
        for (let i = 0; i < many; i++) {
            ingestor.push(
                logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 5_000n, logIndex: i }),
            );
        }
        // the backfill reads the clear of block 1, then the logs of block 2
        const tx = ("0x" + "d".repeat(64)) as `0x${string}`;
        ingestor.push(
            logs.clear(
                order(),
                order(),
                { alice: VAULT_3, bob: VAULT_3 },
                { blockNumber: 1n, logIndex: 0, transactionHash: tx },
            ),
        );
        ingestor.push(
            logs.afterClear(
                {
                    aliceOutput: float(1n, 18),
                    bobOutput: float(1n, 6),
                    aliceInput: float(1n, 6),
                    bobInput: float(1n, 18),
                },
                { blockNumber: 1n, logIndex: 1, transactionHash: tx },
            ),
        );
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 2n, logIndex: 0 }));
        const drained = ingestor.drain();
        expect(drained.map(({ event }) => [event.ref.blockNumber, event.type])).toContainEqual([
            1n,
            "Clear",
        ]);
    });

    it("should forget the seen logs of blocks far behind once there are many", () => {
        ingestor.goLive();
        const halves = () => [
            (ingestor as any).clearStarts.size,
            (ingestor as any).afterClears.size,
        ];
        // a clear half whose other half never comes waits, in block 1
        ingestor.push(
            logs.clear(
                order(),
                order(),
                { alice: VAULT_3, bob: VAULT_3 },
                {
                    blockNumber: 1n,
                    logIndex: 0,
                    transactionHash: ("0x" + "c".repeat(64)) as `0x${string}`,
                },
            ),
        );
        expect(halves()).toEqual([1, 0]);
        // the clear half and these make one log short of the prune
        const many = LogIngestor.SEEN_PRUNE_AT - 2;
        for (let i = 0; i < many; i++) {
            ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: i }));
        }
        // a log far ahead prunes the old ones, so the first log counts as new again
        ingestor.push(
            logs.deposit(OWNER, WETH, VAULT_1, 1n, {
                blockNumber: 1n + LogIngestor.SEEN_BLOCKS + 1n,
                logIndex: 0,
            }),
        );
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }));
        expect(live).toHaveLength(many + 2);
        // the orphan half went with them
        expect(halves()).toEqual([0, 0]);
    });

    it("should forget no seen log in buffer mode, and prune again once live", () => {
        // in buffer mode, every log of block 1 and one far ahead
        const many = LogIngestor.SEEN_PRUNE_AT;
        for (let i = 0; i < many; i++) {
            ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: i }));
        }
        const far = 1n + LogIngestor.SEEN_BLOCKS + 1n;
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: far, logIndex: 0 }));
        // a range read gives the first log again, it is still seen
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }));
        expect(ingestor.drain()).toHaveLength(many + 1);

        // live again, the next log prunes the old ones
        ingestor.goLive();
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: far, logIndex: 1 }));
        ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }));
        expect(live).toHaveLength(2);
    });

    it("should wait for twice the seen logs a prune keeps before it prunes again", () => {
        ingestor.goLive();
        const many = LogIngestor.SEEN_PRUNE_AT;
        // every log is in the window of the newest block, the prune keeps them all
        for (let i = 0; i < many; i++) {
            ingestor.push(logs.deposit(OWNER, WETH, VAULT_1, 1n, { blockNumber: 1n, logIndex: i }));
        }
        expect((ingestor as any).nextPruneAt).toBe(2 * many);
        // the reset starts over from the default
        ingestor.reset();
        expect((ingestor as any).nextPruneAt).toBe(LogIngestor.SEEN_PRUNE_AT);
    });

    it("should count a log that does not decode and go on", () => {
        ingestor.push({
            ...logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 1n, logIndex: 0 }),
            data: "0x12",
        });
        expect(ingestor.buffered).toEqual([]);
        expect(ingestor.badLogCount).toBe(1);
        // a reset keeps the count, the report counts since the start
        ingestor.reset();
        expect(ingestor.badLogCount).toBe(1);
    });
});

describe("Test LogIngestor with the order filters", () => {
    const OTHER_OWNER = "0x0000000000000000000000000000000000000b22";
    let live: IngestedEvent[];

    const ingestorWith = (filters: any, mode: "live" | "buffer" = "live") => {
        live = [];
        const ingestor = new LogIngestor(ORDERBOOK, (event) => live.push(event), filters);
        if (mode === "live") ingestor.goLive();
        return ingestor;
    };

    it("should drop the add and the removal of an order the filters leave out, right after the decode", () => {
        const ingestor = ingestorWith({ excludeOwners: new Set([OWNER]) });
        const mine = order(OTHER_OWNER);
        ingestor.push(logs.addOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 0 }));
        ingestor.push(logs.removeOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 1 }));
        ingestor.push(logs.addOrder(HASH_B, mine, { blockNumber: 1n, logIndex: 2 }));
        ingestor.push(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 1n, logIndex: 3 }));
        // the other owner's add and the deposit went out, a vault event carries no order
        expect(live.map(({ event }) => event.type)).toEqual(["AddOrder", "Deposit"]);
        expect(ingestor.filtered).toBe(2);
    });

    it("should take the include filters by hash and by owner the same way", () => {
        const byHash = ingestorWith({ includeOrders: new Set([HASH_A]) });
        byHash.push(logs.addOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 0 }));
        byHash.push(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 1n, logIndex: 1 }));
        expect(live.map(({ event }) => (event as any).orderHash)).toEqual([HASH_A]);
        expect(byHash.filtered).toBe(1);

        const byOwner = ingestorWith({ includeOwners: new Set([OTHER_OWNER]) });
        byOwner.push(logs.addOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 0 }));
        byOwner.push(logs.addOrder(HASH_B, order(OTHER_OWNER), { blockNumber: 1n, logIndex: 1 }));
        expect(live.map(({ event }) => (event as any).orderHash)).toEqual([HASH_B]);
        expect(byOwner.filtered).toBe(1);
    });

    it("should drop the meta of a filtered add that comes after it, and forget one that came before it", () => {
        // a meta comes before its add only in buffer mode, from a range query
        const ingestor = ingestorWith({ excludeOwners: new Set([OWNER]) }, "buffer");
        const metas = () => (ingestor as any).metas.size;
        const tx1 = ("0x" + "1".repeat(64)) as `0x${string}`;
        const tx2 = ("0x" + "2".repeat(64)) as `0x${string}`;
        // the usual order, the add then its meta right above it
        ingestor.push(
            logs.addOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 0, transactionHash: tx1 }),
        );
        ingestor.push(
            logs.meta(HASH_A, "0xabcd", { blockNumber: 1n, logIndex: 1, transactionHash: tx1 }),
        );
        expect(metas()).toBe(0);
        // the meta served first, then the add it belongs to
        ingestor.push(
            logs.meta(HASH_B, "0xabcd", { blockNumber: 2n, logIndex: 1, transactionHash: tx2 }),
        );
        expect(metas()).toBe(1);
        ingestor.push(
            logs.addOrder(HASH_B, order(OWNER, 2), {
                blockNumber: 2n,
                logIndex: 0,
                transactionHash: tx2,
            }),
        );
        expect(metas()).toBe(0);
        // no add goes out, the meta that came first went to the buffer on its
        // own, the syncer ignores a meta of an order it does not know
        expect(ingestor.drain().map(({ event }) => event.type)).toEqual(["Meta"]);
        expect(ingestor.filtered).toBe(2);
    });

    it("should let every order through without filters", () => {
        const ingestor = ingestorWith(undefined);
        ingestor.push(logs.addOrder(HASH_A, order(), { blockNumber: 1n, logIndex: 0 }));
        expect(live).toHaveLength(1);
        expect(ingestor.filtered).toBe(0);
    });
});
