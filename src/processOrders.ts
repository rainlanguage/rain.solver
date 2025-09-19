import { findOpp } from "./modes";
import { PublicClient } from "viem";
import { getQuoteGas } from "./gas";
import { SharedState } from "./state";
import { Token } from "sushi/currency";
import { createViemClient } from "./client";
import { arbAbis, orderbookAbi } from "./abis";
import { getSigner, handleTransaction } from "./tx";
import { privateKeyToAccount } from "viem/accounts";
import { BigNumber, Contract, ethers } from "ethers";
import { fundOwnedOrders, checkOwnedOrders } from "./account";
import { Context, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { ChainId, RainDataFetcher, RainDataFetcherOptions } from "sushi";
import { ErrorSeverity, errorSnapshot, isTimeout, KnownErrors } from "./error";
import { toNumber, getEthPrice, PoolBlackList, getMarketQuote } from "./utils";
import { BotConfig, ProcessPairHaltReason, ProcessPairReportStatus } from "./types";
import { Report, SpanAttrs, ViemClient, RoundReport, ProcessPairResult } from "./types";
import { BundledOrders, quoteSingleOrder } from "./order";

/**
 * Main function that processes all given orders and tries clearing them against onchain liquidity and reports the result
 * @param config - The configuration object
 * @param ordersDetails - The order details queried from subgraph
 * @param tracer
 * @param ctx
 */
export const processOrders = async (
    config: BotConfig,
    bundledOrders: BundledOrders[][],
    state: SharedState,
    tracer: Tracer,
    ctx: Context,
): Promise<RoundReport> => {
    const viemClient = config.viemClient;
    const dataFetcher = config.dataFetcher;
    const accounts = config.accounts;
    const mainAccount = config.mainAccount;

    // instantiating arb contract
    const arb = new ethers.Contract(config.arbAddress, arbAbis);
    let genericArb;
    if (config.genericArbAddress) {
        genericArb = new ethers.Contract(config.genericArbAddress, arbAbis);
    }

    // check owned vaults and top them up if necessary
    await tracer.startActiveSpan("handle-owned-vaults", {}, ctx, async (span) => {
        try {
            const ownedOrders = await checkOwnedOrders(config, bundledOrders);
            if (ownedOrders.length) {
                const failedFundings = await fundOwnedOrders(ownedOrders, config, state);
                const emptyOrders = ownedOrders.filter((v) => v.vaultBalance.isZero());
                if (failedFundings.length || emptyOrders.length) {
                    const message: string[] = [];
                    if (emptyOrders.length) {
                        message.push(
                            "Reason: following owned vaults are empty:",
                            ...emptyOrders.map(
                                (v) => `\ntoken: ${v.symbol},\nvaultId: ${v.vaultId}`,
                            ),
                        );
                    }
                    if (failedFundings.length) {
                        failedFundings.forEach((v) => {
                            let msg = v.error;
                            if (v.ownedOrder) {
                                const vaultId =
                                    (v.ownedOrder.vaultId as any) instanceof BigNumber
                                        ? (v.ownedOrder.vaultId as any as BigNumber).toHexString()
                                        : v.ownedOrder.vaultId;
                                msg = `\ntoken: ${v.ownedOrder.symbol},\nvaultId: ${vaultId}\n`;
                            }
                            message.push(msg);
                        });
                        span.setAttribute(
                            "failedFundings",
                            failedFundings.map((v) =>
                                JSON.stringify({
                                    error: v.error,
                                    ...(v.ownedOrder
                                        ? {
                                              orderId: v.ownedOrder.id,
                                              orderbook: v.ownedOrder.orderbook,
                                              vaultId: v.ownedOrder.vaultId,
                                              token: v.ownedOrder.token,
                                              symbol: v.ownedOrder.symbol,
                                          }
                                        : {}),
                                }),
                            ),
                        );
                    }
                    span.setAttribute("severity", ErrorSeverity.MEDIUM);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: message.join("\n"),
                    });
                } else {
                    span.setStatus({ code: SpanStatusCode.OK, message: "All good!" });
                }
            }
        } catch (error: any) {
            span.setAttribute("severity", ErrorSeverity.HIGH);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: errorSnapshot("Failed to check owned vaults", error),
            });
            span.recordException(error);
        }
        span.end();
    });

    const txGasCosts: BigNumber[] = [];
    const reports: Report[] = [];
    const results: {
        settle: () => Promise<ProcessPairResult>;
        pair: string;
        orderPairObject: BundledOrders;
    }[] = [];
    for (const orderbookOrders of bundledOrders) {
        for (const pairOrders of orderbookOrders) {
            // instantiating orderbook contract
            const orderbook = new ethers.Contract(pairOrders.orderbook, orderbookAbi);

            for (let i = 0; i < pairOrders.takeOrders.length; i++) {
                const orderPairObject = {
                    orderbook: pairOrders.orderbook,
                    buyToken: pairOrders.buyToken,
                    buyTokenSymbol: pairOrders.buyTokenSymbol,
                    buyTokenDecimals: pairOrders.buyTokenDecimals,
                    sellToken: pairOrders.sellToken,
                    sellTokenSymbol: pairOrders.sellTokenSymbol,
                    sellTokenDecimals: pairOrders.sellTokenDecimals,
                    takeOrders: [pairOrders.takeOrders[i]],
                };

                // await for first available signer to get free
                const signer = await getSigner(accounts, mainAccount, true);

                const writeSigner = state.writeRpc
                    ? await createViemClient(
                          config.chain.id as ChainId,
                          state.writeRpc,
                          privateKeyToAccount(
                              signer.account.getHdKey
                                  ? (ethers.utils.hexlify(
                                        signer.account.getHdKey().privateKey!,
                                    ) as `0x${string}`)
                                  : ((state.walletKey.startsWith("0x")
                                        ? state.walletKey
                                        : "0x" + state.walletKey) as `0x${string}`),
                          ),
                          { timeout: config.timeout },
                          undefined,
                      )
                    : undefined;

                const pair = `${pairOrders.buyTokenSymbol}/${pairOrders.sellTokenSymbol}`;
                const span = tracer.startSpan(`checkpoint_${pair}`, undefined, ctx);
                span.setAttributes({
                    "details.pair": pair,
                    "details.orderHash": orderPairObject.takeOrders[0].id,
                    "details.orderbook": orderbook.address,
                    "details.sender": signer.account.address,
                    "details.owner": orderPairObject.takeOrders[0].takeOrder.order.owner,
                });

                // call process pair and save the settlement fn
                // to later settle without needing to pause if
                // there are more signers available
                const settle = await processPair({
                    config,
                    orderPairObject,
                    viemClient,
                    dataFetcher,
                    signer,
                    writeSigner,
                    arb,
                    genericArb,
                    orderbook,
                    pair,
                    orderbooksOrders: bundledOrders,
                    state,
                });
                results.push({ settle, pair, orderPairObject });
                span.end();
            }
        }
    }

    for (const { settle, pair, orderPairObject } of results) {
        // instantiate a span for this pair
        const span = tracer.startSpan(`order_${pair}`, undefined, ctx);
        span.setAttribute("details.owner", orderPairObject.takeOrders[0].takeOrder.order.owner);
        try {
            // settle the process results
            // this will return the report of the operation and in case
            // there was a revert tx, it will try to simulate it and find
            // the root cause as well
            const result = await settle();

            // keep track of avg gas cost
            if (result.gasCost) {
                txGasCosts.push(result.gasCost);
            }

            reports.push(result.report);

            // set the span attributes with the values gathered at processPair()
            span.setAttributes(result.spanAttributes);

            // set the otel span status based on report status
            if (result.report.status === ProcessPairReportStatus.ZeroOutput) {
                span.setStatus({ code: SpanStatusCode.OK, message: "zero max output" });
            } else if (result.report.status === ProcessPairReportStatus.NoOpportunity) {
                if (result.error && typeof result.error === "string") {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
                } else {
                    span.setStatus({ code: SpanStatusCode.OK, message: "no opportunity" });
                }
            } else if (result.report.status === ProcessPairReportStatus.FoundOpportunity) {
                span.setStatus({ code: SpanStatusCode.OK, message: "found opportunity" });
            } else {
                // set the span status to unexpected error
                span.setAttribute("severity", ErrorSeverity.HIGH);
                span.setStatus({ code: SpanStatusCode.ERROR, message: "unexpected error" });
            }
        } catch (e: any) {
            // set the span attributes with the values gathered at processPair()
            span.setAttributes(e.spanAttributes);

            // record otel span status based on reported reason
            if (e.reason) {
                // report the error reason along with the rest of report
                reports.push({
                    ...e.report,
                    error: e.error,
                    reason: e.reason,
                });

                // set the otel span status based on returned reason
                if (e.reason === ProcessPairHaltReason.FailedToQuote) {
                    let message = "failed to quote order: " + orderPairObject.takeOrders[0].id;
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                    }
                    span.setStatus({ code: SpanStatusCode.OK, message });
                } else if (e.reason === ProcessPairHaltReason.FailedToGetPools) {
                    let message = pair + ": failed to get pool details";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.recordException(e.error);
                    }
                    span.setAttribute("severity", ErrorSeverity.MEDIUM);
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                } else if (e.reason === ProcessPairHaltReason.FailedToGetEthPrice) {
                    // set OK status because a token might not have a pool and as a result eth price cannot
                    // be fetched for it and if it is set to ERROR it will constantly error on each round
                    // resulting in lots of false positives
                    let message = "failed to get eth price";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.setAttribute("errorDetails", message);
                    }
                    span.setStatus({ code: SpanStatusCode.OK, message });
                } else if (e.reason === ProcessPairHaltReason.FailedToUpdatePools) {
                    let message = pair + ": failed to update pool details by event data";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.recordException(e.error);
                    }
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                } else if (e.reason === ProcessPairHaltReason.TxFailed) {
                    // failed to submit the tx to mempool, this can happen for example when rpc rejects
                    // the tx for example because of low gas or invalid parameters, etc
                    let message = "failed to submit the transaction";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.setAttribute("errorDetails", message);
                        if (isTimeout(e.error)) {
                            span.setAttribute("severity", ErrorSeverity.LOW);
                        } else {
                            span.setAttribute("severity", ErrorSeverity.HIGH);
                        }
                    } else {
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                    }
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                    span.setAttribute("unsuccessfulClear", true);
                    span.setAttribute("txSendFailed", true);
                } else if (e.reason === ProcessPairHaltReason.TxReverted) {
                    // Tx reverted onchain, this can happen for example
                    // because of mev front running or false positive opportunities, etc
                    let message = "";
                    if (e.error) {
                        if ("snapshot" in e.error) {
                            message = e.error.snapshot;
                        } else {
                            message = errorSnapshot("transaction reverted onchain", e.error.err);
                        }
                        span.setAttribute("errorDetails", message);
                    }
                    if (KnownErrors.every((v) => !message.includes(v))) {
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                    }
                    if (e.spanAttributes["txNoneNodeError"]) {
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                    }
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                    span.setAttribute("unsuccessfulClear", true);
                    span.setAttribute("txReverted", true);
                } else if (e.reason === ProcessPairHaltReason.TxMineFailed) {
                    // tx failed to get included onchain, this can happen as result of timeout, rpc dropping the tx, etc
                    let message = "transaction failed";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.setAttribute("errorDetails", message);
                        if (isTimeout(e.error)) {
                            span.setAttribute("severity", ErrorSeverity.LOW);
                        } else {
                            span.setAttribute("severity", ErrorSeverity.HIGH);
                        }
                    } else {
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                    }
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                    span.setAttribute("unsuccessfulClear", true);
                    span.setAttribute("txMineFailed", true);
                } else {
                    // record the error for the span
                    let message = "unexpected error";
                    if (e.error) {
                        message = errorSnapshot(message, e.error);
                        span.recordException(e.error);
                    }
                    // set the span status to unexpected error
                    span.setAttribute("severity", ErrorSeverity.HIGH);
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                }
            } else {
                // record the error for the span
                let message = "unexpected error";
                if (e.error) {
                    message = errorSnapshot(message, e.error);
                    span.recordException(e.error);
                }

                // report the unexpected error reason
                reports.push({
                    ...e.report,
                    error: e.error,
                    reason: ProcessPairHaltReason.UnexpectedError,
                });
                // set the span status to unexpected error
                span.setAttribute("severity", ErrorSeverity.HIGH);
                span.setStatus({ code: SpanStatusCode.ERROR, message });
            }
        }
        span.end();
    }
    return {
        reports,
        avgGasCost: txGasCosts.length
            ? txGasCosts.reduce((a, b) => a.add(b), ethers.constants.Zero).div(txGasCosts.length)
            : undefined,
    };
};

