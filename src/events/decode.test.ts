import { Order } from "../order";
import { getAddress } from "viem";
import { describe, it, expect, assert } from "vitest";
import { clearChanges, decodeOrderbookLog } from "./decode";
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
    VAULT_1,
    VAULT_2,
    VAULT_3,
    ORDERBOOK,
} from "./fixtures";

const at = { blockNumber: 100n, logIndex: 3 };

describe("Test decodeOrderbookLog", () => {
    it("should decode a deposit as an increase of the sender's vault in token units", () => {
        const result = decodeOrderbookLog(logs.deposit(OWNER, USDC, VAULT_1, 1_500_000n, at));
        assert(result.isOk() && result.value?.type === "Deposit");
        expect(result.value.ref).toEqual({
            blockNumber: 100n,
            logIndex: 3,
            transactionHash: expect.any(String),
        });
        expect(result.value.orderbook).toBe(ORDERBOOK);
        expect(result.value.changes).toEqual([
            {
                vault: {
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: USDC,
                    vaultId: BigInt(VAULT_1),
                },
                amount: { raw: 1_500_000n },
                sign: 1,
            },
        ]);
    });

    it("should decode a withdrawal as a decrease by the amount that left the vault", () => {
        const result = decodeOrderbookLog(logs.withdraw(OWNER, WETH, VAULT_2, 7n, 18, at));
        assert(result.isOk() && result.value?.type === "Withdraw");
        expect(result.value.changes).toEqual([
            {
                vault: {
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: WETH,
                    vaultId: BigInt(VAULT_2),
                },
                amount: { raw: 7n },
                sign: -1,
            },
        ]);
    });

    it("should decode an add with the order lower cased and the bytes the order manager decodes", () => {
        // a checksummed owner, so the mixed case is a valid address to encode
        const raw = order(getAddress(OWNER));
        const result = decodeOrderbookLog(logs.addOrder(HASH_A, raw, at));
        assert(result.isOk() && result.value?.type === "AddOrder");
        expect(result.value.orderHash).toBe(HASH_A);
        expect(result.value.order.owner).toBe(OWNER);
        expect(result.value.order.type).toBe(Order.Type.V4);
        expect(result.value.order.validInputs).toEqual([{ token: USDC, vaultId: VAULT_1 }]);
        expect(result.value.order.validOutputs).toEqual([{ token: WETH, vaultId: VAULT_2 }]);
        // the bytes round trip to the same struct
        const decoded = Order.V4.tryFromBytes(result.value.orderBytes);
        assert(decoded.isOk());
        expect(decoded.value).toEqual(result.value.order);
        expect(result.value.meta).toBeUndefined();
    });

    it("should decode a removal the same way", () => {
        const result = decodeOrderbookLog(logs.removeOrder(HASH_A, order(), at));
        assert(result.isOk() && result.value?.type === "RemoveOrder");
        expect(result.value.orderHash).toBe(HASH_A);
        expect(result.value.order.owner).toBe(OWNER);
    });

    it("should decode a take with the amounts facing the taker, its input out of the order's output vault", () => {
        // the taker takes one weth in, out of the order's output vault, and pays
        // two usdc out, into the order's input vault
        const takerInput = float(10n ** 18n, 18);
        const takerOutput = float(2_000_000n, 6);
        const result = decodeOrderbookLog(logs.takeOrder(order(), takerInput, takerOutput, at));
        assert(result.isOk() && result.value?.type === "TakeOrder");
        expect(result.value.changes).toEqual([
            {
                vault: {
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: WETH,
                    vaultId: BigInt(VAULT_2),
                },
                amount: { float: takerInput },
                sign: -1,
            },
            {
                vault: {
                    orderbook: ORDERBOOK,
                    owner: OWNER,
                    token: USDC,
                    vaultId: BigInt(VAULT_1),
                },
                amount: { float: takerOutput },
                sign: 1,
            },
        ]);
    });

    it("should decode the two halves of a clear and build the changes of both orders and the bounties", () => {
        const alice = order(OWNER);
        const bob = {
            ...order("0x0000000000000000000000000000000000000b22"),
            validInputs: [{ token: WETH, vaultId: VAULT_1 }],
            validOutputs: [{ token: USDC, vaultId: VAULT_2 }],
        };
        const start = decodeOrderbookLog(
            logs.clear(alice, bob, { alice: VAULT_3, bob: VAULT_3 }, at),
        );
        assert(start.isOk() && start.value?.type === "ClearStart");
        expect(start.value.sender).toBe(TAKER);
        expect(start.value.clearConfig.aliceBountyVaultId).toBe(VAULT_3);

        const change = {
            aliceOutput: float(10n, 18),
            bobOutput: float(30n, 6),
            aliceInput: float(25n, 6),
            bobInput: float(8n, 18),
        };
        const after = decodeOrderbookLog(logs.afterClear(change, { ...at, logIndex: 4 }));
        assert(after.isOk() && after.value?.type === "AfterClear");
        // the amounts of a v5 or v6 orderbook are rain floats
        expect(after.value.stateChange).toEqual({
            aliceOutput: { float: change.aliceOutput },
            bobOutput: { float: change.bobOutput },
            aliceInput: { float: change.aliceInput },
            bobInput: { float: change.bobInput },
        });

        const changes = clearChanges(start.value, after.value);
        const v = (owner: string, token: string, vaultId: string) => ({
            orderbook: ORDERBOOK,
            owner,
            token,
            vaultId: BigInt(vaultId),
        });
        expect(changes).toEqual([
            // alice pays weth out of vault 2 and takes usdc into vault 1
            { vault: v(OWNER, WETH, VAULT_2), amount: { float: change.aliceOutput }, sign: -1 },
            { vault: v(OWNER, USDC, VAULT_1), amount: { float: change.aliceInput }, sign: 1 },
            // bob pays usdc out of vault 2 and takes weth into vault 1
            { vault: v(bob.owner, USDC, VAULT_2), amount: { float: change.bobOutput }, sign: -1 },
            { vault: v(bob.owner, WETH, VAULT_1), amount: { float: change.bobInput }, sign: 1 },
            // the clearer keeps what alice paid over what bob took, in alice's output token
            { vault: v(TAKER, WETH, VAULT_3), amount: { float: change.aliceOutput }, sign: 1 },
            { vault: v(TAKER, WETH, VAULT_3), amount: { float: change.bobInput }, sign: -1 },
            // and what bob paid over what alice took, in bob's output token
            { vault: v(TAKER, USDC, VAULT_3), amount: { float: change.bobOutput }, sign: 1 },
            { vault: v(TAKER, USDC, VAULT_3), amount: { float: change.aliceInput }, sign: -1 },
        ]);
    });

    it("should decode a meta log with its subject as the order hash", () => {
        const result = decodeOrderbookLog(logs.meta(HASH_A, "0xabcd", at));
        assert(result.isOk() && result.value?.type === "Meta");
        expect(result.value.orderHash).toBe(HASH_A);
        expect(result.value.meta).toBe("0xabcd");
    });

    it("should ignore the events the module does not read and unknown signatures", () => {
        const notFound = decodeOrderbookLog(logs.orderNotFound(HASH_A, at));
        assert(notFound.isOk());
        expect(notFound.value).toBeUndefined();

        const unknown = decodeOrderbookLog({
            ...logs.deposit(OWNER, USDC, VAULT_1, 1n, at),
            topics: ["0x" + "9".repeat(64)] as any,
        });
        assert(unknown.isOk());
        expect(unknown.value).toBeUndefined();
    });

    it("should err on a log with a known signature that does not decode", () => {
        const result = decodeOrderbookLog({
            ...logs.deposit(OWNER, USDC, VAULT_1, 1n, at),
            data: "0x1234",
        });
        expect(result.isErr()).toBe(true);
    });
});

