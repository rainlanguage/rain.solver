import { RainSolver } from "..";
import { Pair } from "../../order";
import { iterRandom, Result } from "../../common";
import { SpanStatusCode } from "@opentelemetry/api";
import { PreAssembledSpan, SpanWithContext } from "../../logger";
import { ErrorSeverity, errorSnapshot, isTimeout, KnownErrors } from "../../error";
import {
    ProcessOrderStatus,
    ProcessOrderSuccess,
    ProcessOrderFailure,
    ProcessOrderHaltReason,
} from "../types";

/** Represents a settlement for a processed order */
export type Settlement = {
    pair: string;
    owner: string;
    orderHash: string;
    settle: () => Promise<Result<ProcessOrderSuccess, ProcessOrderFailure>>;
};

/**
 * Initializes a new round of processing orders
 */
export async function initializeRound(
    this: RainSolver,
    roundSpanCtx?: SpanWithContext,
    shuffle = true,
) {
    const orders = [...this.orderManager.getNextRoundOrders()];
    const settlements: Settlement[] = [];
    const checkpointReports: PreAssembledSpan[] = [];

    for (const orderDetails of iterOrders(orders, shuffle)) {
        const pair = `${orderDetails.buyTokenSymbol}/${orderDetails.sellTokenSymbol}`;
        const report = new PreAssembledSpan(`checkpoint_${pair}`);
        const owner = orderDetails.takeOrder.struct.order.owner.toLowerCase();
        report.extendAttrs({
            "details.pair": pair,
            "details.orderHash": orderDetails.takeOrder.id,
            "details.orderbook": orderDetails.orderbook,
            "details.owner": orderDetails.takeOrder.struct.order.owner,
        });

        // update the orderDetails vault balances from owner vaults map
        orderDetails.sellTokenVaultBalance =
            this.orderManager.ownerTokenVaultMap
                .get(orderDetails.orderbook)
                ?.get(owner)
                ?.get(orderDetails.sellToken)
                ?.get(
                    orderDetails.takeOrder.struct.order.validOutputs[
                        orderDetails.takeOrder.struct.outputIOIndex
                    ].vaultId,
                )?.balance ?? orderDetails.sellTokenVaultBalance;
        orderDetails.buyTokenVaultBalance =
            this.orderManager.ownerTokenVaultMap
                .get(orderDetails.orderbook)
                ?.get(owner)
                ?.get(orderDetails.buyToken)
                ?.get(
                    orderDetails.takeOrder.struct.order.validInputs[
                        orderDetails.takeOrder.struct.inputIOIndex
                    ].vaultId,
                )?.balance ?? orderDetails.buyTokenVaultBalance;

        // skip if the output vault is empty
        if (orderDetails.sellTokenVaultBalance <= 0n) {
            settlements.push({
                pair,
                orderHash: orderDetails.takeOrder.id,
                owner: orderDetails.takeOrder.struct.order.owner,
                settle: async () => {
                    return Result.ok({
                        tokenPair: pair,
                        buyToken: orderDetails.buyToken,
                        sellToken: orderDetails.sellToken,
                        status: ProcessOrderStatus.ZeroOutput,
                        spanAttributes: {
                            "details.pair": pair,
                            "details.orders": orderDetails.takeOrder.id,
                        },
                    });
                },
            });
            report.end();
            checkpointReports.push(report);

            // export the report to logger if logger is available
            this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
            continue;
        }

        // await for first available random free signer
        const signer = await this.walletManager.getRandomSigner(true);
        report.setAttr("details.sender", signer.account.address);

        // call process pair and save the settlement fn
        // to later settle without needing to pause if
        // there are more signers available
        const settle = await this.processOrder({
            orderDetails,
            signer,
        });
        settlements.push({
            settle,
            pair,
            orderHash: orderDetails.takeOrder.id,
            owner: orderDetails.takeOrder.struct.order.owner,
        });
        report.end();
        checkpointReports.push(report);

        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
    }

    return {
        settlements,
        checkpointReports,
    };
}

/**
 * Finalizes the round by settling all the orders that were processed and building reports.
 * @param settlements - Array of settlements to finalize
 */
