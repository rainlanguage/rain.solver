import assert from "assert";
import { RainSolver } from "..";
import { BaseError } from "viem";
import { Pair } from "../../order";
import { Token } from "sushi/currency";
import { RainSolverSigner } from "../../signer";
import { Attributes } from "@opentelemetry/api";
import { findBestRouterTrade } from "./router";
import { OrderbookTradeTypes } from "../../config";
import { findBestIntraOrderbookTrade } from "./intra";
import { findBestInterOrderbookTrade } from "./inter";
import { Result, extendObjectWithHeader } from "../../common";
import { containsNodeError, errorSnapshot } from "../../error";
import { FindBestTradeFailure, FindBestTradeResult, SimulationResult } from "../types";

/** Arguments for finding the best trade */
export type FindBestTradeArgs = {
    /** The order details to find the best trade for */
    orderDetails: Pair;
    /** The signer that performs the trade simulation */
    signer: RainSolverSigner;
    /** The input token price to ETH */
    inputToEthPrice: string;
    /** The output token price to ETH */
    outputToEthPrice: string;
    /** The token to be received */
    toToken: Token;
    /** The token to be sold */
    fromToken: Token;
};

/**
 * Finds and returns the most profitable trade transaction and other relevant information for the given order
 * to be broadcasted onchain.
 *
 * This function concurrently evaluates multiple trade strategies, including route processor, intra-orderbook,
 * and inter-orderbook trades. It selects the trade with the highest estimated profit among all successful
 * results. If all strategies fail, it aggregates error information and returns a comprehensive error result.
 *
 * @param this - The instance of `RainSolver`
 * @param args - The arguments required to find the best trade
 */
export async function findBestTrade(
    this: RainSolver,
    args: FindBestTradeArgs,
): Promise<FindBestTradeResult> {
    const { orderDetails, signer, inputToEthPrice, outputToEthPrice, toToken, fromToken } = args;

    // get block number before simulating trades which also avoid multiple calls to getBlockNumber
    const blockNumberResult: Result<bigint, FindBestTradeFailure> = await this.state.client
        .getBlockNumber()
        .then((v) => Result.ok(v) as Result<bigint, FindBestTradeFailure>)
        .catch(async (err) => {
            const errMsg = await errorSnapshot("Failed to get block number", err);
            const isNodeError = await containsNodeError(err as BaseError);
            const result: FindBestTradeFailure = {
                spanAttributes: { error: errMsg } as Attributes,
            };
            if (!isNodeError) {
                result.noneNodeError = errMsg;
            }
            return Result.err(result);
        });

    if (blockNumberResult.isErr()) {
        return Result.err(blockNumberResult.error);
    }
    const blockNumber = blockNumberResult.value;

    // get enabled trade fns for the specific orderbook
    const {
        findBestRouterTrade: findBestRouterTradeFn,
        findBestIntraOrderbookTrade: findBestIntraOrderbookTradeFn,
        findBestInterOrderbookTrade: findBestInterOrderbookTradeFn,
    } = getEnabledTrades(this.appOptions.orderbookTradeTypes, orderDetails.orderbook);

    const promises = [
        findBestRouterTradeFn?.call(
            this,
            orderDetails,
            signer,
            inputToEthPrice,
            toToken,
            fromToken,
            blockNumber,
        ),
        findBestIntraOrderbookTradeFn?.call(
            this,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        ),
        findBestInterOrderbookTradeFn?.call(
            this,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        ),
    ];
    const results = (await Promise.all(promises)).filter(
        (v) => v !== undefined,
    ) as SimulationResult[];

    // if at least one result is ok, we can proceed to pick the best one
    if (results.some((v) => v.isOk())) {
        // sort results descending by estimated profit,
        // so those that are errors will be at the end
        // and the first one will be the one with highest estimated profit
        // as we know at least one result is ok, so we can safely access it
        const pick = results.sort((a, b) => {
            if (a.isErr() && b.isErr()) return 0;
            if (a.isErr()) return 1;
            if (b.isErr()) return -1;
            return a.value.estimatedProfit < b.value.estimatedProfit
                ? 1
                : a.value.estimatedProfit > b.value.estimatedProfit
                  ? -1
                  : 0;
        })[0];

        // set the picked trade type in attrs
        assert(pick.isOk()); // just for type check as we know at least one result is ok
        pick.value.spanAttributes["tradeType"] = pick.value.type;

        return pick;
    } else {
        const spanAttributes: Attributes = {};
        let noneNodeError: string | undefined = undefined;

        // extend span attributes with the result error attrs and trade type header
        for (const result of results) {
            assert(result.isErr()); // just for type check as we know all results are errors
            extendObjectWithHeader(spanAttributes, result.error.spanAttributes, result.error.type);
            if (noneNodeError === undefined) {
                noneNodeError = result.error.noneNodeError;
            }
        }
        return Result.err({
            spanAttributes,
            noneNodeError,
        });
    }
}

/**
 * Get enabled trade fns for a specific orderbook
 * @param orderbookTradeTypes - The trade types configuration from app options
 * @param orderbookAddress - The orderbook address to get enabled trade fns for
 * @returns An object containing the enabled trade functions
 */
export function getEnabledTrades(
    orderbookTradeTypes: OrderbookTradeTypes,
    orderbookAddress: string,
): {
    findBestRouterTrade?: typeof findBestRouterTrade;
    findBestIntraOrderbookTrade?: typeof findBestIntraOrderbookTrade;
    findBestInterOrderbookTrade?: typeof findBestInterOrderbookTrade;
} {
    let allEnabled = true;
    const address = orderbookAddress.toLowerCase();
    const result: {
        findBestRouterTrade?: typeof findBestRouterTrade;
        findBestIntraOrderbookTrade?: typeof findBestIntraOrderbookTrade;
        findBestInterOrderbookTrade?: typeof findBestInterOrderbookTrade;
    } = {
        findBestRouterTrade: undefined,
        findBestIntraOrderbookTrade: undefined,
        findBestInterOrderbookTrade: undefined,
    };
    if (orderbookTradeTypes.router.has(address)) {
        result.findBestRouterTrade = findBestRouterTrade;
        allEnabled = false;
    }
    if (orderbookTradeTypes.intraOrderbook.has(address)) {
        result.findBestIntraOrderbookTrade = findBestIntraOrderbookTrade;
        allEnabled = false;
    }
    if (orderbookTradeTypes.interOrderbook.has(address)) {
        result.findBestInterOrderbookTrade = findBestInterOrderbookTrade;
        allEnabled = false;
    }
    if (allEnabled) {
        return {
            findBestRouterTrade,
            findBestIntraOrderbookTrade,
            findBestInterOrderbookTrade,
        };
    } else {
        return result;
    }
}
