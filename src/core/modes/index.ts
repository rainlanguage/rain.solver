import assert from "assert";
import { RainSolver } from "..";
import { Pair } from "../../order";
import { Token } from "sushi/currency";
import { RainSolverSigner } from "../../signer";
import { Attributes } from "@opentelemetry/api";
import { findBestRouterTrade } from "./router";
import { OrderbookTradeTypes } from "../../config";
import { findBestIntraOrderbookTrade } from "./intra";
import { findBestInterOrderbookTrade } from "./inter";
import { findBestRaindexRouterTrade } from "./raindex";
import { Result, extendObjectWithHeader } from "../../common";
import { FindBestTradeResult, SimulationResult } from "../types";

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
    /** The block number */
    blockNumber: bigint;
};

/**
 * Finds and returns a trade transaction and other relevant information for the given order
 * to be broadcasted onchain.
 *
 * This function concurrently evaluates multiple trade strategies, including route processor,
 * intra-orderbook and inter-orderbook trades. It resolves with the first strategy that
 * simulates successfully, so the found opportunity is acted on with the lowest latency
 * instead of waiting for all strategies to settle. If all strategies fail, it aggregates
 * error information and returns a comprehensive error result.
 *
 * @param this - The instance of `RainSolver`
 * @param args - The arguments required to find the best trade
 */
export async function findBestTrade(
    this: RainSolver,
    args: FindBestTradeArgs,
): Promise<FindBestTradeResult> {
    const {
        signer,
        toToken,
        fromToken,
        blockNumber,
        orderDetails,
        inputToEthPrice,
        outputToEthPrice,
    } = args;

    // get enabled trade fns for the order's orderbook
    const {
        findBestRouterTrade: findBestRouterTradeFn,
        findBestIntraOrderbookTrade: findBestIntraOrderbookTradeFn,
        findBestInterOrderbookTrade: findBestInterOrderbookTradeFn,
        findBestRaindexRouterTrade: findBestRaindexRouterTradeFn,
    } = getEnabledTradeTypeFunctions(this.appOptions.orderbookTradeTypes, orderDetails.orderbook);

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
        findBestRaindexRouterTradeFn?.call(
            this,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        ),
    ];
    const trades = promises.filter((v) => v !== undefined) as Promise<SimulationResult>[];

    // resolve with the first trade sim that succeeds instead of waiting for all
    // of them to settle, so the found opportunity is acted on with the lowest
    // latency, the sims that lose the race keep running in the background but
    // their outcome is discarded, resolves undefined when all sims fail
    const pick = await new Promise<SimulationResult | undefined>((resolve, reject) => {
        if (!trades.length) return resolve(undefined);
        let remaining = trades.length;
        const settle = (result: SimulationResult) => {
            if (result.isOk()) {
                resolve(result); // first success wins the race
            } else if (--remaining === 0) {
                resolve(undefined); // all sims failed
            }
        };
        trades.forEach((trade) => trade.then(settle, reject));
    });

    if (pick) {
        // set the picked trade type in attrs
        assert(pick.isOk()); // just for type check as we know the picked result is ok
        pick.value.spanAttributes["tradeType"] = pick.value.type;

        return pick;
    } else {
        const spanAttributes: Attributes = {};
        let noneNodeError: string | undefined = undefined;

        // all sims have already settled with error at this point, so this
        // resolves instantly while keeping the original trade type order
        const results = await Promise.all(trades);

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

type TradeTypeFunctions = {
    findBestRouterTrade?: typeof findBestRouterTrade;
    findBestIntraOrderbookTrade?: typeof findBestIntraOrderbookTrade;
    findBestInterOrderbookTrade?: typeof findBestInterOrderbookTrade;
    findBestRaindexRouterTrade?: typeof findBestRaindexRouterTrade;
};

/**
 * Get enabled trade fns for a specific orderbook, if the given orderbook is not
 * configured in the orderbook trade types, all trade fns will be enabled as sane default
 * @param orderbookTradeTypes - The trade types configuration from app options
 * @param orderbookAddress - The orderbook address to get enabled trade fns for
 * @returns An object containing the enabled trade functions
 */
export function getEnabledTradeTypeFunctions(
    orderbookTradeTypes: OrderbookTradeTypes,
    orderbookAddress: string,
): TradeTypeFunctions {
    let allEnabled = true;
    const address = orderbookAddress.toLowerCase();
    const result: TradeTypeFunctions = {
        findBestRouterTrade: undefined,
        findBestIntraOrderbookTrade: undefined,
        findBestInterOrderbookTrade: undefined,
        findBestRaindexRouterTrade: undefined,
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
    if (orderbookTradeTypes.raindexRouter.has(address)) {
        result.findBestRaindexRouterTrade = findBestRaindexRouterTrade;
        allEnabled = false;
    }
    if (allEnabled) {
        return {
            findBestRouterTrade,
            findBestIntraOrderbookTrade,
            findBestInterOrderbookTrade,
            findBestRaindexRouterTrade,
        };
    } else {
        return result;
    }
}
