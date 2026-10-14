import { ABI, toFloat } from "../common";
import { AbiEvent, encodeAbiParameters, getAbiItem, toEventSelector } from "viem";
import { Hex, RawLog } from "./types";

// Test fixtures for the events module, raw logs of a v6 orderbook, and of a v4
// one with logsV4, built from event args, the way a node would serve them. None
// of the events the module
// reads has an indexed parameter, so the data is the encoding of every input
// and the only topic is the event selector.

export const ORDERBOOK = "0x000000000000000000000000000000000000b006" as Hex;
export const OWNER = "0x0000000000000000000000000000000000000a11" as Hex;
export const TAKER = "0x0000000000000000000000000000000000000b0b" as Hex;
export const USDC = "0x00000000000000000000000000000000000000c0" as Hex;
export const WETH = "0x00000000000000000000000000000000000000e0" as Hex;
export const VAULT_1 = ("0x" + "1".padStart(64, "0")) as Hex;
export const VAULT_2 = ("0x" + "2".padStart(64, "0")) as Hex;
export const VAULT_3 = ("0x" + "3".padStart(64, "0")) as Hex;
export const HASH_A = ("0x" + "a".repeat(64)) as Hex;
export const HASH_B = ("0x" + "b".repeat(64)) as Hex;

export const USDC_DETAILS = { address: USDC, decimals: 6, symbol: "USDC" };
export const WETH_DETAILS = { address: WETH, decimals: 18, symbol: "WETH" };

/** An order struct as the event args carry it */
export type RawOrderArgs = {
    owner: Hex;
    nonce: Hex;
    evaluable: { interpreter: Hex; store: Hex; bytecode: Hex };
    validInputs: { token: Hex; vaultId: Hex }[];
    validOutputs: { token: Hex; vaultId: Hex }[];
};

/** An order of the given owner buying usdc into vault 1 and selling weth out of vault 2 */
export function order(owner: Hex = OWNER, nonce = 1): RawOrderArgs {
    return {
        owner,
        nonce: ("0x" + nonce.toString(16).padStart(64, "0")) as Hex,
        evaluable: {
            interpreter: "0x0000000000000000000000000000000000000001",
            store: "0x0000000000000000000000000000000000000002",
            bytecode: "0x1234",
        },
        validInputs: [{ token: USDC, vaultId: VAULT_1 }],
        validOutputs: [{ token: WETH, vaultId: VAULT_2 }],
    };
}

/** A rain float of the given token units */
export function float(units: bigint, decimals: number): Hex {
    const result = toFloat(units, decimals);
    if (result.isErr()) throw result.error;
    return result.value;
}

/** Where a log sits, the transaction hash derives from the block and index unless given */
export type Where = {
    blockNumber: bigint;
    logIndex: number;
    transactionHash?: Hex;
    removed?: boolean;
};

/** Builds the raw log of an orderbook event with the given args, of a v6 orderbook unless another abi is given */
export function makeLog(
    eventName: string,
    args: Record<string, unknown>,
    where: Where,
    address: Hex = ORDERBOOK,
    abi: readonly unknown[] = ABI.Orderbook.V6.Primary.Orderbook,
): RawLog {
    const item = getAbiItem({ abi: abi as any, name: eventName as any }) as AbiEvent | undefined;
    if (!item || item.type !== "event") throw new Error(`no event ${eventName}`);
    const values = item.inputs.map((input) => args[input.name!]);
    return {
        address,
        topics: [toEventSelector(item)],
        data: encodeAbiParameters(item.inputs, values),
        blockNumber: where.blockNumber,
        transactionHash:
            where.transactionHash ??
            (("0x" +
                (where.blockNumber * 1000n + BigInt(where.logIndex))
                    .toString(16)
                    .padStart(64, "0")) as Hex),
        logIndex: where.logIndex,
        removed: where.removed,
    };
}

