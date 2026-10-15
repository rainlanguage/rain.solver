import { getAddress } from "viem";
import { Order } from "../order";
import { Result } from "../common";
import { Hex, VaultRef } from "./types";
import { EventSink, OrderbookSyncer } from "./syncer";
import { SgOrder, SubgraphVersions } from "../subgraph/types";
import { describe, it, expect, beforeEach, vi, Mock } from "vitest";
import {
    logs,
    logsV4,
    order,
    orderV3,
    float,
    OWNER,
    TAKER,
    USDC,
    WETH,
    HASH_A,
    HASH_B,
    VAULT_1,
    VAULT_2,
    VAULT_3,
    ORDERBOOK,
    USDC_DETAILS,
    WETH_DETAILS,
    RawOrderArgs,
} from "./fixtures";
import { toOrderBytes, toOrderBytesV3 } from "./decode";

/** A snapshot order of the fixture order, with the given balances in token units */
function sgOrder(hash: Hex, raw: RawOrderArgs, usdcBalance: bigint, wethBalance: bigint): SgOrder {
    return {
        __version: SubgraphVersions.V6,
        id: hash,
        owner: raw.owner,
        orderHash: hash,
        orderBytes: toOrderBytes(raw),
        active: true,
        nonce: raw.nonce,
        orderbook: { id: ORDERBOOK },
        inputs: [
            {
                balance: float(usdcBalance, 6),
                vaultId: BigInt(VAULT_1).toString(),
                token: { address: USDC, decimals: 6, symbol: "USDC" },
            },
        ],
        outputs: [
            {
                balance: float(wethBalance, 18),
                vaultId: BigInt(VAULT_2).toString(),
                token: { address: WETH, decimals: 18, symbol: "WETH" },
            },
        ],
    };
}

const vault = (owner: Hex, token: Hex, vaultId: Hex): VaultRef => ({
    orderbook: ORDERBOOK,
    owner,
    token,
    vaultId: BigInt(vaultId),
});

