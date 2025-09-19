import { RainSolver } from "..";
import { Pair } from "../../order";
import { Result } from "../../common";
import { toNumber } from "../../math";
import { Token } from "sushi/currency";
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
    orderDetails: Pair;
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
        status: ProcessOrderStatus.NoOpportunity, // set default status to no opp
        spanAttributes,
    };
    spanAttributes["details.orders"] = orderDetails.takeOrder.id;
    spanAttributes["details.pair"] = tokenPair;

    spanAttributes["event.quoteOrder"] = Date.now();
    try {
        await this.orderManager.quoteOrder(orderDetails);
        if (orderDetails.takeOrder.quote?.maxOutput === 0n) {
            // remove from pair maps if quote fails, to keep the pair map list free
            // of orders with 0 maxoutput this will make counterparty lookups faster
            this.orderManager.removeFromPairMaps(orderDetails);
            const endTime = performance.now();
            return async () => {
                return Result.ok({
                    ...baseResult,
                    endTime,
                    status: ProcessOrderStatus.ZeroOutput,
                });
            };
        }
        // include in pair maps if quote passes to keep the list of orders with quote clean,
        this.orderManager.addToPairMaps(orderDetails);
    } catch (e) {
        this.orderManager.removeFromPairMaps(orderDetails);
        const endTime = performance.now();
        return async () =>
            Result.err({
                ...baseResult,
                error: e,
                endTime,
                reason: ProcessOrderHaltReason.FailedToQuote,
            });
    }

    // record order quote details in span attributes
    spanAttributes["details.quote"] = JSON.stringify({
        maxOutput: formatUnits(orderDetails.takeOrder.quote!.maxOutput, 18),
        ratio: formatUnits(orderDetails.takeOrder.quote!.ratio, 18),
    });

    // get current block number
    spanAttributes["event.getBlockNumber"] = Date.now();
    const dataFetcherBlockNumber = await this.state.client.getBlockNumber().catch(() => {
        return undefined;
    });

    // update pools by events watching until current block
    spanAttributes["event.updatePoolsData"] = Date.now();
    try {
        await this.state.dataFetcher.updatePools(dataFetcherBlockNumber);
    } catch (e) {
        if (typeof e !== "string" || !e.includes("fetchPoolsForToken")) {
            const endTime = performance.now();
            return async () =>
                Result.err({
                    ...baseResult,
                    error: e,
                    endTime,
                    reason: ProcessOrderHaltReason.FailedToUpdatePools,
                });
        }
    }

    // get pool details
    spanAttributes["event.getPoolsData"] = Date.now();
    try {
        const options: RainDataFetcherOptions = {
            fetchPoolsTimeout: 90000,
            blockNumber: dataFetcherBlockNumber,
        };
        await this.state.dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, options);
    } catch (e) {
        const endTime = performance.now();
        return async () =>
            Result.err({
                ...baseResult,
                error: e,
                endTime,
                reason: ProcessOrderHaltReason.FailedToGetPools,
            });
    }

    // record market price in span attributes
    spanAttributes["event.getPairMarketPrice"] = Date.now();
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
    spanAttributes["event.getEthMarketPrice"] = Date.now();
    let inputToEthPrice = "";
    let outputToEthPrice = "";
    try {
        inputToEthPrice =
            (
                await this.state.getMarketPrice(
                    toToken,
                    this.state.chainConfig.nativeWrappedToken,
                    dataFetcherBlockNumber,
                )
            )?.price ?? (this.appOptions.gasCoveragePercentage === "0" ? "0" : "");
        outputToEthPrice =
            (
                await this.state.getMarketPrice(
                    fromToken,
                    this.state.chainConfig.nativeWrappedToken,
                    dataFetcherBlockNumber,
                )
            )?.price ?? (this.appOptions.gasCoveragePercentage === "0" ? "0" : "");

        if (!inputToEthPrice && !outputToEthPrice) {
            const endTime = performance.now();
            return async () => {
                return Result.err({
                    ...baseResult,
                    endTime,
                    reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                    error: "no-route for both in/out tokens",
                });
            };
        }
    } catch (e) {
        if (!inputToEthPrice && !outputToEthPrice) {
            const endTime = performance.now();
            return async () => {
                return Result.err({
                    ...baseResult,
                    error: e,
                    endTime,
                    reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                });
            };
        }
    }

    // record in/out tokens to eth price andgas price for otel
    spanAttributes["details.inputToEthPrice"] = inputToEthPrice || "no-way";
    spanAttributes["details.outputToEthPrice"] = outputToEthPrice || "no-way";
    spanAttributes["details.gasPrice"] = this.state.gasPrice.toString();
    if (this.state.l1GasPrice) {
        spanAttributes["details.gasPriceL1"] = this.state.l1GasPrice.toString();
    }

    spanAttributes["event.findBestTrade"] = Date.now();
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
            endTime: performance.now(),
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
    spanAttributes["event.processTransaction"] = Date.now();
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
