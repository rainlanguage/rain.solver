import { Order } from "../order";
import { ABI, Result } from "../common";
import { SYNC_EVENTS } from "./stream";
import { decodeEventLog, encodeAbiParameters } from "viem";
import { Amount, DecodedLog, Hex, LogRef, RawLog, VaultChange, VaultRef } from "./types";

/**
 * The orderbook events the module reads, of every orderbook version, any other
 * log of the contract is ignored. The event signature tells the version, the
 * v4 events have other names and shapes than the v5 and v6 ones, and the v5
 * and v6 events are the same
 */
const EVENTS = new Set<string>(SYNC_EVENTS.map((event) => event.name));

/** The order struct as viem decodes it from a v5 or v6 event */
type RawOrder = {
    owner: Hex;
    nonce: Hex;
    evaluable: { interpreter: Hex; store: Hex; bytecode: Hex };
    validInputs: readonly { token: Hex; vaultId: Hex }[];
    validOutputs: readonly { token: Hex; vaultId: Hex }[];
};

/** The order struct as viem decodes it from a v4 event */
type RawOrderV3 = {
    owner: Hex;
    nonce: Hex;
    evaluable: { interpreter: Hex; store: Hex; bytecode: Hex };
    validInputs: readonly { token: Hex; decimals: number; vaultId: bigint }[];
    validOutputs: readonly { token: Hex; decimals: number; vaultId: bigint }[];
};

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

/** Turns the decoded struct into the order type the rest of the app uses, addresses lower cased */
export function toOrder(raw: RawOrder): Order.V4 {
    return {
        type: Order.Type.V4,
        owner: lower(raw.owner),
        nonce: lower(raw.nonce),
        evaluable: {
            interpreter: lower(raw.evaluable.interpreter),
            store: lower(raw.evaluable.store),
            bytecode: lower(raw.evaluable.bytecode),
        },
        validInputs: raw.validInputs.map((io) => ({
            token: lower(io.token),
            vaultId: lower(io.vaultId),
        })),
        validOutputs: raw.validOutputs.map((io) => ({
            token: lower(io.token),
            vaultId: lower(io.vaultId),
        })),
    };
}

/** Turns the decoded struct of a v4 orderbook into the v3 order type, addresses lower cased */
export function toOrderV3(raw: RawOrderV3): Order.V3 {
    return {
        type: Order.Type.V3,
        owner: lower(raw.owner),
        nonce: lower(raw.nonce),
        evaluable: {
            interpreter: lower(raw.evaluable.interpreter),
            store: lower(raw.evaluable.store),
            bytecode: lower(raw.evaluable.bytecode),
        },
        validInputs: raw.validInputs.map((io) => ({
            token: lower(io.token),
            decimals: Number(io.decimals),
            vaultId: io.vaultId,
        })),
        validOutputs: raw.validOutputs.map((io) => ({
            token: lower(io.token),
            decimals: Number(io.decimals),
            vaultId: io.vaultId,
        })),
    };
}

/** Encodes the order struct back to the bytes the subgraph serves as orderBytes */
export function toOrderBytes(raw: RawOrder): Hex {
    return encodeAbiParameters(ABI.Orderbook.V6.Primary.OrderStructAbi, [raw]);
}

/** Encodes the order struct of a v4 orderbook back to the bytes the subgraph serves as orderBytes */
export function toOrderBytesV3(raw: RawOrderV3): Hex {
    return encodeAbiParameters(ABI.Orderbook.V4.Primary.OrderStructAbi, [raw]);
}

/**
 * Decodes one raw log of an orderbook of any version. Resolves with undefined
 * for a log of an event the module does not read. Errs when the log carries a
 * known event signature but does not decode, which points at a log of another
 * contract or a corrupt log.
 * @param log - The raw log
 */