/**
 * Processes an pair order by trying to clear it against an onchain liquidity and reporting the result
 */
export async function processPair(args: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    dataFetcher: RainDataFetcher;
    signer: ViemClient;
    writeSigner: ViemClient | undefined;
    arb: Contract;
    genericArb: Contract | undefined;
    orderbook: Contract;
    pair: string;
    orderbooksOrders: BundledOrders[][];
    state: SharedState;
}): Promise<() => Promise<ProcessPairResult>> {
    const {
        config,
        orderPairObject,
        viemClient,
        dataFetcher,
        signer,
        writeSigner,
        arb,
        genericArb,
        orderbook,
        pair,
        orderbooksOrders,
        state,
    } = args;
    const isE2eTest = (config as any).isTest;
    const spanAttributes: SpanAttrs = {};
    const result: ProcessPairResult = {
        reason: undefined,
        error: undefined,
        gasCost: undefined,
        spanAttributes,
        report: {
            status: ProcessPairReportStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        },
    };
    spanAttributes["details.orders"] = orderPairObject.takeOrders.map((v) => v.id);
    spanAttributes["details.pair"] = pair;

    const fromToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.sellTokenDecimals,
        address: orderPairObject.sellToken,
        symbol: orderPairObject.sellTokenSymbol,
    });
    const toToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.buyTokenDecimals,
        address: orderPairObject.buyToken,
        symbol: orderPairObject.buyTokenSymbol,
    });

    try {
        await quoteSingleOrder(
            orderPairObject,
            viemClient,
            undefined,
            isE2eTest ? config.quoteGas : await getQuoteGas(config, orderPairObject),
        );
        if (orderPairObject.takeOrders[0].quote?.maxOutput === 0n) {
            result.report = {
                status: ProcessPairReportStatus.ZeroOutput,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            return async () => {
                return result;
            };
        }
    } catch (e) {
        result.error = e;
        result.reason = ProcessPairHaltReason.FailedToQuote;
        return async () => {
            throw result;
        };
    }

    spanAttributes["details.quote"] = JSON.stringify({
        maxOutput: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote!.maxOutput),
        ratio: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote!.ratio),
    });

    const gasPrice = BigNumber.from(state.gasPrice);

    // get block number
    let dataFetcherBlockNumber = await viemClient.getBlockNumber().catch(() => {
        return undefined;
    });

    // update pools by events watching until current block
    try {
        if (isE2eTest && (config as any).testBlockNumberInc) {
            (config as any).testBlockNumberInc += 10n;
            dataFetcherBlockNumber = (config as any).testBlockNumberInc;
        }
        await dataFetcher.updatePools(dataFetcherBlockNumber);
    } catch (e) {
        if (typeof e !== "string" || !e.includes("fetchPoolsForToken")) {
            result.reason = ProcessPairHaltReason.FailedToUpdatePools;
            result.error = e;
            return async () => {
                throw result;
            };
        }
    }

    // get pool details
    try {
        const options: RainDataFetcherOptions = {
            fetchPoolsTimeout: 90000,
            blockNumber: dataFetcherBlockNumber,
        };
        // pin block number for test case
        if (isE2eTest && (config as any).testBlockNumber) {
            options.blockNumber = (config as any).testBlockNumber;
        }
        await dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, options);
    } catch (e) {
        result.reason = ProcessPairHaltReason.FailedToGetPools;
        result.error = e;
        return async () => {
            throw result;
        };
    }

    try {
        const marketQuote = getMarketQuote(config, fromToken, toToken, gasPrice);
        if (marketQuote) {
            spanAttributes["details.marketQuote.str"] = marketQuote.price;
            spanAttributes["details.marketQuote.num"] = toNumber(
                ethers.utils.parseUnits(marketQuote.price),
            );
        }
    } catch {
        /**/
    }

    // get in/out tokens to eth price
    let inputToEthPrice, outputToEthPrice;
    try {
        const options = {
            fetchPoolsTimeout: 30000,
        };
        // pin block number for test case
        if (isE2eTest && (config as any).testBlockNumber) {
            (options as any).blockNumber = (config as any).testBlockNumber;
        }
        inputToEthPrice = await getEthPrice(
            config,
            orderPairObject.buyToken,
            orderPairObject.buyTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        outputToEthPrice = await getEthPrice(
            config,
            orderPairObject.sellToken,
            orderPairObject.sellTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        if (!inputToEthPrice || !outputToEthPrice) {
            if (config.gasCoveragePercentage === "0") {
                inputToEthPrice = "0";
                outputToEthPrice = "0";
            } else {
                result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
                result.error = "no-route";
                return async () => {
                    return Promise.reject(result);
                };
            }
        } else {
            spanAttributes["details.inputToEthPrice"] = inputToEthPrice;
            spanAttributes["details.outputToEthPrice"] = outputToEthPrice;
        }
    } catch (e) {
        if (config.gasCoveragePercentage === "0") {
            inputToEthPrice = "0";
            outputToEthPrice = "0";
        } else {
            result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
            result.error = e;
            return async () => {
                throw result;
            };
        }
    }

    // record gas price for otel
    spanAttributes["details.gasPrice"] = state.gasPrice.toString();
    if (state.l1GasPrice) {
        spanAttributes["details.gasPriceL1"] = state.l1GasPrice.toString();
    }

    // execute process to find opp through different modes
    let rawtx, oppBlockNumber, estimatedProfit;
    try {
        const findOppResult = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb,
            fromToken,
            toToken,
            signer,
            gasPrice: state.gasPrice,
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders,
            l1GasPrice: state.l1GasPrice,
        });
        ({ rawtx, oppBlockNumber, estimatedProfit } = findOppResult.value!);

        if (!rawtx || !oppBlockNumber) throw "undefined tx/block number";

        // record span attrs
        spanAttributes["details.estimatedProfit"] = ethers.utils.formatUnits(estimatedProfit);
        for (const attrKey in findOppResult.spanAttributes) {
            if (attrKey !== "oppBlockNumber" && attrKey !== "foundOpp") {
                spanAttributes["details." + attrKey] = findOppResult.spanAttributes[attrKey];
            } else {
                spanAttributes[attrKey] = findOppResult.spanAttributes[attrKey];
            }
        }
    } catch (e: any) {
        // record all span attributes
        for (const attrKey in e.spanAttributes) {
            spanAttributes["details." + attrKey] = e.spanAttributes[attrKey];
        }
        if (e.noneNodeError) {
            spanAttributes["details.noneNodeError"] = true;
            result.error = e.noneNodeError;
        } else {
            spanAttributes["details.noneNodeError"] = false;
        }
        result.report = {
            status: ProcessPairReportStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        };
        return async () => {
            return result;
        };
    }

    // from here on we know an opp is found, so record it in report and in otel span attributes
    result.report = {
        status: ProcessPairReportStatus.FoundOpportunity,
        tokenPair: pair,
        buyToken: orderPairObject.buyToken,
        sellToken: orderPairObject.sellToken,
    };
    spanAttributes["foundOpp"] = true;

    // get block number
    let blockNumber: number;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["details.blockNumber"] = blockNumber;
        spanAttributes["details.blockNumberDiff"] = blockNumber - oppBlockNumber;
    } catch (e) {
        // dont reject if getting block number fails but just record it,
        // since an opp is found and can ultimately be cleared
        spanAttributes["details.blockNumberError"] = errorSnapshot("failed to get block number", e);
    }

    // handle the found transaction opportunity
    return handleTransaction(
        signer,
        viemClient as any as ViemClient,
        spanAttributes,
        rawtx,
        orderbook,
        orderPairObject,
        inputToEthPrice,
        outputToEthPrice,
        result,
        pair,
        toToken,
        fromToken,
        config,
        writeSigner,
    );
}
