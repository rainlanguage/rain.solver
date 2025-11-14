import { RainSolver } from "..";
import { BaseError } from "viem";
import { Result } from "../../common";
import { Token } from "sushi/currency";
import { processReceipt } from "./receipt";
import { RainSolverSigner } from "../../signer";
import { SpanStatusCode } from "@opentelemetry/api";
import { PreAssembledSpan, SpanWithContext } from "../../logger";
import { withBigintSerializer, RawTransaction } from "../../common";
import {
    isTimeout,
    KnownErrors,
    ErrorSeverity,
    errorSnapshot,
    containsNodeError,
} from "../../error";
import {
    ProcessOrderSuccess,
    ProcessOrderFailure,
    ProcessOrderHaltReason,
    ProcessOrderResultBase,
    ProcessTransactionSuccess,
} from "../types";

/** Arguments for processing a transaction */
export type ProcessTransactionArgs = {
    signer: RainSolverSigner;
    rawtx: RawTransaction;
    orderbook: `0x${string}`;
    inputToEthPrice: string;
    outputToEthPrice: string;
    baseResult: ProcessOrderResultBase;
    toToken: Token;
    fromToken: Token;
    roundSpanCtx?: SpanWithContext;
};

/** Arguments needed for processing the transaction settlement in background */
export type TransactionSettlementArgs = ProcessTransactionArgs & {
    txhash: `0x${string}`;
    txUrl: string;
    txSendTime: number;
};

/**
 * Handles the given transaction, starts by sending the transaction and
 * then tries to get the receipt and process that in async manner, returns
 * a function that resolves with the ProcessOrderResult type when called
 * @param args - The arguments for processing the transaction
 * @returns A function that returns a promise resolving to the ProcessOrderResult
 */
export async function processTransaction(
    this: RainSolver,
    {
        rawtx,
        signer,
        toToken,
        fromToken,
        orderbook,
        baseResult,
        inputToEthPrice,
        outputToEthPrice,
        roundSpanCtx,
    }: ProcessTransactionArgs,
): Promise<() => Promise<Result<ProcessOrderSuccess, ProcessOrderFailure>>> {
    // submit the tx
    let hash: `0x${string}`, txUrl: string;
    let txSendTime = 0;
    try {
        rawtx.type = "legacy";
        ({ hash } = await signer.asWriteSigner().sendTx(rawtx as any));
        txUrl = signer.state.chainConfig.blockExplorers?.default.url + "/tx/" + hash;
        txSendTime = performance.now();
        // eslint-disable-next-line no-console
        console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
        baseResult.spanAttributes["details.txUrl"] = txUrl;

        // start getting tx receipt in background and return the settler fn
        const txSettlement = transactionSettlement.call(this, {
            txhash: hash,
            signer,
            rawtx,
            orderbook,
            inputToEthPrice,
            outputToEthPrice,
            baseResult: structuredClone(baseResult),
            txUrl,
            toToken,
            fromToken,
            txSendTime,
            roundSpanCtx,
        });

        const endTime = performance.now();
        const res: ProcessOrderSuccess = {
            ...baseResult,
            txUrl,
            endTime,
            txSettlement,
        };
        return async () => Result.ok(res);
    } catch (e) {
        // record rawtx in logs
        baseResult.spanAttributes["details.rawTx"] = JSON.stringify(
            {
                ...rawtx,
                from: signer.account.address,
            },
            withBigintSerializer,
        );
        baseResult.spanAttributes["txNoneNodeError"] = !(await containsNodeError(e as BaseError));
        const endTime = performance.now();
        return async () =>
            Result.err({
                ...baseResult,
                error: e,
                reason: ProcessOrderHaltReason.TxFailed,
                endTime,
            });
    }
}

/**
 * Processes the transaction settlement by waiting for the receipt, this is
 * meant to run in background while other orders keep on being processed.
 */
export async function transactionSettlement(
    this: RainSolver,
    {
        txhash,
        signer,
        rawtx,
        orderbook,
        inputToEthPrice,
        outputToEthPrice,
        baseResult,
        txUrl,
        toToken,
        fromToken,
        txSendTime,
        roundSpanCtx,
    }: TransactionSettlementArgs,
): Promise<Result<ProcessTransactionSuccess, ProcessOrderFailure>> {
    const report = new PreAssembledSpan(`tx_${baseResult.spanAttributes["details.pair"]}`);
    try {
        const receipt = await signer.waitForReceipt({ hash: txhash });
        const result = await processReceipt({
            receipt,
            signer,
            rawtx,
            orderbook,
            inputToEthPrice,
            outputToEthPrice,
            baseResult,
            txUrl,
            toToken,
            fromToken,
            txSendTime,
        });
        if (result.isOk()) {
            const value = result.value;

            // keep track of avg gas cost once transaction settles
            if (value.gasCost) {
                signer.state.gasCosts.push(value.gasCost);
            }

            // record span events and attrs
            report.recordOrderEvents(value.spanEvents);
            report.extendAttrs(value.spanAttributes);
            report.setStatus({ code: SpanStatusCode.OK, message: "found opportunity" });
        } else {
            const err = result.error;

            // record span events and attrs
            report.recordOrderEvents(err.spanEvents);
            report.extendAttrs(err.spanAttributes);

            // Tx reverted onchain, this can happen for example
            // because of mev front running or false positive opportunities, etc
            let message = "";
            if (err.error) {
                if ("snapshot" in err.error) {
                    message = err.error.snapshot;
                } else {
                    message = await errorSnapshot("transaction reverted onchain", err.error.err);
                }
                report.setAttr("errorDetails", message);
            }
            if (KnownErrors.every((v) => !message.includes(v))) {
                report.setAttr("severity", ErrorSeverity.HIGH);
            }
            if (err.spanAttributes["txNoneNodeError"]) {
                report.setAttr("severity", ErrorSeverity.HIGH);
            }
            report.setStatus({ code: SpanStatusCode.ERROR, message });
            report.setAttr("unsuccessfulClear", true);
            report.setAttr("txReverted", true);
        }

        report.end();
        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);

        return result;
    } catch (err: any) {
        report.setAttr(
            "details.rawTx",
            JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            ),
        );
        report.setAttr("txNoneNodeError", !(await containsNodeError(err)));

        // record span events and attrs
        report.recordOrderEvents(baseResult.spanEvents);
        report.extendAttrs(baseResult.spanAttributes);

        // tx failed to get included onchain, this can happen as result of timeout, rpc dropping the tx, etc
        const message = await errorSnapshot("transaction failed", err);
        report.setAttr("errorDetails", message);
        if (isTimeout(err)) {
            report.setAttr("severity", ErrorSeverity.LOW);
        } else {
            report.setAttr("severity", ErrorSeverity.HIGH);
        }
        report.setStatus({ code: SpanStatusCode.ERROR, message });
        report.setAttr("unsuccessfulClear", true);
        report.setAttr("txMineFailed", true);

        report.end();
        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);

        return Result.err({
            ...baseResult,
            txUrl,
            reason: ProcessOrderHaltReason.TxMineFailed,
            error: err,
            endTime: performance.now(),
        });
    }
}