describe("Test decodeOrderbookLog for a v4 orderbook", () => {
    const v = (owner: string, token: string, vaultId: bigint) => ({
        orderbook: ORDERBOOK,
        owner,
        token,
        vaultId,
    });

    it("should decode an add and a removal with a v3 order and its bytes", () => {
        const added = decodeOrderbookLog(logsV4.addOrder(HASH_A, orderV3(), at));
        assert(added.isOk() && added.value?.type === "AddOrder");
        expect(added.value.order).toEqual({
            type: Order.Type.V3,
            ...orderV3(),
        });
        // the bytes decode to the same v3 order the subgraph would serve
        const fromBytes = Order.V3.tryFromBytes(added.value.orderBytes);
        assert(fromBytes.isOk());
        expect(fromBytes.value).toEqual(added.value.order);

        const removed = decodeOrderbookLog(logsV4.removeOrder(HASH_A, orderV3(), at));
        assert(removed.isOk() && removed.value?.type === "RemoveOrder");
        expect(removed.value.orderHash).toBe(HASH_A);
        expect(removed.value.order.type).toBe(Order.Type.V3);
    });

    it("should decode a deposit and a withdrawal in token units, the vault id a uint256", () => {
        const deposit = decodeOrderbookLog(logsV4.deposit(OWNER, USDC, 7n, 1_500n, at));
        assert(deposit.isOk() && deposit.value?.type === "Deposit");
        expect(deposit.value.changes).toEqual([
            { vault: v(OWNER, USDC, 7n), amount: { raw: 1_500n }, sign: 1 },
        ]);

        // the amount that left the vault, not the target
        const withdraw = decodeOrderbookLog(logsV4.withdraw(OWNER, USDC, 7n, 500n, at));
        assert(withdraw.isOk() && withdraw.value?.type === "Withdraw");
        expect(withdraw.value.changes).toEqual([
            { vault: v(OWNER, USDC, 7n), amount: { raw: 500n }, sign: -1 },
        ]);
    });

    it("should decode a take in token units, out of the order output vault and into its input vault", () => {
        const take = decodeOrderbookLog(logsV4.takeOrder(orderV3(), 10n ** 18n, 2_000_000n, at));
        assert(take.isOk() && take.value?.type === "TakeOrder");
        expect(take.value.changes).toEqual([
            { vault: v(OWNER, WETH, 2n), amount: { raw: 10n ** 18n }, sign: -1 },
            { vault: v(OWNER, USDC, 1n), amount: { raw: 2_000_000n }, sign: 1 },
        ]);
    });

    it("should decode the two halves of a clear in token units and build the changes", () => {
        const bob = {
            ...orderV3("0x0000000000000000000000000000000000000b22"),
            validInputs: [{ token: WETH, decimals: 18, vaultId: 1n }],
            validOutputs: [{ token: USDC, decimals: 6, vaultId: 2n }],
        };
        const start = decodeOrderbookLog(logsV4.clear(orderV3(), bob, { alice: 3n, bob: 3n }, at));
        assert(start.isOk() && start.value?.type === "ClearStart");
        expect(start.value.alice.type).toBe(Order.Type.V3);
        expect(start.value.clearConfig.aliceBountyVaultId).toBe(3n);

        const change = { aliceOutput: 10n, bobOutput: 30n, aliceInput: 25n, bobInput: 8n };
        const after = decodeOrderbookLog(logsV4.afterClear(change, { ...at, logIndex: 4 }));
        assert(after.isOk() && after.value?.type === "AfterClear");
        expect(after.value.stateChange).toEqual({
            aliceOutput: { raw: 10n },
            bobOutput: { raw: 30n },
            aliceInput: { raw: 25n },
            bobInput: { raw: 8n },
        });

        const changes = clearChanges(start.value, after.value);
        expect(changes).toEqual([
            { vault: v(OWNER, WETH, 2n), amount: { raw: 10n }, sign: -1 },
            { vault: v(OWNER, USDC, 1n), amount: { raw: 25n }, sign: 1 },
            { vault: v(bob.owner, USDC, 2n), amount: { raw: 30n }, sign: -1 },
            { vault: v(bob.owner, WETH, 1n), amount: { raw: 8n }, sign: 1 },
            { vault: v(TAKER, WETH, 3n), amount: { raw: 10n }, sign: 1 },
            { vault: v(TAKER, WETH, 3n), amount: { raw: 8n }, sign: -1 },
            { vault: v(TAKER, USDC, 3n), amount: { raw: 30n }, sign: 1 },
            { vault: v(TAKER, USDC, 3n), amount: { raw: 25n }, sign: -1 },
        ]);
    });
});
