import { RainSolver } from "..";
import { Pair } from "../../order";
import { Token } from "sushi/currency";
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
    startTime: number;
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

    let blockNumber: bigint;
    let concurrencyProcessBatch = [];
    let maxConcurrencyCounter = this.appOptions.maxConcurrency;
    try {
        blockNumber = await this.state.client.getBlockNumber();
    } catch (error) {
        const message = await errorSnapshot(
            "failed to get block number for orders batch process",
            error,
        );
        const report = new PreAssembledSpan(`order_batch_preprocess`);
        report.setStatus({ code: SpanStatusCode.ERROR, message });
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
        return {
            settlements,
            checkpointReports,
        };
    }
    for (const orderDetails of iterOrders(orders, shuffle)) {
        // update pools data on each batch start
        if (maxConcurrencyCounter === this.appOptions.maxConcurrency) {
            await this.state.router.sushi?.update(blockNumber).catch(() => undefined);
        }

        await prepareRouter.call(this, orderDetails, blockNumber);

        concurrencyProcessBatch.push(
            processOrderInit.call(this, orderDetails, blockNumber!, roundSpanCtx),
        );
        maxConcurrencyCounter--;

        // resolve promises if we hit the concurrency limit and reset them for next batch
        if (maxConcurrencyCounter === 0) {
            const batchResults = await Promise.all(concurrencyProcessBatch);
            batchResults.forEach(({ settlement, checkpointReport }) => {
                settlements.push(settlement);
                checkpointReports.push(checkpointReport);
            });

            // reset counter and batch vector
            concurrencyProcessBatch = [];
            maxConcurrencyCounter = this.appOptions.maxConcurrency;
            const temp = await this.state.client.getBlockNumber().catch(() => undefined);
            if (typeof temp === "bigint") blockNumber = temp;
        }
    }

    // resolve any remainings if iter ends before hitting the limit
    const remainings = await Promise.all(concurrencyProcessBatch);
    remainings.forEach(({ settlement, checkpointReport }) => {
        settlements.push(settlement);
        checkpointReports.push(checkpointReport);
    });

    return {
        settlements,
        checkpointReports,
    };
}

/**
 * Prefetches the routers' pool data required for processing the given order details
 * @param orderDetails - The order details
 * @param blockNumber - The block number to fetch data at
 */
export async function prepareRouter(this: RainSolver, orderDetails: Pair, blockNumber?: bigint) {
    const key = `${orderDetails.sellToken.toLowerCase()}-${orderDetails.buyToken.toLowerCase}`;
    const value = this.state.router.cache.get(key);
    if (typeof value === "number" && value > 3) return;

    const fromToken = new Token({
        chainId: this.state.chainConfig.id,
        decimals: orderDetails.sellTokenDecimals,
        address: orderDetails.sellToken,
        symbol: orderDetails.sellTokenSymbol,
    });
    const toToken = new Token({
        chainId: this.state.chainConfig.id,
        decimals: orderDetails.buyTokenDecimals,
        address: orderDetails.buyToken,
        symbol: orderDetails.buyTokenSymbol,
    });
    await this.state.getMarketPrice(fromToken, toToken, blockNumber, false).catch(() => undefined);
    await this.state
        .getMarketPrice(toToken, this.state.chainConfig.nativeWrappedToken, blockNumber, false)
        .catch(() => undefined);
    await this.state
        .getMarketPrice(fromToken, this.state.chainConfig.nativeWrappedToken, blockNumber, false)
        .catch(() => undefined);
}

/**
 * Prepares and collects the span data and initiates the processing operation for the given order
 * @param orderDetails - The order details
 * @param blockNumber - The current block number
 * @param roundSpanCtx - The parent round open telemetry spand and context
 * @returns An object containing the settlement and checkpoint report
 */
