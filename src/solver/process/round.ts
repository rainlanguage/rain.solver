import { ethers } from "ethers";
import { RainSolver } from "..";
import { PreAssembledSpan } from "../../logger";
import { processPair } from "../../processOrders";
import { arbAbis, orderbookAbi } from "../../abis";
import { SpanStatusCode } from "@opentelemetry/api";
import { Report, ProcessPairResult } from "../../types";
import { ProcessOrderHaltReason, ProcessOrderStatus } from "../types";
import { ErrorSeverity, errorSnapshot, isTimeout, KnownErrors } from "../../error";

/** Represents a settlement for a processed order */
export type Settlement = {
    pair: string;
    owner: string;
    orderHash: string;
    settle: () => Promise<ProcessPairResult>;
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
                // const span = tracer.startSpan(`checkpoint_${pair}`, undefined, ctx);
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
                const settle = await processPair({
                    config: this.config,
                    orderPairObject: orderDetails,
                    viemClient: this.state.client,
                    dataFetcher: this.state.dataFetcher,
                    signer,
                    arb,
                    genericArb,
                    orderbook,
                    pair,
                    orderbooksOrders: orders,
                    state: this.state,
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
    results: Report[];
    reports: PreAssembledSpan[];
}> {
    const results: Report[] = [];
    const reports: PreAssembledSpan[] = [];
    for (const { settle, pair, owner, orderHash } of settlements) {
        // instantiate a span report for this pair
        const report = new PreAssembledSpan(`order_${pair}`);
        report.setAttr("details.owner", owner);
        try {
            // settle the process results
            // this will return the report of the operation and in case
            // there was a revert tx, it will try to simulate it and find
            // the root cause as well
            const result = await settle();

            // keep track of avg gas cost
            if (result.gasCost) {
                this.state.gasCosts.push(result.gasCost.toBigInt());
            }

            results.push(result.report);

            // set the span attributes with the values gathered at processPair()
            report.extendAttrs(result.spanAttributes);

            // set the otel span status based on report status
            switch (result.report.status) {
                case ProcessOrderStatus.ZeroOutput: {
                    report.setStatus({ code: SpanStatusCode.OK, message: "zero max output" });
                    break;
                }
                case ProcessOrderStatus.NoOpportunity: {
                    if (result.error && typeof result.error === "string") {
                        report.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
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
        } catch (e: any) {
            // set the span attributes with the values gathered at processPair()
            report.extendAttrs(e.spanAttributes);

            // Finalize the reports based on error type
            switch (e.reason) {
                case ProcessOrderHaltReason.FailedToQuote: {
                    let message = "failed to quote order: " + orderHash;
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToGetPools: {
                    let message = pair + ": failed to get pool details";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.recordException(e.error);
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
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.setAttr("errorDetails", message);
                    }
                    report.setStatus({ code: SpanStatusCode.OK, message });
                    break;
                }
                case ProcessOrderHaltReason.FailedToUpdatePools: {
                    let message = pair + ": failed to update pool details by event data";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.recordException(e.error);
                    }
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                    break;
                }
                case ProcessOrderHaltReason.TxFailed: {
                    // failed to submit the tx to mempool, this can happen for example when rpc rejects
                    // the tx for example because of low gas or invalid parameters, etc
                    let message = "failed to submit the transaction";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.setAttr("errorDetails", message);
                        if (isTimeout(e.error)) {
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
                    if (e.error) {
                        if ("snapshot" in e.error) {
                            message = e.error.snapshot;
                        } else {
                            message = errorSnapshot("transaction reverted onchain", e.error.err);
                        }
                        report.setAttr("errorDetails", message);
                    }
                    if (KnownErrors.every((v) => !message.includes(v))) {
                        report.setAttr("severity", ErrorSeverity.HIGH);
                    }
                    if (e.spanAttributes["txNoneNodeError"]) {
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
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.setAttr("errorDetails", message);
                        if (isTimeout(e.error)) {
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
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        report.recordException(e.error);
                    }
                    // set the span status to unexpected error
                    report.setAttr("severity", ErrorSeverity.HIGH);
                    report.setStatus({ code: SpanStatusCode.ERROR, message });

                    // set the reason explicitly to unexpected error
                    e.reason = ProcessOrderHaltReason.UnexpectedError;
                }
            }

            // report the error reason along with the rest of report
            results.push({
                ...e.report,
                error: e.error,
                reason: e.reason,
            });
        }
        report.end();
        reports.push(report);
    }

    return { results, reports };
}