describe("Test OrderbookSyncer", () => {
    let sink: { [K in keyof EventSink]: Mock };
    let syncer: OrderbookSyncer;
    const S = 100n;

    /** The balance the ledger holds for a vault, what the round reads */
    const balanceOf = (owner: Hex, token: Hex, vaultId: Hex) =>
        syncer.ledger.balance(vault(owner, token, vaultId));

    beforeEach(() => {
        sink = {
            addOrder: vi.fn().mockResolvedValue(Result.ok(undefined)),
            removeOrder: vi.fn().mockResolvedValue(undefined),
            updateMeta: vi.fn().mockResolvedValue(undefined),
        };
        syncer = new OrderbookSyncer({ orderbook: ORDERBOOK, sink });
    });

    it("should buffer the logs before the snapshot and replay only the ones above its block", async () => {
        // logs from before, at and after the snapshot block arrive first, out of order
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 30n, { blockNumber: 102n, logIndex: 0 }));
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 100n, logIndex: 0 }));
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 99n, logIndex: 0 }));
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 10n, { blockNumber: 101n, logIndex: 0 }));
        expect(syncer.ledger.vaults.size).toBe(0);
        expect(syncer.phase).toBe("buffering");

        const report = await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(syncer.phase).toBe("live");
        expect(report).toEqual({
            snapshotBlock: S,
            ordersAdded: 1,
            ordersFailed: {},
            eventsReplayed: 2,
            eventsParked: 0,
        });
        // the snapshot order went to the sink as it is
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(sink.addOrder.mock.calls[0][0].orderHash).toBe(HASH_A);
        // the two deposits above the block landed on the snapshot balance
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_040n);
    });

    it("should not lose a log that comes in while the replay awaits the sink", async () => {
        // the replay of a buffered add awaits the sink, a deposit of the next
        // block comes in during that wait, it must apply after the replay, not
        // vanish in a buffer nobody drains again
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 10n, { blockNumber: 101n, logIndex: 0 }));
        sink.addOrder.mockImplementationOnce(async () => {
            syncer.onLog(
                logs.deposit(OWNER, USDC, VAULT_1, 20n, { blockNumber: 102n, logIndex: 0 }),
            );
            await new Promise((resolve) => setTimeout(resolve, 5));
            return Result.ok(undefined);
        });
        const report = await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(report.eventsReplayed).toBe(2);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_030n);
        expect(syncer.phase).toBe("live");
    });

    it("should apply live logs as they come once the snapshot is in", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n * 10n ** 18n)], S);
        syncer.onLog(
            logs.withdraw(OWNER, WETH, VAULT_2, 10n ** 18n, 18, { blockNumber: 101n, logIndex: 0 }),
        );
        // a take pays one weth out of vault 2 to the taker and two usdc into vault 1
        syncer.onLog(
            logs.takeOrder(order(), float(10n ** 18n, 18), float(2_000_000n, 6), {
                blockNumber: 101n,
                logIndex: 1,
            }),
        );
        await syncer.settled();
        expect(balanceOf(OWNER, WETH, VAULT_2)).toBe(3n * 10n ** 18n);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(2_001_000n);
        expect(syncer.stats.applied).toBe(2);
    });

    it("should apply a clear to both orders and the clearer's bounty vaults it tracks", async () => {
        const bob = {
            ...order("0x0000000000000000000000000000000000000b22", 2),
            validInputs: [{ token: WETH, vaultId: VAULT_1 }],
            validOutputs: [{ token: USDC, vaultId: VAULT_2 }],
        };
        const bobSg: SgOrder = {
            ...sgOrder(HASH_B, bob, 0n, 0n),
            inputs: [
                {
                    balance: float(0n, 18),
                    vaultId: BigInt(VAULT_1).toString(),
                    token: { address: WETH, decimals: 18, symbol: "WETH" },
                },
            ],
            outputs: [
                {
                    balance: float(500n, 6),
                    vaultId: BigInt(VAULT_2).toString(),
                    token: { address: USDC, decimals: 6, symbol: "USDC" },
                },
            ],
        };
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 100n), bobSg], S);

        const tx = ("0x" + "c".repeat(64)) as Hex;
        syncer.onLog(
            logs.clear(
                order(),
                bob,
                { alice: VAULT_3, bob: VAULT_3 },
                { blockNumber: 101n, logIndex: 0, transactionHash: tx },
            ),
        );
        syncer.onLog(
            logs.afterClear(
                {
                    aliceOutput: float(10n, 18),
                    bobOutput: float(30n, 6),
                    aliceInput: float(25n, 6),
                    bobInput: float(8n, 18),
                },
                { blockNumber: 101n, logIndex: 1, transactionHash: tx },
            ),
        );
        await syncer.settled();
        expect(balanceOf(OWNER, WETH, VAULT_2)).toBe(90n); // alice paid 10 weth
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_025n); // and took 25 usdc
        expect(balanceOf(bob.owner, USDC, VAULT_2)).toBe(470n); // bob paid 30 usdc
        expect(balanceOf(bob.owner, WETH, VAULT_1)).toBe(8n); // and took 8 weth
        // the clearer's bounty vaults belong to no order, so they are not tracked
        expect(balanceOf(TAKER, WETH, VAULT_3)).toBeUndefined();
    });

    it("should park an add whose vaults have no baseline and apply it once they are read", async () => {
        await syncer.applySnapshot([], S);
        // the new order uses the fixture tokens, unknown so far, in fresh vaults
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        // a deposit into one of its vaults comes right after, and one before the read lands
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 5n, { blockNumber: 102n, logIndex: 0 }));
        await syncer.settled();
        expect(sink.addOrder).not.toHaveBeenCalled();
        expect(syncer.stats.parked).toBe(1);
        expect(syncer.needs()).toEqual({
            tokens: [USDC, WETH],
            vaults: [vault(OWNER, USDC, VAULT_1), vault(OWNER, WETH, VAULT_2)],
        });

        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        await syncer.settled();
        expect(sink.addOrder).not.toHaveBeenCalled(); // the balances are still unknown
        expect(syncer.needs().tokens).toEqual([]);

        // the reads land at block 102, the usdc one already holds the deposit of that block
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 105n, 102n);
        syncer.resolveVaultBalance(vault(OWNER, WETH, VAULT_2), 7n, 102n);
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        const added: SgOrder = sink.addOrder.mock.calls[0][0];
        expect(added.orderHash).toBe(HASH_A);
        expect(added.owner).toBe(OWNER);
        expect(added.orderbook.id).toBe(ORDERBOOK);
        expect(added.inputs).toEqual([
            {
                vaultId: "1",
                balance: float(105n, 6),
                token: { address: USDC, decimals: 6, symbol: "USDC" },
            },
        ]);
        expect(added.outputs[0].balance).toBe(float(7n, 18));
        expect(added.meta).toBeUndefined();

        // and a deposit after the read lands on top
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 103n, logIndex: 0 }));
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(106n);
    });

    it("should add an order whose vaults are known already without any read", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        // a second order of the same owner on the same vaults, with a meta, the
        // meta sits right above the add on chain and arrives first here
        const tx = ("0x" + "e".repeat(64)) as Hex;
        syncer.onLog(
            logs.meta(HASH_B, "0xabcd", { blockNumber: 101n, logIndex: 1, transactionHash: tx }),
        );
        syncer.onLog(
            logs.addOrder(HASH_B, order(OWNER, 2), {
                blockNumber: 101n,
                logIndex: 0,
                transactionHash: tx,
            }),
        );
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        const added: SgOrder = sink.addOrder.mock.calls[1][0];
        expect(added.orderHash).toBe(HASH_B);
        expect(added.meta).toBe("0xabcd");
        expect(added.inputs[0].balance).toBe(float(1_000n, 6));
        expect(syncer.orders.get(HASH_B)?.active).toBe(true);
    });

    it("should drop the parked adds whose reads gave up, and stop reading their vaults", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        // one new order on a token the sync never saw, one on a fresh usdc vault
        const unknownToken = "0x00000000000000000000000000000000000000d0" as Hex;
        const HASH_C = ("0x" + "c".repeat(64)) as Hex;
        syncer.onLog(
            logs.addOrder(
                HASH_B,
                { ...order(OWNER, 2), validInputs: [{ token: unknownToken, vaultId: VAULT_1 }] },
                { blockNumber: 101n, logIndex: 0 },
            ),
        );
        syncer.onLog(
            logs.addOrder(
                HASH_C,
                { ...order(OWNER, 3), validInputs: [{ token: USDC, vaultId: VAULT_3 }] },
                { blockNumber: 101n, logIndex: 1 },
            ),
        );
        await syncer.settled();
        expect(syncer.stats.parked).toBe(2);
        expect(syncer.needs().tokens).toEqual([unknownToken]);
        expect(syncer.needs().vaults).toHaveLength(2);

        syncer.giveUp([unknownToken], [vault(OWNER, USDC, VAULT_3)]);
        await syncer.settled();
        expect(syncer.stats.givenUp).toBe(2);
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        // the weth vault 2 of the snapshot order stays, that order still uses it
        expect(balanceOf(OWNER, WETH, VAULT_2)).toBe(5n);
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
    });

    it("should drop an active order whose vault read gave up, and keep the others", async () => {
        await syncer.applySnapshot(
            [sgOrder(HASH_A, order(), 1_000n, 5n), sgOrder(HASH_B, order(TAKER, 2), 10n, 1n)],
            S,
        );
        // a reorg undoes a change that the baseline of the usdc vault holds, so
        // the vault is read again
        const usdc = vault(OWNER, USDC, VAULT_1);
        syncer.ledger.apply({ vault: usdc, amount: { raw: 1n }, sign: 1 }, S, true);
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [usdc] });

        syncer.giveUp([], [usdc]);
        await syncer.settled();
        // the order that uses the vault goes out, it has no balance to trade on
        expect(syncer.orders.get(HASH_A)?.active).toBe(false);
        expect(sink.removeOrder).toHaveBeenCalledTimes(1);
        expect(sink.removeOrder.mock.calls[0][0].orderHash).toBe(HASH_A);
        expect(syncer.stats.givenUp).toBe(1);
        // the vault is not read again, and a later change to it is not kept
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 5n, { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBeUndefined();
        // the order of the other owner stays
        expect(syncer.orders.get(HASH_B)?.active).toBe(true);
        expect(balanceOf(TAKER, USDC, VAULT_1)).toBe(10n);
    });

    it("should ask for the token of a vaultless io of a parked add", async () => {
        const VAULT_0 = ("0x" + "0".repeat(64)) as Hex;
        await syncer.applySnapshot([], S);
        syncer.onLog(
            logs.addOrder(
                HASH_A,
                { ...order(), validOutputs: [{ token: WETH, vaultId: VAULT_0 }] },
                { blockNumber: 101n, logIndex: 0 },
            ),
        );
        await syncer.settled();
        expect(syncer.needs()).toEqual({
            tokens: [USDC, WETH],
            vaults: [vault(OWNER, USDC, VAULT_1)],
        });
        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 3n, 101n);
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
    });

    it("should not track or wait for vault id 0 of a v6 order, it is vaultless", async () => {
        const VAULT_0 = ("0x" + "0".repeat(64)) as Hex;
        const vaultless = (raw: RawOrderArgs): RawOrderArgs => ({
            ...raw,
            validOutputs: [{ token: WETH, vaultId: VAULT_0 }],
        });
        // a snapshot order that sells weth from the owner's wallet
        const snapshot = sgOrder(HASH_A, vaultless(order()), 1_000n, 0n);
        snapshot.orderBytes = toOrderBytes(vaultless(order()));
        snapshot.outputs[0].vaultId = "0";
        await syncer.applySnapshot([snapshot], S);
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(syncer.ledger.tokens.get(WETH)).toEqual(WETH_DETAILS);
        // only the usdc vault 1 is tracked
        expect(syncer.ledger.vaults.size).toBe(1);
        expect(balanceOf(OWNER, WETH, VAULT_0)).toBeUndefined();

        // a new order on vault 0 needs no read of it, only of its vault 1
        syncer.onLog(
            logs.addOrder(HASH_B, vaultless(order(TAKER, 2)), { blockNumber: 101n, logIndex: 0 }),
        );
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [vault(TAKER, USDC, VAULT_1)] });
        syncer.resolveVaultBalance(vault(TAKER, USDC, VAULT_1), 3n, 101n);
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        const added: SgOrder = sink.addOrder.mock.calls[1][0];
        expect(added.outputs).toEqual([
            { vaultId: "0", balance: float(0n, 18), token: WETH_DETAILS },
        ]);
        expect(syncer.ledger.vaults.size).toBe(2);
        expect(balanceOf(TAKER, WETH, VAULT_0)).toBeUndefined();
    });

    it("should remove an order, and drop a parked add of it", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        syncer.onLog(logs.removeOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(sink.removeOrder).toHaveBeenCalledTimes(1);
        expect(sink.removeOrder.mock.calls[0][0].orderHash).toBe(HASH_A);
        expect(syncer.orders.get(HASH_A)?.active).toBe(false);

        // an order on unknown tokens is added and removed before its reads land
        const other = {
            ...order(OWNER, 3),
            validInputs: [
                { token: "0x00000000000000000000000000000000000000d0" as Hex, vaultId: VAULT_3 },
            ],
        };
        syncer.onLog(logs.addOrder(HASH_B, other, { blockNumber: 102n, logIndex: 0 }));
        syncer.onLog(logs.removeOrder(HASH_B, other, { blockNumber: 103n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.stats.parked).toBe(1);
        expect(syncer.stats.dropped).toBe(1);
        // the removal still goes to the sink, a no-op there, with the token it knows and a blank for the other
        expect(sink.removeOrder).toHaveBeenCalledTimes(2);
        const removed: SgOrder = sink.removeOrder.mock.calls[1][0];
        expect(removed.inputs[0].token).toEqual({
            address: other.validInputs[0].token,
            decimals: 0,
            symbol: "",
        });
        expect(removed.outputs[0].token.symbol).toBe("WETH");

        // the reads that come late find nothing to apply
        syncer.resolveToken({ address: other.validInputs[0].token, decimals: 8, symbol: "X" });
        syncer.resolveVaultBalance(vault(OWNER, other.validInputs[0].token, VAULT_3), 1n, 104n);
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
    });

    it("should reverse an event the chain removed in a reorg", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        const at = { blockNumber: 101n, logIndex: 0 };
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 40n, at));
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_040n);
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 40n, { ...at, removed: true }));
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_000n);
        expect(syncer.stats.reverted).toBe(1);

        // a removed add is a removal, a removed removal an add
        const addAt = { blockNumber: 102n, logIndex: 0 };
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), addAt));
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { ...addAt, removed: true }));
        await syncer.settled();
        expect(sink.removeOrder).toHaveBeenCalledTimes(1);
        expect(sink.removeOrder.mock.calls[0][0].orderHash).toBe(HASH_B);
        expect(syncer.orders.get(HASH_B)?.active).toBe(false);

        const removeAt = { blockNumber: 103n, logIndex: 0 };
        syncer.onLog(logs.removeOrder(HASH_A, order(), removeAt));
        syncer.onLog(logs.removeOrder(HASH_A, order(), { ...removeAt, removed: true }));
        await syncer.settled();
        expect(sink.removeOrder).toHaveBeenCalledTimes(2);
        expect(sink.addOrder).toHaveBeenCalledTimes(3);
        expect(sink.addOrder.mock.calls[2][0].orderHash).toBe(HASH_A);
        expect(syncer.orders.get(HASH_A)?.active).toBe(true);
    });

    it("should leave out an order the filters exclude", async () => {
        syncer = new OrderbookSyncer({
            orderbook: ORDERBOOK,
            sink,
            filters: { excludeOwners: new Set([OWNER]) },
        });
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(sink.addOrder).not.toHaveBeenCalled();
        // the order is not seeded nor recorded, nothing is tracked for it
        expect(syncer.orders.size).toBe(0);
        expect(syncer.ledger.vaults.size).toBe(0);
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(sink.addOrder).not.toHaveBeenCalled();
        // the add went no further than the ingestor, no vault or token got asked for
        expect(syncer.stats.filtered).toBe(1);
        expect(syncer.stats.dropped).toBe(0);
        expect(syncer.stats.parked).toBe(0);
        expect(syncer.orders.size).toBe(0);
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
    });

    it("should ask for its own vaults only, and retry its parked events on a block when another syncer of the shared ledger met the need", async () => {
        const OTHER = "0x000000000000000000000000000000000000b007" as Hex;
        const other = new OrderbookSyncer({ orderbook: OTHER, sink, ledger: syncer.ledger });
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        await other.applySnapshot([], S);
        expect(sink.addOrder).toHaveBeenCalledTimes(1);

        // an add on the other orderbook parks for its vault balances, the
        // tokens are known already through the shared ledger
        other.onLog({
            ...logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }),
            address: OTHER,
        });
        await other.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(other.needs().tokens).toEqual([]);
        expect(other.needs().vaults.map((vault) => vault.orderbook)).toEqual([OTHER, OTHER]);
        // the first syncer has nothing to ask for, those vaults are not its own
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });

        // the balances land through the first syncer, which retries only its
        // own parked events, the other's add waits for its next block
        for (const vault of other.needs().vaults) syncer.resolveVaultBalance(vault, 1n, 101n);
        await syncer.settled();
        expect(other.needs().vaults).toEqual([]);
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        other.onBlock(102n);
        await other.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        expect(sink.addOrder.mock.calls[1][0].orderHash).toBe(HASH_B);
        expect(other.orders.get(HASH_B)?.active).toBe(true);
    });

    it("should keep the order of live events across an async sink", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        // the add takes a while in the sink, the deposit behind it must not have
        // touched the ledger by the time the add is done
        let balanceDuringAdd: bigint | undefined;
        sink.addOrder.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            balanceDuringAdd = balanceOf(OWNER, USDC, VAULT_1);
            return Result.ok(undefined);
        });
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }));
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 101n, logIndex: 1 }));
        await syncer.settled();
        expect(balanceDuringAdd).toBe(1_000n);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_001n);
    });

    it("should record a sink failure and go on", async () => {
        sink.addOrder.mockResolvedValue(Result.err(new Error("bad order")));
        const report = await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(report.ordersAdded).toBe(0);
        expect(report.ordersFailed[HASH_A]).toContain("bad order");
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.stats.failed).toBe(1);
        // an order the sink did not take is not known as active
        expect(syncer.orders.has(HASH_A)).toBe(false);
        expect(syncer.orders.has(HASH_B)).toBe(false);
    });

    it("should count a live event whose sink throws as failed and go on", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        sink.addOrder.mockRejectedValueOnce(new Error("sink threw"));
        sink.removeOrder.mockRejectedValueOnce(new Error("sink threw"));
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }));
        syncer.onLog(logs.removeOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 1 }));
        // the next event still applies
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 5n, { blockNumber: 102n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.stats.failed).toBe(2);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_005n);
    });

    it("should take a vault balance handed in with checksummed addresses", async () => {
        await syncer.applySnapshot([], S);
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        syncer.resolveToken({ ...USDC_DETAILS, address: getAddress(USDC) });
        syncer.resolveToken({ ...WETH_DETAILS, address: getAddress(WETH) });
        const checksummed = (v: VaultRef): VaultRef => ({
            orderbook: getAddress(v.orderbook),
            owner: getAddress(v.owner),
            token: getAddress(v.token),
            vaultId: v.vaultId,
        });
        syncer.resolveVaultBalance(checksummed(vault(OWNER, USDC, VAULT_1)), 50n, 101n);
        syncer.resolveVaultBalance(checksummed(vault(OWNER, WETH, VAULT_2)), 60n, 101n);
        await syncer.settled();
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(50n);
        expect(balanceOf(OWNER, WETH, VAULT_2)).toBe(60n);
    });

    describe("start", () => {
        let getIndexedBlock: Mock;
        let fetchOrders: Mock;
        let fetchLogs: Mock;

        beforeEach(() => {
            getIndexedBlock = vi.fn().mockResolvedValue(10_000n);
            fetchOrders = vi.fn().mockResolvedValue([sgOrder(HASH_A, order(), 1_000n, 5n)]);
            fetchLogs = vi.fn().mockResolvedValue([]);
        });

        it("should wait for the buffer blocks, pin the snapshot at the start plus the offset, drop at or below and replay above", async () => {
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,
            });
            // the stream opens in the middle of block 100, its first log is there
            syncer.onLog(
                logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 100n, logIndex: 5 }),
            );
            // the block watcher starts after, at 101
            for (let block = 101n; block <= 105n; block++) {
                syncer.onBlock(block);
                syncer.onLog(
                    logs.deposit(OWNER, USDC, VAULT_1, block, { blockNumber: block, logIndex: 0 }),
                );
            }
            await syncer.settled();
            expect(fetchOrders).not.toHaveBeenCalled();
            expect(syncer.phase).toBe("buffering");

            // block 106 makes six past the start, the subgraph is ahead, so the
            // snapshot is pinned at 103, there is no gap to read
            syncer.onBlock(106n);
            const report = await started;
            expect(fetchOrders).toHaveBeenCalledWith(103n);
            expect(fetchLogs).not.toHaveBeenCalled();
            expect(report.snapshotBlock).toBe(103n);
            expect(syncer.phase).toBe("live");
            expect(syncer.firstBlock).toBe(100n);
            // the deposits of 104 and 105 landed on the snapshot balance, the ones
            // at or below 103 did not
            expect(report.eventsReplayed).toBe(2);
            expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_000n + 104n + 105n);
        });

        it("should take the first watched block as the start when no log came before it", async () => {
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,

                bufferBlocks: 2,
                snapshotOffset: 1,
            });
            syncer.onBlock(200n);
            syncer.onBlock(201n);
            syncer.onBlock(202n);
            const report = await started;
            expect(report.snapshotBlock).toBe(201n);
            expect(fetchOrders).toHaveBeenCalledWith(201n);
        });

        it("should pin the snapshot where a subgraph that lags is, and read the gap below the buffer with logs", async () => {
            getIndexedBlock.mockResolvedValue(98n);
            // the logs before the stream opened in the middle of block 100, and the
            // ones of 100 to 103 the buffer has already
            fetchLogs.mockResolvedValue([
                logs.deposit(OWNER, USDC, VAULT_1, 7n, { blockNumber: 99n, logIndex: 0 }),
                logs.deposit(OWNER, USDC, VAULT_1, 50n, { blockNumber: 100n, logIndex: 0 }),
                logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 100n, logIndex: 5 }),
                ...[101n, 102n, 103n].map((block) =>
                    logs.deposit(OWNER, USDC, VAULT_1, block, { blockNumber: block, logIndex: 0 }),
                ),
            ]);
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,
            });
            syncer.onLog(
                logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: 100n, logIndex: 5 }),
            );
            for (let block = 101n; block <= 106n; block++) {
                syncer.onBlock(block);
                syncer.onLog(
                    logs.deposit(OWNER, USDC, VAULT_1, block, { blockNumber: block, logIndex: 0 }),
                );
            }
            const report = await started;
            // the gap from the block after the snapshot block up to the covered block
            expect(fetchLogs).toHaveBeenCalledWith(99n, 103n);
            expect(fetchOrders).toHaveBeenCalledWith(98n);
            expect(report.snapshotBlock).toBe(98n);
            expect(syncer.firstBlock).toBe(100n);
            // every deposit above 98 counted once, the ones the buffer had already too
            expect(report.eventsReplayed).toBe(9);
            expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(
                1_000n + 7n + 50n + 999n + 101n + 102n + 103n + 104n + 105n + 106n,
            );
        });

        it("should wait while the subgraph is further behind the buffer than the gap blocks it reads", async () => {
            getIndexedBlock.mockResolvedValue(98n);
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,
                maxGapBlocks: 4n,
            });
            for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
            await new Promise((resolve) => setTimeout(resolve, 0));
            // the gap is counted from the snapshot block to the covered block
            expect(fetchLogs).not.toHaveBeenCalled();
            expect(fetchOrders).not.toHaveBeenCalled();
            expect(syncer.phase).toBe("buffering");
            expect(String(syncer.startError)).toContain(
                "the subgraph is at block 98, 5 blocks behind the buffer, more than 4",
            );

            // the subgraph comes nearer, the gap is read and the start goes through
            getIndexedBlock.mockResolvedValue(99n);
            syncer.onBlock(107n);
            const report = await started;
            expect(fetchLogs).toHaveBeenCalledWith(100n, 103n);
            expect(report.snapshotBlock).toBe(99n);
            expect(syncer.startError).toBeUndefined();
        });

        it("should try again on the next block when the gap read fails", async () => {
            getIndexedBlock.mockResolvedValue(101n);
            fetchLogs.mockRejectedValueOnce(new Error("range too large"));
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,
            });
            for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(String(syncer.startError)).toContain("range too large");
            expect(fetchOrders).not.toHaveBeenCalled();
            expect(syncer.phase).toBe("buffering");

            syncer.onBlock(107n);
            const report = await started;
            expect(fetchLogs).toHaveBeenCalledTimes(2);
            expect(fetchLogs).toHaveBeenLastCalledWith(102n, 103n);
            expect(report.snapshotBlock).toBe(101n);
        });

        it("should give up at the deadline with the reason it waited for, and stop an attempt in flight", async () => {
            vi.useFakeTimers();
            try {
                // the subgraph stays down
                getIndexedBlock.mockRejectedValue(new Error("subgraph down"));
                const started = syncer.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    timeout: 1_000,
                });
                const rejected = expect(started).rejects.toThrow(
                    "did not go live within 1000ms, subgraph down",
                );
                for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
                await vi.advanceTimersByTimeAsync(999);
                expect(syncer.phase).toBe("buffering");
                await vi.advanceTimersByTimeAsync(1);
                await rejected;
                expect(syncer.startError).toBeUndefined();
                expect(vi.getTimerCount()).toBe(0);
                expect(syncer.firstBlock).toBeUndefined();

                // a fetch still out when the deadline hits does not go live after it
                getIndexedBlock.mockResolvedValue(103n);
                let serve!: (orders: any[]) => void;
                fetchOrders.mockImplementation(() => new Promise((resolve) => (serve = resolve)));
                const second = syncer.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    timeout: 1_000,
                });
                const secondRejected = expect(second).rejects.toThrow(
                    "did not go live within 1000ms",
                );
                // the buffer of the start that gave up is gone, the second one buffers anew
                for (let block = 107n; block <= 113n; block++) syncer.onBlock(block);
                await vi.advanceTimersByTimeAsync(0);
                expect(fetchOrders).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1_000);
                await secondRejected;
                serve([]);
                await vi.advanceTimersByTimeAsync(0);
                expect(syncer.phase).toBe("buffering");
                expect(sink.addOrder).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should try again on the next block when the fetch fails", async () => {
            fetchOrders.mockRejectedValueOnce(new Error("subgraph down"));
            const started = syncer.start({
                getIndexedBlock,
                fetchOrders,
                fetchLogs,
            });
            for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(String(syncer.startError)).toContain("subgraph down");
            expect(syncer.phase).toBe("buffering");

            syncer.onBlock(107n);
            const report = await started;
            expect(report.snapshotBlock).toBe(103n);
            expect(fetchOrders).toHaveBeenCalledTimes(2);
        });

        it("should refuse a second start and bad margins", async () => {
            void syncer.start({ getIndexedBlock, fetchOrders, fetchLogs }).catch(() => {});
            await expect(syncer.start({ getIndexedBlock, fetchOrders, fetchLogs })).rejects.toThrow(
                "started already",
            );
            const other = new OrderbookSyncer({ orderbook: ORDERBOOK, sink });
            await expect(
                other.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    snapshotOffset: 0,
                }),
            ).rejects.toThrow("at least 1");
            await expect(
                other.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    bufferBlocks: 2,
                    snapshotOffset: 3,
                }),
            ).rejects.toThrow("at most the buffer blocks");
        });

        it("should keep the least time between two attempts", async () => {
            vi.useFakeTimers();
            try {
                getIndexedBlock.mockRejectedValue(new Error("subgraph down"));
                const started = syncer.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    timeout: 10_000,
                    attemptInterval: 1_000,
                });
                void started.catch(() => {});
                for (let block = 100n; block <= 110n; block++) {
                    syncer.onBlock(block);
                    await vi.advanceTimersByTimeAsync(100);
                }
                // the attempts at 106 and 1000ms later, not one on every block
                expect(getIndexedBlock).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1_000);
                syncer.onBlock(111n);
                await vi.advanceTimersByTimeAsync(0);
                expect(getIndexedBlock).toHaveBeenCalledTimes(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("should end with the outcome of a snapshot apply that runs at the deadline", async () => {
            vi.useFakeTimers();
            try {
                getIndexedBlock.mockResolvedValue(103n);
                let release!: () => void;
                sink.addOrder.mockImplementationOnce(
                    () => new Promise((resolve) => (release = () => resolve(Result.ok(undefined)))),
                );
                const started = syncer.start({
                    getIndexedBlock,
                    fetchOrders,
                    fetchLogs,

                    timeout: 1_000,
                });
                for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
                await vi.advanceTimersByTimeAsync(0);
                expect(syncer.phase).toBe("replaying");
                // the deadline passes while the apply awaits the sink
                await vi.advanceTimersByTimeAsync(1_000);
                release();
                await expect(started).resolves.toMatchObject({ snapshotBlock: 103n });
                expect(syncer.phase).toBe("live");
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it("should stop reading the vaults of a removed order that never resolved, unless a parked add uses them", async () => {
        await syncer.applySnapshot([], S);
        const junk = "0x00000000000000000000000000000000000000d0" as Hex;
        // a parked add on the fixture vaults, and an order on a token that never resolves
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        const other = {
            ...order(OWNER, 3),
            validInputs: [{ token: junk, vaultId: VAULT_3 }],
        };
        syncer.onLog(logs.addOrder(HASH_B, other, { blockNumber: 102n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.needs().tokens).toEqual([USDC, WETH, junk]);

        syncer.onLog(logs.removeOrder(HASH_B, other, { blockNumber: 103n, logIndex: 0 }));
        await syncer.settled();
        // the weth vault stays, the parked add uses it
        expect(syncer.needs()).toEqual({
            tokens: [USDC, WETH],
            vaults: [vault(OWNER, USDC, VAULT_1), vault(OWNER, WETH, VAULT_2)],
        });
    });

    it("should leave out of the reads a vault tracked above the read block", async () => {
        await syncer.applySnapshot([], S);
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.needs(100n).vaults).toEqual([]);
        expect(syncer.needs(101n).vaults).toEqual([
            vault(OWNER, USDC, VAULT_1),
            vault(OWNER, WETH, VAULT_2),
        ]);
    });

    it("should drop a parked reverted removal when the removal comes again", async () => {
        await syncer.applySnapshot([], S);
        // a removal at the snapshot block is reorged out, the order comes back
        // and parks for its reads, then the removal is mined again
        syncer.onLog(
            logs.removeOrder(HASH_A, order(), { blockNumber: S, logIndex: 0, removed: true }),
        );
        await syncer.settled();
        expect(syncer.stats.parked).toBe(1);
        syncer.onLog(logs.removeOrder(HASH_A, order(), { blockNumber: S + 1n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.stats.dropped).toBe(1);

        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 1n, 102n);
        syncer.resolveVaultBalance(vault(OWNER, WETH, VAULT_2), 1n, 102n);
        await syncer.settled();
        expect(sink.addOrder).not.toHaveBeenCalled();
    });

    it("should drop a late read of a vault that is not tracked anymore or was tracked again above the read block", async () => {
        await syncer.applySnapshot([], S);
        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        syncer.onLog(logs.removeOrder(HASH_A, order(), { blockNumber: 102n, logIndex: 0 }));
        await syncer.settled();
        // the read of the removed order comes back after the removal untracked the vault
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 1_000n, 101n);
        expect(syncer.ledger.isTracked(vault(OWNER, USDC, VAULT_1))).toBe(false);

        // a new order tracks the vault again at 104, a read at 103 misses its changes
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 104n, logIndex: 0 }));
        await syncer.settled();
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 1_000n, 103n);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBeUndefined();
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 1_057n, 104n);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_057n);
    });

    it("should go live after a snapshot whose sink throws for an order or an event", async () => {
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 0 }));
        sink.addOrder.mockRejectedValueOnce(new Error("sink down"));
        sink.addOrder.mockRejectedValueOnce(new Error("sink down"));
        const report = await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(syncer.phase).toBe("live");
        expect(report.ordersFailed[HASH_A]).toContain("sink down");
        expect(syncer.stats.failed).toBe(1);
    });

    it("should fail a malformed snapshot order on its own and go on with the others", async () => {
        const malformed = { ...sgOrder(HASH_B, order(OWNER, 2), 1n, 1n), orderbook: undefined };
        const report = await syncer.applySnapshot(
            [malformed as any, sgOrder(HASH_A, order(), 1_000n, 5n)],
            S,
        );
        expect(syncer.phase).toBe("live");
        expect(report.ordersAdded).toBe(1);
        expect(Object.keys(report.ordersFailed)).toEqual([HASH_B]);
    });

    it("should not move the buffer start for a removed log", async () => {
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 100n, logIndex: 0 }));
        syncer.onLog(
            logs.deposit(OWNER, USDC, VAULT_1, 1n, {
                blockNumber: 90n,
                logIndex: 0,
                removed: true,
            }),
        );
        expect(syncer.firstBlock).toBe(100n);
    });

    it("should go on with the other parked events when the apply of one throws", async () => {
        await syncer.applySnapshot([], S);
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 101n, logIndex: 1 }));
        await syncer.settled();
        expect(syncer.stats.parked).toBe(2);

        sink.addOrder.mockRejectedValueOnce(new Error("sink down"));
        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 1n, 101n);
        syncer.resolveVaultBalance(vault(OWNER, WETH, VAULT_2), 1n, 101n);
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        expect(sink.addOrder.mock.calls[1][0].orderHash).toBe(HASH_B);
        expect(syncer.stats.failed).toBe(1);
    });

    it("should give an added order the meta that comes after its add, and a parked add its meta", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        const tx = ("0x" + "e".repeat(64)) as Hex;
        const at = (logIndex: number) => ({ blockNumber: 101n, logIndex, transactionHash: tx });
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), at(0)));
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        expect(sink.addOrder.mock.calls[1][0].meta).toBeUndefined();

        syncer.onLog(logs.meta(HASH_B, "0xabcd", at(1)));
        await syncer.settled();
        expect(sink.updateMeta).toHaveBeenCalledWith(ORDERBOOK, OWNER, HASH_B, "0xabcd");
        expect(syncer.orders.get(HASH_B)?.meta).toBe("0xabcd");
        // a reorg that removes the meta changes nothing, it undoes the add with it
        syncer.onLog(logs.meta(HASH_B, "0xabcd", { ...at(1), removed: true }));
        await syncer.settled();
        expect(sink.updateMeta).toHaveBeenCalledTimes(1);

        // an add that parks for a token takes the meta, and applies with it
        const hashC = ("0x" + "c".repeat(64)) as Hex;
        const token = "0x00000000000000000000000000000000000000d0" as Hex;
        const parked = { ...order(OWNER, 3), validInputs: [{ token, vaultId: VAULT_1 }] };
        const tx2 = ("0x" + "d".repeat(64)) as Hex;
        const at2 = (logIndex: number) => ({ blockNumber: 102n, logIndex, transactionHash: tx2 });
        syncer.onLog(logs.addOrder(hashC, parked, at2(0)));
        syncer.onLog(logs.meta(hashC, "0x1234", at2(1)));
        await syncer.settled();
        expect(syncer.stats.parked).toBe(1);
        expect(sink.updateMeta).toHaveBeenCalledTimes(1);
        syncer.resolveToken({ address: token, decimals: 18, symbol: "TKN" });
        syncer.resolveVaultBalance(vault(OWNER, token, VAULT_1), 1n, 102n);
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(3);
        expect(sink.addOrder.mock.calls[2][0].meta).toBe("0x1234");
    });

    it("should keep the live events in the buffer while a hole is filled, and apply them in chain order after it", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        syncer.holdLive();
        // the new stream serves a newer log first, the backfill the older one after it
        syncer.onLog(logs.removeOrder(HASH_B, order(OWNER, 2), { blockNumber: 110n, logIndex: 0 }));
        syncer.onLog(logs.addOrder(HASH_B, order(OWNER, 2), { blockNumber: 105n, logIndex: 0 }));
        // a log at or below the snapshot block, the snapshot holds it
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 999n, { blockNumber: S, logIndex: 0 }));
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(sink.removeOrder).not.toHaveBeenCalled();
        expect(syncer.ingestor.bufferedCount).toBe(3);

        syncer.resumeLive();
        await syncer.settled();
        expect(sink.addOrder).toHaveBeenCalledTimes(2);
        expect(sink.addOrder.mock.invocationCallOrder[1]).toBeLessThan(
            sink.removeOrder.mock.invocationCallOrder[0],
        );
        expect(syncer.orders.get(HASH_B)?.active).toBe(false);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_000n);

        // live again, a new log applies at once
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 1n, { blockNumber: 111n, logIndex: 0 }));
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_001n);
    });

    it("should stay in the buffer after the snapshot while a hole that opened before it is filled", async () => {
        syncer.holdLive();
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 5n, { blockNumber: 102n, logIndex: 0 }));
        const report = await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        expect(syncer.phase).toBe("live");
        expect(report.eventsReplayed).toBe(0);
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_000n);

        // the backfill of the hole, then the hole is filled
        syncer.onLog(logs.deposit(OWNER, USDC, VAULT_1, 3n, { blockNumber: 101n, logIndex: 0 }));
        syncer.resumeLive();
        await syncer.settled();
        expect(balanceOf(OWNER, USDC, VAULT_1)).toBe(1_008n);
        expect(syncer.ingestor.mode).toBe("live");
    });

    it("should call onPark once for a new park, and retry the parked events once for a batch of reads", async () => {
        const onPark = vi.fn();
        syncer = new OrderbookSyncer({ orderbook: ORDERBOOK, sink, onPark });
        await syncer.applySnapshot([], S);
        syncer.onLog(logs.addOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.stats.parked).toBe(1);
        expect(onPark).toHaveBeenCalledTimes(1);
        const retry = vi.spyOn(syncer as any, "retryParked");

        // the tokens of one batch cause one retry, the add parks again for its
        // vaults, which is not a new park
        syncer.resolveToken(USDC_DETAILS);
        syncer.resolveToken(WETH_DETAILS);
        await syncer.settled();
        expect(retry).toHaveBeenCalledTimes(1);
        expect(syncer.stats.parked).toBe(1);
        expect(onPark).toHaveBeenCalledTimes(1);

        // the vaults of one batch cause one retry, and the add applies
        syncer.resolveVaultBalance(vault(OWNER, USDC, VAULT_1), 0n, 102n);
        syncer.resolveVaultBalance(vault(OWNER, WETH, VAULT_2), 5n, 102n);
        await syncer.settled();
        expect(retry).toHaveBeenCalledTimes(2);
        expect(sink.addOrder).toHaveBeenCalledTimes(1);
        expect(syncer.needs()).toEqual({ tokens: [], vaults: [] });
    });

    it("should forget a removed order once it is deep enough for no reorg to reach it", async () => {
        await syncer.applySnapshot([sgOrder(HASH_A, order(), 1_000n, 5n)], S);
        syncer.onLog(logs.removeOrder(HASH_A, order(), { blockNumber: 101n, logIndex: 0 }));
        await syncer.settled();
        expect(syncer.orders.get(HASH_A)).toMatchObject({ active: false, removedAt: 101n });

        syncer.onBlock(101n + OrderbookSyncer.INACTIVE_ORDER_BLOCKS);
        expect(syncer.orders.has(HASH_A)).toBe(true);
        syncer.onBlock(102n + OrderbookSyncer.INACTIVE_ORDER_BLOCKS);
        expect(syncer.orders.has(HASH_A)).toBe(false);
    });

    it("should refuse a snapshot from outside while a start is pending", async () => {
        const started = syncer.start({
            getIndexedBlock: vi.fn().mockResolvedValue(10_000n),
            fetchOrders: vi.fn().mockResolvedValue([]),
            fetchLogs: vi.fn().mockResolvedValue([]),
        });
        await expect(syncer.applySnapshot([], S)).rejects.toThrow("a start is pending");
        expect(syncer.phase).toBe("buffering");
        for (let block = 100n; block <= 106n; block++) syncer.onBlock(block);
        await started;
        expect(syncer.phase).toBe("live");
    });

    it("should apply the snapshot only once", async () => {
        await syncer.applySnapshot([], S);
        await expect(syncer.applySnapshot([], S)).rejects.toThrow("only be applied once");
    });

    describe("a v4 orderbook", () => {
        /** A snapshot order of the v4 fixture order, the balances as decimal strings of token units */
        const sgOrderV3 = (hash: Hex, usdc: bigint, weth: bigint): SgOrder => ({
            __version: SubgraphVersions.LEGACY,
            id: hash,
            owner: OWNER,
            orderHash: hash,
            orderBytes: toOrderBytesV3(orderV3()),
            active: true,
            nonce: orderV3().nonce,
            orderbook: { id: ORDERBOOK },
            inputs: [{ balance: usdc.toString(), vaultId: "1", token: USDC_DETAILS }],
            outputs: [{ balance: weth.toString(), vaultId: "2", token: WETH_DETAILS }],
        });
        const v4Vault = (token: Hex, vaultId: bigint) => ({
            orderbook: ORDERBOOK,
            owner: OWNER,
            token,
            vaultId,
        });
        const ONE_WETH = 10n ** 18n;

        it("should sync the orders and the vaults in token units, and hand the orders out as v4 ones", async () => {
            syncer = new OrderbookSyncer({
                orderbook: ORDERBOOK,
                sink,
                version: SubgraphVersions.LEGACY,
            });
            await syncer.applySnapshot([sgOrderV3(HASH_A, 1_000n, 5n * ONE_WETH)], S);
            expect(syncer.orderType).toBe(Order.Type.V3);
            expect(syncer.ledger.balance(v4Vault(USDC, 1n))).toBe(1_000n);

            // a deposit, then a take of 1 weth for 2 usdc, all in token units
            syncer.onLog(logsV4.deposit(OWNER, USDC, 1n, 40n, { blockNumber: 101n, logIndex: 0 }));
            syncer.onLog(
                logsV4.takeOrder(orderV3(), ONE_WETH, 2n, { blockNumber: 101n, logIndex: 1 }),
            );
            await syncer.settled();
            expect(syncer.ledger.balance(v4Vault(USDC, 1n))).toBe(1_042n);
            expect(syncer.ledger.balance(v4Vault(WETH, 2n))).toBe(4n * ONE_WETH);

            // a new order on the same vaults, the balances as decimal strings
            syncer.onLog(
                logsV4.addOrder(HASH_B, orderV3(OWNER, 2), { blockNumber: 102n, logIndex: 0 }),
            );
            await syncer.settled();
            expect(sink.addOrder).toHaveBeenCalledTimes(2);
            const added: SgOrder = sink.addOrder.mock.calls[1][0];
            expect(added.__version).toBe(SubgraphVersions.LEGACY);
            expect(added.inputs[0].balance).toBe("1042");
            expect(added.outputs[0].balance).toBe((4n * ONE_WETH).toString());
            expect(Order.V3.tryFromBytes(added.orderBytes).isOk()).toBe(true);

            // a removal takes it out again
            syncer.onLog(
                logsV4.removeOrder(HASH_B, orderV3(OWNER, 2), { blockNumber: 103n, logIndex: 0 }),
            );
            await syncer.settled();
            expect(sink.removeOrder).toHaveBeenCalledTimes(1);
            expect(syncer.orders.get(HASH_B)?.active).toBe(false);
        });

        it("should track vault id 0 as a vault, only a v6 orderbook has vaultless ios", async () => {
            syncer = new OrderbookSyncer({
                orderbook: ORDERBOOK,
                sink,
                version: SubgraphVersions.LEGACY,
            });
            await syncer.applySnapshot([], S);
            syncer.resolveToken(USDC_DETAILS);
            syncer.resolveToken(WETH_DETAILS);
            const raw = {
                ...orderV3(),
                validOutputs: [{ token: WETH, decimals: 18, vaultId: 0n }],
            };
            syncer.onLog(logsV4.addOrder(HASH_A, raw, { blockNumber: 101n, logIndex: 0 }));
            await syncer.settled();
            expect(sink.addOrder).not.toHaveBeenCalled();
            expect(syncer.needs().vaults).toEqual([v4Vault(USDC, 1n), v4Vault(WETH, 0n)]);
        });
    });
});