export async function processOrderInit(
    this: RainSolver,
    orderDetails: Pair,
    blockNumber: bigint,
    roundSpanCtx?: SpanWithContext,
): Promise<{ settlement: Settlement; checkpointReport: PreAssembledSpan }> {
    const pair = `${orderDetails.buyTokenSymbol}/${orderDetails.sellTokenSymbol}`;
    const startTime = performance.now();
    const report = new PreAssembledSpan(`checkpoint_${pair}`, startTime);
    const owner = orderDetails.takeOrder.struct.order.owner.toLowerCase();
    report.extendAttrs({
        "details.pair": pair,
        "details.orderHash": orderDetails.takeOrder.id,
        "details.orderbook": orderDetails.orderbook,
        "details.owner": owner,
    });

    // get updated balance for the orderDetails from owner vaults map
    orderDetails.sellTokenVaultBalance =
        this.orderManager.ownerTokenVaultMap
            .get(orderDetails.orderbook)
            ?.get(owner)
            ?.get(orderDetails.sellToken)
            ?.get(
                BigInt(
                    orderDetails.takeOrder.struct.order.validOutputs[
                        orderDetails.takeOrder.struct.outputIOIndex
                    ].vaultId,
                ),
            )?.balance ?? orderDetails.sellTokenVaultBalance;
    orderDetails.buyTokenVaultBalance =
        this.orderManager.ownerTokenVaultMap
            .get(orderDetails.orderbook)
            ?.get(owner)
            ?.get(orderDetails.buyToken)
            ?.get(
                BigInt(
                    orderDetails.takeOrder.struct.order.validInputs[
                        orderDetails.takeOrder.struct.inputIOIndex
                    ].vaultId,
                ),
            )?.balance ?? orderDetails.buyTokenVaultBalance;

    // skip if the output vault is empty
    if (orderDetails.sellTokenVaultBalance <= 0n) {
        const endTime = performance.now();
        const settlement: Settlement = {
            pair,
            owner,
            startTime,
            orderHash: orderDetails.takeOrder.id,
            settle: async () => {
                return Result.ok({
                    endTime,
                    tokenPair: pair,
                    buyToken: orderDetails.buyToken,
                    sellToken: orderDetails.sellToken,
                    status: ProcessOrderStatus.ZeroOutput,
                    spanAttributes: {
                        "details.pair": pair,
                        "details.orders": orderDetails.takeOrder.id,
                    },
                    spanEvents: {},
                });
            },
        };
        report.end();

        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
        return {
            settlement,
            checkpointReport: report,
        };
    }

    // skip if the required addresses for trading are not configured
    if (!this.state.contracts.getAddressesForTrade(orderDetails)) {
        const endTime = performance.now();
        const settlement: Settlement = {
            pair,
            owner,
            startTime,
            orderHash: orderDetails.takeOrder.id,
            settle: async () => {
                return Result.ok({
                    endTime,
                    tokenPair: pair,
                    buyToken: orderDetails.buyToken,
                    sellToken: orderDetails.sellToken,
                    status: ProcessOrderStatus.UndefinedTradeAddresses,
                    message: `Cannot trade as dispair addresses are not configured for order ${orderDetails.takeOrder.struct.order.type} trade`,
                    spanAttributes: {
                        "details.pair": pair,
                        "details.orders": orderDetails.takeOrder.id,
                    },
                    spanEvents: {},
                });
            },
        };
        report.end();

        // export the report to logger if logger is available
        this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
        return {
            settlement,
            checkpointReport: report,
        };
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
        blockNumber,
    });
    const settlement: Settlement = {
        settle,
        pair,
        owner,
        startTime,
        orderHash: orderDetails.takeOrder.id,
    };
    report.end();

    // export the report to logger if logger is available
    this.logger?.exportPreAssembledSpan(report, roundSpanCtx?.context);
    return {
        settlement,
        checkpointReport: report,
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
    for (const { settle, pair, orderHash, startTime } of settlements) {
        // instantiate a span report for this pair
        const report = new PreAssembledSpan(`order_${pair}`, startTime);

        // settle the process results
        // this will return the report of the operation
        const result = await settle();
        results.push(result);
        let endTime = performance.now();

        if (result.isOk()) {
            const value = result.value;
            endTime = value.endTime;

            // keep track of avg gas cost
            if (value.gasCost) {
                this.state.gasCosts.push(value.gasCost);
            }

            // record span events and attrs
            report.recordOrderEvents(value.spanEvents);
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
                case ProcessOrderStatus.UndefinedTradeAddresses: {
                    report.setStatus({ code: SpanStatusCode.OK, message: value.message });
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
            endTime = err.endTime;

            // record span events and attrs
            report.recordOrderEvents(err.spanEvents);
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
        report.end(endTime);
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