export const logs = {
    addOrder: (hash: Hex, o: RawOrderArgs, where: Where) =>
        makeLog("AddOrderV3", { sender: o.owner, orderHash: hash, order: o }, where),
    removeOrder: (hash: Hex, o: RawOrderArgs, where: Where) =>
        makeLog("RemoveOrderV3", { sender: o.owner, orderHash: hash, order: o }, where),
    meta: (hash: Hex, meta: Hex, where: Where, sender: Hex = OWNER) =>
        makeLog("MetaV1_2", { sender, subject: hash, meta }, where),
    deposit: (sender: Hex, token: Hex, vaultId: Hex, amount: bigint, where: Where) =>
        makeLog("DepositV2", { sender, token, vaultId, depositAmountUint256: amount }, where),
    withdraw: (
        sender: Hex,
        token: Hex,
        vaultId: Hex,
        amount: bigint,
        decimals: number,
        where: Where,
    ) =>
        makeLog(
            "WithdrawV2",
            {
                sender,
                token,
                vaultId,
                targetAmount: float(amount, decimals),
                withdrawAmount: float(amount, decimals),
                withdrawAmountUint256: amount,
            },
            where,
        ),
    /** A take of the order, the amounts face the taker, input is what it takes out of the order output vault, output what it pays into the order input vault */
    takeOrder: (o: RawOrderArgs, input: Hex, output: Hex, where: Where, taker: Hex = TAKER) =>
        makeLog(
            "TakeOrderV3",
            {
                sender: taker,
                config: { order: o, inputIOIndex: 0n, outputIOIndex: 0n, signedContext: [] },
                input,
                output,
            },
            where,
        ),
    clear: (
        alice: RawOrderArgs,
        bob: RawOrderArgs,
        bounty: { alice: Hex; bob: Hex },
        where: Where,
        sender: Hex = TAKER,
    ) =>
        makeLog(
            "ClearV3",
            {
                sender,
                alice,
                bob,
                clearConfig: {
                    aliceInputIOIndex: 0n,
                    aliceOutputIOIndex: 0n,
                    bobInputIOIndex: 0n,
                    bobOutputIOIndex: 0n,
                    aliceBountyVaultId: bounty.alice,
                    bobBountyVaultId: bounty.bob,
                },
            },
            where,
        ),
    afterClear: (
        change: { aliceOutput: Hex; bobOutput: Hex; aliceInput: Hex; bobInput: Hex },
        where: Where,
        sender: Hex = TAKER,
    ) => makeLog("AfterClearV2", { sender, clearStateChange: change }, where),
    /** An event the module does not read */
    orderNotFound: (hash: Hex, where: Where) =>
        makeLog("OrderNotFound", { sender: TAKER, owner: OWNER, orderHash: hash }, where),
};

/** An order struct of a v4 orderbook as the event args carry it, a v3 order */
export type RawOrderV3Args = {
    owner: Hex;
    nonce: Hex;
    evaluable: { interpreter: Hex; store: Hex; bytecode: Hex };
    validInputs: { token: Hex; decimals: number; vaultId: bigint }[];
    validOutputs: { token: Hex; decimals: number; vaultId: bigint }[];
};

/** A v4 orderbook order of the given owner buying usdc into vault 1 and selling weth out of vault 2 */
export function orderV3(owner: Hex = OWNER, nonce = 1): RawOrderV3Args {
    return {
        owner,
        nonce: ("0x" + nonce.toString(16).padStart(64, "0")) as Hex,
        evaluable: {
            interpreter: "0x0000000000000000000000000000000000000001",
            store: "0x0000000000000000000000000000000000000002",
            bytecode: "0x1234",
        },
        validInputs: [{ token: USDC, decimals: 6, vaultId: 1n }],
        validOutputs: [{ token: WETH, decimals: 18, vaultId: 2n }],
    };
}

const makeLogV4 = (eventName: string, args: Record<string, unknown>, where: Where) =>
    makeLog(eventName, args, where, ORDERBOOK, ABI.Orderbook.V4.Primary.Orderbook);

/** Raw logs of a v4 orderbook, the amounts in token units, the vault ids uint256, no meta */
export const logsV4 = {
    addOrder: (hash: Hex, o: RawOrderV3Args, where: Where) =>
        makeLogV4("AddOrderV2", { sender: o.owner, orderHash: hash, order: o }, where),
    removeOrder: (hash: Hex, o: RawOrderV3Args, where: Where) =>
        makeLogV4("RemoveOrderV2", { sender: o.owner, orderHash: hash, order: o }, where),
    deposit: (sender: Hex, token: Hex, vaultId: bigint, amount: bigint, where: Where) =>
        makeLogV4("Deposit", { sender, token, vaultId, amount }, where),
    withdraw: (sender: Hex, token: Hex, vaultId: bigint, amount: bigint, where: Where) =>
        makeLogV4("Withdraw", { sender, token, vaultId, targetAmount: amount * 2n, amount }, where),
    /** A take of the order, the amounts face the taker, input out of the order output vault, output into its input vault */
    takeOrder: (o: RawOrderV3Args, input: bigint, output: bigint, where: Where, taker = TAKER) =>
        makeLogV4(
            "TakeOrderV2",
            {
                sender: taker,
                config: { order: o, inputIOIndex: 0n, outputIOIndex: 0n, signedContext: [] },
                input,
                output,
            },
            where,
        ),
    clear: (
        alice: RawOrderV3Args,
        bob: RawOrderV3Args,
        bounty: { alice: bigint; bob: bigint },
        where: Where,
        sender: Hex = TAKER,
    ) =>
        makeLogV4(
            "ClearV2",
            {
                sender,
                alice,
                bob,
                clearConfig: {
                    aliceInputIOIndex: 0n,
                    aliceOutputIOIndex: 0n,
                    bobInputIOIndex: 0n,
                    bobOutputIOIndex: 0n,
                    aliceBountyVaultId: bounty.alice,
                    bobBountyVaultId: bounty.bob,
                },
            },
            where,
        ),
    afterClear: (
        change: { aliceOutput: bigint; bobOutput: bigint; aliceInput: bigint; bobInput: bigint },
        where: Where,
        sender: Hex = TAKER,
    ) => makeLogV4("AfterClear", { sender, clearStateChange: change }, where),
};
