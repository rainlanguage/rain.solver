import { ethers } from "ethers";
import { RainSolver } from "..";
import { Result } from "../../result";
import { PreAssembledSpan } from "../../logger";
import { arbAbis, orderbookAbi } from "../../abis";
import { SpanStatusCode } from "@opentelemetry/api";
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
export async function initializeRound(this: RainSolver) {
    const orders = this.orderManager.getNextRoundOrders(true);

    // instantiating arb contract
    const arb = new ethers.Contract(this.appOptions.arbAddress, arbAbis);
    let genericArb;
    if (this.appOptions.genericArbAddress) {
        genericArb = new ethers.Contract(this.appOptions.genericArbAddress, arbAbis);
    }

    const settlements: Settlement[] = [];
    const checkpointReports: PreAssembledSpan[] = [];
    for (const orderbookOrders of orders) {
        for (const pairOrders of orderbookOrders) {
            // instantiating orderbook contract
            const orderbook = new ethers.Contract(pairOrders.orderbook, orderbookAbi);

            for (let i = 0; i < pairOrders.takeOrders.length; i++) {
                const orderDetails = {
                    orderbook: pairOrders.orderbook,
                    buyToken: pairOrders.buyToken,
                    buyTokenSymbol: pairOrders.buyTokenSymbol,
                    buyTokenDecimals: pairOrders.buyTokenDecimals,
                    sellToken: pairOrders.sellToken,
                    sellTokenSymbol: pairOrders.sellTokenSymbol,
                    sellTokenDecimals: pairOrders.sellTokenDecimals,
                    takeOrders: [pairOrders.takeOrders[i]],
                };

                // await for first available random free signer
                const signer = await this.walletManager.getRandomSigner(true);

                const pair = `${pairOrders.buyTokenSymbol}/${pairOrders.sellTokenSymbol}`;
                const report = new PreAssembledSpan(`checkpoint_${pair}`);
                report.extendAttrs({
                    "details.pair": pair,
                    "details.orderHash": orderDetails.takeOrders[0].id,
                    "details.orderbook": orderbook.address,
                    "details.sender": signer.account.address,
                    "details.owner": orderDetails.takeOrders[0].takeOrder.order.owner,
                });

                // call process pair and save the settlement fn
                // to later settle without needing to pause if
                // there are more signers available
                const settle = await this.processOrder({
                    orderDetails,
                    signer,
                    arb,
                    genericArb,
                    orderbook,
                    orderbooksOrders: orders,
                });
                settlements.push({
                    settle,
                    pair,
                    orderHash: orderDetails.takeOrders[0].id,
                    owner: orderDetails.takeOrders[0].takeOrder.order.owner,
                });
                report.end();
                checkpointReports.push(report);
            }
        }
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
            report.extendAttrs(err.spanAttributes);

            // Finalize the reports based on error type
            switch (err.reason) {
                case ProcessOrderHaltReason.FailedToQuote: {
                    let message = "failed to quote order: " + orderHash;
                    if (err.error) {
                        message = errorSnapshot(message, err.error);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToGetPools: {
                    let message = pair + ": failed to get pool details";
                    if (err.error) {
                        message = errorSnapshot(message, err.error);
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
                        message = errorSnapshot(message, err.error);
                        report.setAttr("errorDetails", message);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToUpdatePools: {
                    let message = pair + ": failed to update pool details by event data";
                    if (err.error) {
                        message = errorSnapshot(message, err.error);
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
                        message = errorSnapshot(message, err.error);
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
                            message = errorSnapshot("transaction reverted onchain", err.error.err);
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
                        message = errorSnapshot(message, err.error);
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
                        message = errorSnapshot(message, err.error);
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
    }

    return { results, reports };
}
