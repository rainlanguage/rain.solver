import assert from "assert";
import { RainSolver } from "..";
import { Pair } from "../../order";
import { Result } from "../../common";
import { Token } from "sushi/currency";
import { FindBestTradeResult } from "../types";
import { RainSolverSigner } from "../../signer";
import { Attributes } from "@opentelemetry/api";
import { findBestRouteProcessorTrade } from "./router";
import { findBestIntraOrderbookTrade } from "./intra";
import { findBestInterOrderbookTrade } from "./inter";
import { extendObjectWithHeader } from "../../logger";
import { findBestBalancerTrade } from "./balancer";

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
    const promises = [
        findBestRouteProcessorTrade.call(
            this,
            orderDetails,
            signer,
            inputToEthPrice,
            toToken,
            fromToken,
        ),
        // include balancer trade only if balancer router is available for the operating chain
        ...(this.state.balancerRouter && this.appOptions.balancerArbAddress
            ? [
                  findBestBalancerTrade.call(
                      this,
                      orderDetails,
                      signer,
                      inputToEthPrice,
                      toToken,
                      fromToken,
                  ),
              ]
            : []),
        // include intra and inter orderbook trades types only if rpOnly is false
        ...(!this.appOptions.rpOnly
            ? [
                  findBestIntraOrderbookTrade.call(
                      this,
                      orderDetails,
                      signer,
                      inputToEthPrice,
                      outputToEthPrice,
                  ),
                  findBestInterOrderbookTrade.call(
                      this,
                      orderDetails,
                      signer,
                      inputToEthPrice,
                      outputToEthPrice,
                  ),
              ]
            : []),
    ];
    const results = await Promise.all(promises);

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