export function decodeOrderbookLog(log: RawLog): Result<DecodedLog | undefined, Error> {
    let decoded: ReturnType<typeof decodeEventLog<typeof SYNC_EVENTS>>;
    try {
        decoded = decodeEventLog({
            abi: SYNC_EVENTS,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
    } catch (error: any) {
        // an unknown signature is not one of ours, anything else is a bad log
        if (error?.name === "AbiEventSignatureNotFoundError") return Result.ok(undefined);
        return Result.err(error instanceof Error ? error : new Error(String(error)));
    }
    if (!EVENTS.has(decoded.eventName)) return Result.ok(undefined);

    const orderbook = lower(log.address);
    const ref: LogRef = {
        blockNumber: log.blockNumber,
        transactionHash: lower(log.transactionHash),
        logIndex: log.logIndex,
    };
    switch (decoded.eventName) {
        case "AddOrderV3":
            return Result.ok({
                type: "AddOrder",
                ref,
                orderbook,
                orderHash: lower(decoded.args.orderHash),
                order: toOrder(decoded.args.order),
                orderBytes: toOrderBytes(decoded.args.order),
            });
        case "AddOrderV2":
            return Result.ok({
                type: "AddOrder",
                ref,
                orderbook,
                orderHash: lower(decoded.args.orderHash),
                order: toOrderV3(decoded.args.order),
                orderBytes: toOrderBytesV3(decoded.args.order),
            });
        case "RemoveOrderV3":
            return Result.ok({
                type: "RemoveOrder",
                ref,
                orderbook,
                orderHash: lower(decoded.args.orderHash),
                order: toOrder(decoded.args.order),
                orderBytes: toOrderBytes(decoded.args.order),
            });
        case "RemoveOrderV2":
            return Result.ok({
                type: "RemoveOrder",
                ref,
                orderbook,
                orderHash: lower(decoded.args.orderHash),
                order: toOrderV3(decoded.args.order),
                orderBytes: toOrderBytesV3(decoded.args.order),
            });
        case "DepositV2":
        case "Deposit": {
            const amount =
                decoded.eventName === "DepositV2"
                    ? decoded.args.depositAmountUint256
                    : decoded.args.amount;
            return Result.ok({
                type: "Deposit",
                ref,
                orderbook,
                changes: [
                    {
                        vault: vault(
                            orderbook,
                            decoded.args.sender,
                            decoded.args.token,
                            decoded.args.vaultId,
                        ),
                        amount: { raw: amount },
                        sign: 1,
                    },
                ],
            });
        }
        case "WithdrawV2":
        case "Withdraw": {
            // the amount that actually left the vault, the target may be more
            const amount =
                decoded.eventName === "WithdrawV2"
                    ? decoded.args.withdrawAmountUint256
                    : decoded.args.amount;
            return Result.ok({
                type: "Withdraw",
                ref,
                orderbook,
                changes: [
                    {
                        vault: vault(
                            orderbook,
                            decoded.args.sender,
                            decoded.args.token,
                            decoded.args.vaultId,
                        ),
                        amount: { raw: amount },
                        sign: -1,
                    },
                ],
            });
        }
        case "TakeOrderV3":
        case "TakeOrderV2": {
            // the amounts face the taker, the taker's input is what the order paid out
            // of its output vault, the taker's output what the order took into its
            // input vault, the same way the take orders config names them, rain
            // floats on a v5 or v6 orderbook, token units on a v4 one
            let order: Order;
            let input: Amount;
            let output: Amount;
            if (decoded.eventName === "TakeOrderV3") {
                order = toOrder(decoded.args.config.order);
                input = { float: decoded.args.input };
                output = { float: decoded.args.output };
            } else {
                order = toOrderV3(decoded.args.config.order);
                input = { raw: decoded.args.input };
                output = { raw: decoded.args.output };
            }
            const inputIO = order.validInputs[Number(decoded.args.config.inputIOIndex)];
            const outputIO = order.validOutputs[Number(decoded.args.config.outputIOIndex)];
            return Result.ok({
                type: "TakeOrder",
                ref,
                orderbook,
                changes: [
                    {
                        vault: vault(orderbook, order.owner, outputIO.token, outputIO.vaultId),
                        amount: input,
                        sign: -1,
                    },
                    {
                        vault: vault(orderbook, order.owner, inputIO.token, inputIO.vaultId),
                        amount: output,
                        sign: 1,
                    },
                ],
            });
        }
        case "ClearV3":
        case "ClearV2": {
            const { clearConfig } = decoded.args;
            const clearOrder = (raw: RawOrder | RawOrderV3) =>
                decoded.eventName === "ClearV3"
                    ? toOrder(raw as RawOrder)
                    : toOrderV3(raw as RawOrderV3);
            return Result.ok({
                type: "ClearStart",
                ref,
                orderbook,
                sender: lower(decoded.args.sender),
                alice: clearOrder(decoded.args.alice),
                bob: clearOrder(decoded.args.bob),
                clearConfig: {
                    aliceInputIOIndex: Number(clearConfig.aliceInputIOIndex),
                    aliceOutputIOIndex: Number(clearConfig.aliceOutputIOIndex),
                    bobInputIOIndex: Number(clearConfig.bobInputIOIndex),
                    bobOutputIOIndex: Number(clearConfig.bobOutputIOIndex),
                    aliceBountyVaultId: clearConfig.aliceBountyVaultId,
                    bobBountyVaultId: clearConfig.bobBountyVaultId,
                },
            });
        }
        case "AfterClearV2":
        case "AfterClear": {
            const change = decoded.args.clearStateChange;
            const amount = (value: Hex | bigint): Amount =>
                typeof value === "bigint" ? { raw: value } : { float: value };
            return Result.ok({
                type: "AfterClear",
                ref,
                orderbook,
                stateChange: {
                    aliceOutput: amount(change.aliceOutput),
                    bobOutput: amount(change.bobOutput),
                    aliceInput: amount(change.aliceInput),
                    bobInput: amount(change.bobInput),
                },
            });
        }
        case "MetaV1_2":
            return Result.ok({
                type: "Meta",
                ref,
                orderbook,
                // the subject of the meta log is the order hash
                orderHash: lower(decoded.args.subject),
                meta: decoded.args.meta,
            });
        default:
            return Result.ok(undefined);
    }
}

/**
 * Builds the vault changes of a clear from its two halves. Each order pays out
 * of its output vault and takes into its input vault. The clearer gets the
 * difference of each side into a bounty vault of its own, so those get the pay
 * out added and the take in removed.
 * @param start - The clear log
 * @param after - The after clear log of the same transaction
 */
export function clearChanges(
    start: { sender: Hex; orderbook: Hex; alice: Order; bob: Order; clearConfig: any },
    after: {
        stateChange: {
            aliceOutput: Amount;
            bobOutput: Amount;
            aliceInput: Amount;
            bobInput: Amount;
        };
    },
): VaultChange[] {
    const { alice, bob, clearConfig: cfg, sender, orderbook } = start;
    const { aliceOutput, bobOutput, aliceInput, bobInput } = after.stateChange;
    const aliceIn = alice.validInputs[cfg.aliceInputIOIndex];
    const aliceOut = alice.validOutputs[cfg.aliceOutputIOIndex];
    const bobIn = bob.validInputs[cfg.bobInputIOIndex];
    const bobOut = bob.validOutputs[cfg.bobOutputIOIndex];
    const aliceBounty = vault(orderbook, sender, aliceOut.token, cfg.aliceBountyVaultId);
    const bobBounty = vault(orderbook, sender, bobOut.token, cfg.bobBountyVaultId);
    return [
        {
            vault: vault(orderbook, alice.owner, aliceOut.token, aliceOut.vaultId),
            amount: aliceOutput,
            sign: -1,
        },
        {
            vault: vault(orderbook, alice.owner, aliceIn.token, aliceIn.vaultId),
            amount: aliceInput,
            sign: 1,
        },
        {
            vault: vault(orderbook, bob.owner, bobOut.token, bobOut.vaultId),
            amount: bobOutput,
            sign: -1,
        },
        {
            vault: vault(orderbook, bob.owner, bobIn.token, bobIn.vaultId),
            amount: bobInput,
            sign: 1,
        },
        { vault: aliceBounty, amount: aliceOutput, sign: 1 },
        { vault: aliceBounty, amount: bobInput, sign: -1 },
        { vault: bobBounty, amount: bobOutput, sign: 1 },
        { vault: bobBounty, amount: aliceInput, sign: -1 },
    ];
}

/** The vault ref, the id from a bytes32 hex of a v5 or v6 orderbook or a uint256 of a v4 one */
function vault(orderbook: Hex, owner: Hex, token: Hex, vaultId: Hex | bigint): VaultRef {
    return { orderbook, owner: lower(owner), token: lower(token), vaultId: BigInt(vaultId) };
}