export async function finalizeRound(
    this: RainSolver,
    settlements: Settlement[],
    roundSpanCtx?: SpanWithContext,
): Promise<{
    results: Result<ProcessOrderSuccess, ProcessOrderFailure>[];
    reports: PreAssembledSpan[];
}> {
    const results: Result<ProcessOrderSuccess, ProcessOrderFailure>[] = [];
    const reports: PreAssembledSpan[] = [];
    for (const { settle, pair, owner, orderHash } of settlements) {
        // instantiate a span report for this pair
        const report = new PreAssembledSpan(`order_${pair}`);
        report.setAttr("details.owner", owner);

        // settle the process results
        // this will return the report of the operation
        const result = await settle();
        results.push(result);

        if (result.isOk()) {
            const value = result.value;
            // keep track of avg gas cost
            if (value.gasCost) {
                this.state.gasCosts.push(value.gasCost);
            }

            // set the span attributes with the values gathered at processOrder()
            for (const attrKey in value.spanAttributes) {
                // record event attrs
                if (attrKey.startsWith("event.")) {
                    report.addEvent(
                        attrKey.replace("event.", ""),
                        undefined,
                        value.spanAttributes[attrKey] as number,
                    );
                    delete value.spanAttributes[attrKey];
                }
            }
            report.extendAttrs(value.spanAttributes);

            // set the otel span status based on report status
            switch (value.status) {
                case ProcessOrderStatus.ZeroOutput: {
                    report.setStatus({ code: SpanStatusCode.OK, message: "zero max output" });
                    break;
                }
                case ProcessOrderStatus.NoOpportunity: {
                    if (value.message) {
                        report.setStatus({ code: SpanStatusCode.ERROR, message: value.message });
                    } else {
                        report.setStatus({ code: SpanStatusCode.OK, message: "no opportunity" });
                    }
                    break;
                }
                case ProcessOrderStatus.FoundOpportunity: {
                    report.setStatus({ code: SpanStatusCode.OK, message: "found opportunity" });
                    break;
                }
                default: {
                    // set the span status to unexpected error
                    report.setAttr("severity", ErrorSeverity.HIGH);
                    report.setStatus({ code: SpanStatusCode.ERROR, message: "unexpected error" });
                }
            }
        } else {
            const err = result.error;
            // set the span attributes with the values gathered at processOrder()
            for (const attrKey in err.spanAttributes) {
                // record event attrs
                if (attrKey.startsWith("event.")) {
                    report.addEvent(
                        attrKey.replace("event.", ""),
                        undefined,
                        err.spanAttributes[attrKey] as number,
                    );
                    delete err.spanAttributes[attrKey];
                }
            }
            report.extendAttrs(err.spanAttributes);

            // Finalize the reports based on error type
            switch (err.reason) {
                case ProcessOrderHaltReason.FailedToQuote: {
                    let message = "failed to quote order: " + orderHash;
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToGetPools: {
                    let message = pair + ": failed to get pool details";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.recordException(err.error);
                    }
                    report.setAttr("severity", ErrorSeverity.MEDIUM);
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToGetEthPrice: {
                    // set OK status because a token might not have a pool and as a result eth price cannot
                    // be fetched for it and if it is set to ERROR it will constantly error on each round
                    // resulting in lots of false positives
                    let message = "failed to get eth price";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.setAttr("errorDetails", message);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToUpdatePools: {
                    let message = pair + ": failed to update pool details by event data";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.recordException(err.error);
                    }
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                    break;
                }
                case ProcessOrderHaltReason.TxFailed: {
                    // failed to submit the tx to mempool, this can happen for example when rpc rejects
                    // the tx for example because of low gas or invalid parameters, etc
                    let message = "failed to submit the transaction";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.setAttr("errorDetails", message);
                        if (isTimeout(err.error)) {
                            report.setAttr("severity", ErrorSeverity.LOW);
                        } else {
                            report.setAttr("severity", ErrorSeverity.HIGH);
                        }
                    } else {
                        report.setAttr("severity", ErrorSeverity.HIGH);
                    }
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                    report.setAttr("unsuccessfulClear", true);
                    report.setAttr("txSendFailed", true);
                    break;
                }
                case ProcessOrderHaltReason.TxReverted: {
                    // Tx reverted onchain, this can happen for example
                    // because of mev front running or false positive opportunities, etc
                    let message = "";
                    if (err.error) {
                        if ("snapshot" in err.error) {
                            message = err.error.snapshot;
                        } else {
                            message = await errorSnapshot(
                                "transaction reverted onchain",
                                err.error.err,
                            );
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
                    break;
                }
                case ProcessOrderHaltReason.TxMineFailed: {
                    // tx failed to get included onchain, this can happen as result of timeout, rpc dropping the tx, etc
                    let message = "transaction failed";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.setAttr("errorDetails", message);
                        if (isTimeout(err.error)) {
                            report.setAttr("severity", ErrorSeverity.LOW);
                        } else {
                            report.setAttr("severity", ErrorSeverity.HIGH);
                        }
                    } else {
                        report.setAttr("severity", ErrorSeverity.HIGH);
                    }
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                    report.setAttr("unsuccessfulClear", true);
                    report.setAttr("txMineFailed", true);
                    break;
                }
                default: {
                    // record the error for the span
                    let message = "unexpected error";
                    if (err.error) {
                        message = await errorSnapshot(message, err.error);
                        report.recordException(err.error);
                    }
                    // set the span status to unexpected error
                    report.setAttr("severity", ErrorSeverity.HIGH);
                    report.setStatus({ code: SpanStatusCode.ERROR, message });

                    // set the reason explicitly to unexpected error
                    err.reason = ProcessOrderHaltReason.UnexpectedError;
                }
            }
        }
        report.end();
        reports.push(report);

        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
    }

    return { results, reports };
}

/**
 * Iterates over orders, optionally shuffling them.
 * @param orders - Array of orders to iterate over
 * @param shuffle - Whether to shuffle the orders (default: true)
 * @returns A generator that yields each order
 */
export function* iterOrders(orders: Pair[], shuffle = true): Generator<Pair> {
    if (shuffle) {
        // iterate randomly
        for (const orderDetails of iterRandom(orders)) yield orderDetails;
    } else {
        // iterate orders in the same order as they if no shuffle
        for (const orderDetails of orders) yield orderDetails;
    }
}
