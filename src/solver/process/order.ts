import { RainSolver } from "..";
import { Result } from "../../result";
import { toNumber } from "../../math";
import { Token } from "sushi/currency";
import { BundledOrders } from "../../order";
import { errorSnapshot } from "../../error";
import { PoolBlackList } from "../../router";
import { formatUnits, parseUnits } from "viem";
import { RainDataFetcherOptions } from "sushi";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../signer";
import { processTransaction } from "./transaction";
import {
    ProcessOrderStatus,
    ProcessOrderSuccess,
    ProcessOrderFailure,
    ProcessOrderHaltReason,
    ProcessOrderResultBase,
} from "../types";

/** Arguments for processing an order */
export type ProcessOrderArgs = {
    orderDetails: BundledOrders;
    signer: RainSolverSigner;
};

/**
 * Processes an order trying to find an opportunity to clear it
 * @param args - The arguments for processing the order
 * @returns A function that returns the result of processing the order
 */
export async function processOrder(
    this: RainSolver,
    args: ProcessOrderArgs,
): Promise<() => Promise<Result<ProcessOrderSuccess, ProcessOrderFailure>>> {
    const { orderDetails, signer } = args;
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
    const spanAttributes: Attributes = {};
    const tokenPair = `${orderDetails.buyTokenSymbol}/${orderDetails.sellTokenSymbol}`;
    const baseResult: ProcessOrderResultBase = {
        tokenPair,
        buyToken: orderDetails.buyToken,
        sellToken: orderDetails.sellToken,
        status: ProcessOrderStatus.NoOpportunity, // set default result to no opp
        spanAttributes,
    };
    spanAttributes["details.orders"] = orderDetails.takeOrders.map((v) => v.id);
    spanAttributes["details.pair"] = tokenPair;

    try {
        await this.orderManager.quoteOrder(orderDetails);
        if (orderDetails.takeOrders[0].quote?.maxOutput === 0n) {
            return async () => {
                return Result.ok({
                    ...baseResult,
                    status: ProcessOrderStatus.ZeroOutput,
                });
            };
        }
    } catch (e) {
        return async () =>
            Result.err({
                ...baseResult,
                error: e,
                reason: ProcessOrderHaltReason.FailedToQuote,
            });
    }

    // record order quote details in span attributes
    spanAttributes["details.quote"] = JSON.stringify({
        maxOutput: formatUnits(orderDetails.takeOrders[0].quote!.maxOutput, 18),
        ratio: formatUnits(orderDetails.takeOrders[0].quote!.ratio, 18),
    });

    // get current block number
    const dataFetcherBlockNumber = await this.state.client.getBlockNumber().catch(() => {
        return undefined;
    });

    // update pools by events watching until current block
    try {
        await this.state.dataFetcher.updatePools(dataFetcherBlockNumber);
    } catch (e) {
        if (typeof e !== "string" || !e.includes("fetchPoolsForToken")) {
            return async () =>
                Result.err({
                    ...baseResult,
                    error: e,
                    reason: ProcessOrderHaltReason.FailedToUpdatePools,
                });
        }
    }

    // get pool details
    try {
        const options: RainDataFetcherOptions = {
            fetchPoolsTimeout: 90000,
            blockNumber: dataFetcherBlockNumber,
        };
        await this.state.dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, options);
    } catch (e) {
        return async () =>
            Result.err({
                ...baseResult,
                error: e,
                reason: ProcessOrderHaltReason.FailedToGetPools,
            });
    }

    // record market price in span attributes
    await this.state
        .getMarketPrice(fromToken, toToken, dataFetcherBlockNumber)
        .catch(() => {})
        .then((marketQuote) => {
            if (marketQuote) {
                spanAttributes["details.marketQuote.str"] = marketQuote.price;
                spanAttributes["details.marketQuote.num"] = toNumber(
                    parseUnits(marketQuote.price, 18),
                );
            }
        });

    // get in/out tokens to eth price
    let inputToEthPrice, outputToEthPrice;
    try {
        inputToEthPrice = (
            await this.state.getMarketPrice(
                toToken,
                this.state.chainConfig.nativeWrappedToken,
                dataFetcherBlockNumber,
            )
        )?.price;
        outputToEthPrice = (
            await this.state.getMarketPrice(
                fromToken,
                this.state.chainConfig.nativeWrappedToken,
                dataFetcherBlockNumber,
            )
        )?.price;
        if (!inputToEthPrice || !outputToEthPrice) {
            if (this.appOptions.gasCoveragePercentage === "0") {
                inputToEthPrice = "0";
                outputToEthPrice = "0";
            } else {
                return async () => {
                    return Result.err({
                        ...baseResult,
                        reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                        error: "no-route",
                    });
                };
            }
        }
    } catch (e) {
        if (this.appOptions.gasCoveragePercentage === "0") {
            inputToEthPrice = "0";
            outputToEthPrice = "0";
        } else {
            return async () => {
                return Result.err({
                    ...baseResult,
                    error: e,
                    reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                });
            };
        }
    }

    // record in/out tokens to eth price andgas price for otel
    spanAttributes["details.inputToEthPrice"] = inputToEthPrice;
    spanAttributes["details.outputToEthPrice"] = outputToEthPrice;
    spanAttributes["details.gasPrice"] = this.state.gasPrice.toString();
    if (this.state.l1GasPrice) {
        spanAttributes["details.gasPriceL1"] = this.state.l1GasPrice.toString();
    }

    const trade = await this.findBestTrade({
        orderDetails,
        signer,
        toToken,
        fromToken,
        inputToEthPrice,
        outputToEthPrice,
    });
    if (trade.isErr()) {
        const result: ProcessOrderSuccess = {
            ...baseResult,
        };
        // record all span attributes
        for (const attrKey in trade.error.spanAttributes) {
            spanAttributes["details." + attrKey] = trade.error.spanAttributes[attrKey];
        }
        if (trade.error.noneNodeError) {
            spanAttributes["details.noneNodeError"] = true;
            result.message = trade.error.noneNodeError;
        } else {
            spanAttributes["details.noneNodeError"] = false;
        }
        return async () => Result.ok(result);
    }

    // from here on we know an opp is found, so record it in report and in otel span attributes
    const { rawtx, oppBlockNumber, estimatedProfit } = trade.value;

    // record span attrs and status
    baseResult.status = ProcessOrderStatus.FoundOpportunity;
    spanAttributes["foundOpp"] = true;
    spanAttributes["details.estimatedProfit"] = formatUnits(estimatedProfit, 18);
    for (const attrKey in trade.value.spanAttributes) {
        if (attrKey !== "oppBlockNumber" && attrKey !== "foundOpp") {
            spanAttributes["details." + attrKey] = trade.value.spanAttributes[attrKey];
        } else {
            spanAttributes[attrKey] = trade.value.spanAttributes[attrKey];
        }
    }

    // get block number
    let blockNumber: number;
    try {
        blockNumber = Number(await this.state.client.getBlockNumber());
        spanAttributes["details.blockNumber"] = blockNumber;
        spanAttributes["details.blockNumberDiff"] = blockNumber - oppBlockNumber;
    } catch (e) {
        // dont reject if getting block number fails but just record it,
        // since an opp is found and can ultimately be cleared
        spanAttributes["details.blockNumberError"] = await errorSnapshot(
            "failed to get block number",
            e,
        );
    }

    // process the found transaction opportunity
    return processTransaction({
        rawtx,
        signer,
        toToken,
        fromToken,
        baseResult,
        inputToEthPrice,
        outputToEthPrice,
        orderbook: orderDetails.orderbook as `0x${string}`,
    });
}
