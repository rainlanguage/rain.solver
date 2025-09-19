import { isDeepStrictEqual } from "util";
import { tryDecodeError } from "./decoder";
import { getRpcError } from "../rpc/helpers";
import { ABI, RawTransaction } from "../common";
import { TxRevertError, DecodedErrorType } from "./types";
import { errorSnapshot, containsNodeError } from "./common";
import {
    Chain,
    isHex,
    Account,
    Transport,
    BaseError,
    PublicClient,
    TransactionReceipt,
    decodeFunctionData,
} from "viem";

/**
 * Handles a reverted transaction by simulating to figure out the revert reason,
 * this is the main way to identify the real cause of a revert, as it firstly checks
 * for gas insufficiency, and then simulates the tx and captures the reason, but still
 * checks for frontrunning before assuming the captured error was the real reason of
 * the revert
 * @param viemClient - The viem client
 * @param hash - The transaction hash
 * @param receipt - The transaction receipt
 * @param rawtx - The raw transaction
 * @param signerBalance - The signer's balance to check for out of gas errors
 * @param orderbook - The orderbook address to filter logs
 */
export async function handleRevert(
    viemClient: PublicClient<Transport, Chain | undefined, Account | undefined>,
    hash: `0x${string}`,
    receipt: TransactionReceipt,
    rawtx: RawTransaction,
    signerBalance: bigint,
    orderbook: `0x${string}`,
): Promise<{
    err: any;
    nodeError: boolean;
    snapshot: string;
    rawRevertError?: TxRevertError;
}> {
    const header = "transaction reverted onchain";
    try {
        // check if revert was due to out of gas issue
        const gasErr = evaluateGasSufficiency(receipt, rawtx, signerBalance);
        if (gasErr) {
            return {
                err: header + ", " + gasErr,
                nodeError: false,
                snapshot: header + ", " + gasErr,
            };
        }

        // simulate the tx and catch the error
        const tx = await viemClient.getTransaction({ hash });
        await viemClient.call({
            account: tx.from,
            to: tx.to,
            data: tx.input,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
            blockNumber: tx.blockNumber,
        });
        const msg =
            header +
            " but simulation failed to find the revert reason, please try to simulate the tx manualy for more details";
        return { err: msg, nodeError: false, snapshot: msg };
    } catch (err: any) {
        // check if revert was due to frontrun
        let frontrun: string | undefined = await tryDetectFrontrun(
            viemClient,
            rawtx,
            receipt,
            orderbook,
        );
        if (frontrun) {
            frontrun = `current transaction with hash ${
                receipt.transactionHash
            } has been actually frontrun by transaction with hash ${frontrun}`;
        }
        return {
            err,
            nodeError: await containsNodeError(err),
            snapshot: await errorSnapshot(header, err, { receipt, rawtx, signerBalance, frontrun }),
            rawRevertError: await parseRevertError(err),
        };
    }
}

/**
 * Parses a viem revert error to TxRevertError type
 * @param error - The viem error
 */
export async function parseRevertError(error: BaseError): Promise<TxRevertError> {
    const raw = getRpcError(error);
    let decoded: DecodedErrorType | undefined;
    if ("data" in raw && isHex(raw.data, { strict: true })) {
        const result = await tryDecodeError(raw.data);
        if (result.isOk()) {
            decoded = result.value;
        }
    }
    return { raw, decoded };
}

/**
 * Checks if the given transaction has enough gas or not
 * @param receipt - The transaction receipt
 * @param rawtx - The raw transaction that was broadcasted
 * @param signerBalance - The signer's balance
 */
export function evaluateGasSufficiency(
    receipt: TransactionReceipt,
    rawtx: RawTransaction,
    signerBalance: bigint,
): string | undefined {
    const txGasCost = receipt.effectiveGasPrice * receipt.gasUsed;
    if (signerBalance < txGasCost) {
        return "account ran out of gas for transaction gas cost";
    }
    if (typeof rawtx.gas === "bigint") {
        const percentage = (receipt.gasUsed * 100n) / rawtx.gas;
        if (percentage >= 98n) return "transaction ran out of specified gas";
    }
    return undefined;
}

/**
 * Checks if the given transaction has been frontrun by another transaction.
 * This is done by checking previouse transaction on the same block that emitted
 * the target event with the same TakeOrderConfigV3 struct.
 * @param viemClient - The viem client
 * @param rawtx - The raw transaction
 * @param receipt - The transaction receipt
 * @param orderbook - The orderbook address to filter logs
 * @returns the transaction hash of the frontrun if detected, otherwise undefined
 */
export async function tryDetectFrontrun(
    viemClient: PublicClient<Transport, Chain | undefined, Account | undefined>,
    rawtx: RawTransaction,
    receipt: TransactionReceipt,
    orderbook: `0x${string}`,
): Promise<string | undefined> {
    try {
        // get the order from the function data
        const orderConfig = (() => {
            try {
                if (rawtx.data!.toLowerCase().startsWith("0x4ed39461")) {
                    // arb4 trade
                    const result = decodeFunctionData({
                        abi: [ABI.Orderbook.Primary.Arb[1]],
                        data: rawtx.data!,
                    });
                    return (result?.args?.[1] as any)?.orders?.[0];
                } else {
                    // clear3 trade
                    const result = decodeFunctionData({
                        abi: [ABI.Orderbook.Primary.Orderbook[19]],
                        data: rawtx.data!,
                    });
                    return result?.args?.[1];
                }
            } catch {
                return undefined;
            }
        })();

        // check the transaction logs of the same block for same cleared order
        if (orderConfig) {
            const txHash = receipt.transactionHash.toLowerCase();
            const logs = (
                await viemClient.getLogs({
                    events: [
                        ABI.Orderbook.Primary.Orderbook[7],
                        ABI.Orderbook.Primary.Orderbook[8],
                    ],
                    address: orderbook,
                    blockHash: receipt.blockHash,
                })
            ).filter(
                (v) =>
                    receipt.transactionIndex > v.transactionIndex &&
                    v.transactionHash.toLowerCase() !== txHash,
            );
            if (logs.length) {
                for (const log of logs) {
                    if ("config" in log.args) {
                        if (isDeepStrictEqual(log.args.config, orderConfig)) {
                            return log.transactionHash;
                        }
                    }
                    if ("alice" in log.args) {
                        if (isDeepStrictEqual(log.args.alice, orderConfig)) {
                            return log.transactionHash;
                        }
                    }
                }
            }
        }
    } catch {}
    return undefined;
}
