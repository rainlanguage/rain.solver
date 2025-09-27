import { toNumber } from "../../math";
import { Token } from "sushi/currency";
import { handleRevert } from "../../error";
import { RainSolverSigner } from "../../signer";
import { formatUnits, TransactionReceipt } from "viem";
import { OpStackTransactionReceipt } from "viem/chains";
import { Result, sleep, RawTransaction } from "../../common";
import { getIncome, getTotalIncome, getActualClearAmount } from "./log";
import {
    ProcessOrderFailure,
    ProcessOrderSuccess,
    ProcessOrderHaltReason,
    ProcessOrderResultBase,
} from "../types";

/** Arguments for processing a transaction receipt */
export type ProcessReceiptArgs = {
    signer: RainSolverSigner;
    rawtx: RawTransaction;
    orderbook: `0x${string}`;
    inputToEthPrice: string;
    outputToEthPrice: string;
    baseResult: ProcessOrderResultBase;
    toToken: Token;
    fromToken: Token;
    receipt: TransactionReceipt;
    txUrl: string;
    txSendTime: number;
};

/**
 * Processes the transaction receipt after the transaction has been sent
 * @param args - The arguments for processing the receipt
 * @returns A promise that resolves to the result of processing the receipt
 */
export async function processReceipt({
    rawtx,
    txUrl,
    signer,
    receipt,
    toToken,
    fromToken,
    orderbook,
    txSendTime,
    baseResult,
    inputToEthPrice,
    outputToEthPrice,
}: ProcessReceiptArgs): Promise<Result<ProcessOrderSuccess, ProcessOrderFailure>> {
    const l1Fee = getL1Fee(receipt);
    const gasCost = receipt.effectiveGasPrice * receipt.gasUsed + l1Fee;

    // keep track of gas consumption of the account and bounty token
    baseResult.gasCost = gasCost;

    if (receipt.status === "success") {
        baseResult.spanAttributes["didClear"] = true;

        const clearActualAmount = getActualClearAmount(
            rawtx.to,
            orderbook,
            receipt,
            fromToken.decimals,
        );
        const inputTokenIncome = getIncome(signer.account.address, receipt, toToken.address);
        const outputTokenIncome = getIncome(signer.account.address, receipt, fromToken.address);
        const income = getTotalIncome(
            inputTokenIncome,
            outputTokenIncome,
            inputToEthPrice,
            outputToEthPrice,
            toToken.decimals,
            fromToken.decimals,
        );
        const netProfit = income ? income - gasCost : undefined;

        baseResult.spanAttributes["details.actualGasCost"] = toNumber(gasCost);
        if (l1Fee) {
            baseResult.spanAttributes["details.gasCostL1"] = toNumber(l1Fee);
        }
        if (income) {
            baseResult.spanAttributes["details.income"] = toNumber(income);
            baseResult.spanAttributes["details.netProfit"] = toNumber(netProfit!);
        }
        if (inputTokenIncome) {
            baseResult.spanAttributes["details.inputTokenIncome"] = formatUnits(
                inputTokenIncome,
                toToken.decimals,
            );
        }
        if (outputTokenIncome) {
            baseResult.spanAttributes["details.outputTokenIncome"] = formatUnits(
                outputTokenIncome,
                fromToken.decimals,
            );
        }

        const success: ProcessOrderSuccess = {
            ...baseResult,
            clearedAmount: clearActualAmount?.toString(),
            gasCost: gasCost,
            income,
            txUrl,
            inputTokenIncome: baseResult.spanAttributes["details.inputTokenIncome"] as any,
            outputTokenIncome: baseResult.spanAttributes["details.outputTokenIncome"] as any,
            netProfit,
            endTime: performance.now(),
        };

        return Result.ok({
            ...baseResult,
            ...success,
        });
    } else {
        const simulation = await (async () => {
            const signerBalance = await signer.getSelfBalance();
            const result = await handleRevert(
                signer,
                receipt.transactionHash,
                receipt,
                rawtx,
                signerBalance,
                orderbook,
            );
            if (result.snapshot.includes("simulation failed to find the revert reason")) {
                // wait at least 90s before simulating the revert tx
                // in order for rpcs to catch up, this is concurrent to
                // whole bot operation, so ideally all of it or at least
                // partially will overlap with when bot is processing other
                // orders
                await sleep(Math.max(90_000 + txSendTime - Date.now(), 0));
                return await handleRevert(
                    signer,
                    receipt.transactionHash,
                    receipt,
                    rawtx,
                    signerBalance,
                    orderbook,
                );
            } else {
                return result;
            }
        })();
        if (simulation) {
            baseResult.spanAttributes["txNoneNodeError"] = !simulation.nodeError;
        }
        const failure: ProcessOrderFailure = {
            ...baseResult,
            txUrl,
            error: simulation,
            reason: ProcessOrderHaltReason.TxReverted,
            endTime: performance.now(),
        };
        return Result.err(failure);
    }
}

/**
 * Returns the L1 gas cost of a transaction
 * @param receipt - The transaction receipt
 * @returns The L1 fee as a bigint, or 0n if not applicable
 */
export function getL1Fee(receipt: OpStackTransactionReceipt | TransactionReceipt): bigint {
    if ("l1Fee" in receipt && typeof receipt.l1Fee === "bigint") {
        return receipt.l1Fee;
    } else if (
        "l1GasPrice" in receipt &&
        "l1GasUsed" in receipt &&
        typeof receipt.l1GasPrice === "bigint" &&
        typeof receipt.l1GasUsed === "bigint"
    ) {
        return (receipt.l1GasPrice as bigint) * (receipt.l1GasUsed as bigint);
    } else {
        return 0n;
    }
}
