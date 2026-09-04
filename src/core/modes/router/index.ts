import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { LiquidityProviders } from "sushi";
import { AppOptions } from "../../../config";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { SushiRouterQuote } from "../../../router";
import { SimulationResult, TradeType } from "../../types";
import { Result, extendObjectWithHeader } from "../../../common";

/** Represents the result of a router trade attempt paired with its full trade size quote */
export type RouterTradeAttempt = {
    /** The simulation result of the attempt */
    result: SimulationResult;
    /** The quote of the attempt's full trade size simulation */
    quote?: RouterTradeSimulator["quote"];
    /** The trade size (in 18 decimals) that the attempt succeeded with */
    tradeSize?: bigint;
};

/**
 * Tries to find the best trade against rain router (balancer and sushi) for the
 * given order, it will first try normally with all enabled dexes, then only for
 * orders of owners with max profile, it also tries a secondary route with the
 * primary route's dexes excluded regardless of the primary outcome, and picks
 * the result that yields the higher estimated profit and clears the most input,
 * this is because the sushi router lib pool models can be inaccurate for some
 * dexes leading to false positive quotes that dont hold up onchain and also
 * shadow other good routes as long as they wrongly quote the best amount out
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param blockNumber - The current block number
 */
export async function findBestRouterTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
    blockNumber: bigint,
): Promise<SimulationResult> {
    // primary attempt normally with all enabled dexes
    const primary = await tryFindBestRouterTrade.call(
        this,
        orderDetails,
        signer,
        ethPrice,
        toToken,
        fromToken,
        blockNumber,
    );

    // secondary route is only tried for orders of owners with max profile
    const isMaxOwnerProfile = AppOptions.isMaxOwnerProfile(
        orderDetails.takeOrder.struct.order.owner,
        this.appOptions.ownerProfile,
    );
    if (!isMaxOwnerProfile) {
        return primary.result;
    }

    // exit with the primary result if the primary route's dexes cannot be
    // identified, as the secondary attempt would just repeat the primary
    const excludeDexes = SushiRouterQuote.is(primary.quote)
        ? SushiRouterQuote.getRouteDexes(primary.quote)
        : new Set<LiquidityProviders>();
    if (excludeDexes.size !== 1) {
        return primary.result;
    }

    // try the secondary route with the primary route's dexes excluded
    // regardless of the primary outcome
    const secondary = await tryFindBestRouterTrade.call(
        this,
        orderDetails,
        signer,
        ethPrice,
        toToken,
        fromToken,
        blockNumber,
        excludeDexes,
    );

    // when both succeed, pick the one that yields the higher estimated profit
    // and clears the most input, ie the secondary replaces the primary only if
    // it is better in one criteria while not being worse in the other
    if (primary.result.isOk() && secondary.result.isOk()) {
        const primaryProfit = primary.result.value.estimatedProfit;
        const secondaryProfit = secondary.result.value.estimatedProfit;
        const primaryTradeSize = primary.tradeSize ?? 0n;
        const secondaryTradeSize = secondary.tradeSize ?? 0n;
        const secondaryDominates =
            secondaryTradeSize === primaryTradeSize
                ? secondaryProfit > primaryProfit
                : secondaryTradeSize > primaryTradeSize;
        const pickedResult = secondaryDominates ? secondary.result : primary.result;
        pickedResult.value.spanAttributes["pickedRoute"] = secondaryDominates
            ? "secondary"
            : "primary";
        return pickedResult;
    }
    if (primary.result.isOk()) {
        return primary.result;
    }
    if (secondary.result.isOk()) {
        return secondary.result;
    }

    // both failed, report the secondary failure details under its own header
    extendObjectWithHeader(
        primary.result.error.spanAttributes,
        secondary.result.error.spanAttributes,
        "secondary",
    );
    primary.result.error.noneNodeError ??= secondary.result.error.noneNodeError;
    return primary.result;
}

/**
 * Tries to find a trade against rain router (balancer and sushi) for the given order,
 * it will try to simulate a trade for full trade size (order's max output)
 * and if it was not successful it will try again with partial trade size
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param blockNumber - The current block number
 * @param excludeDexes - (optional) Liquidity providers (dexes) to exclude from route finding
 */
export async function tryFindBestRouterTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
    blockNumber: bigint,
    excludeDexes?: Set<LiquidityProviders>,
): Promise<RouterTradeAttempt> {
    const spanAttributes: Attributes = {};

    // exit early if required trade addresses are not configured
    if (!this.state.contracts.getAddressesForTrade(orderDetails, TradeType.Router)) {
        spanAttributes["error"] =
            `Cannot trade as sushi route processor and balancer arb addresses are not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
        return {
            result: Result.err({
                type: TradeType.Router,
                spanAttributes,
                reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
            }),
        };
    }

    // exit early if eth price is unknown
    if (!ethPrice) {
        spanAttributes["error"] = "no route to get price of input token to eth";
        return {
            result: Result.err({
                type: TradeType.Router,
                spanAttributes,
            }),
        };
    }

    const maximumInput = orderDetails.takeOrder.quote!.maxOutput;

    // try simulation for full trade size and return if succeeds
    const fullTradeSimulator = RouterTradeSimulator.withArgs({
        type: TradeType.Router,
        solver: this,
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: maximumInput,
        ethPrice,
        isPartial: false,
        blockNumber,
        excludeDexes,
    });
    const fullTradeSizeSimResult = await fullTradeSimulator.trySimulateTrade();
    let quote = fullTradeSimulator.quote;
    if (fullTradeSizeSimResult.isOk()) {
        return { result: fullTradeSizeSimResult, quote, tradeSize: maximumInput };
    }
    extendObjectWithHeader(spanAttributes, fullTradeSizeSimResult.error.spanAttributes, "full");

    // return early if dryrun failed
    // in other words only try partial trade size if the full trade size failed due
    // to order ratio being greater than market price or there was no route for full
    // trade size, that's because if for example for a pair there is only 1 pool and that
    // pool has certain amount of reserves that cant cover the full trade size but can
    // cover partial, we still need to try it
    if (
        fullTradeSizeSimResult.error.reason !== SimulationHaltReason.NoRoute &&
        fullTradeSizeSimResult.error.reason !==
            SimulationHaltReason.OrderRatioGreaterThanMarketPrice
    ) {
        return {
            result: Result.err({
                type: fullTradeSizeSimResult.error.type,
                spanAttributes,
                noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
                reason: fullTradeSizeSimResult.error.reason,
            }),
            quote,
        };
    }

    // try simulation for partial trade size
    const partialTradeSize = this.state.router.findLargestTradeSize(
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
        this.state.gasPrice,
        this.appOptions.route,
        false,
        excludeDexes,
    );
    if (!partialTradeSize) {
        spanAttributes["partial.error"] = "no viable partial trade size found";
        return {
            result: Result.err({
                type: fullTradeSizeSimResult.error.type,
                spanAttributes,
                noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
            }),
            quote,
        };
    }
    const partialTradeSimulator = RouterTradeSimulator.withArgs({
        type: TradeType.Router,
        solver: this,
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: partialTradeSize,
        ethPrice,
        isPartial: true,
        blockNumber,
        excludeDexes,
    });
    const partialTradeSizeSimResult = await partialTradeSimulator.trySimulateTrade();
    quote = partialTradeSimulator.quote ?? quote;
    if (partialTradeSizeSimResult.isOk()) {
        return { result: partialTradeSizeSimResult, quote, tradeSize: partialTradeSize };
    }
    extendObjectWithHeader(
        spanAttributes,
        partialTradeSizeSimResult.error.spanAttributes,
        "partial",
    );

    // if the partial trade size sim got rejected onchain with MinimalOutputBalanceViolation,
    // it means the offchain pool data overestimated the output for the found partial trade
    // size, so backoff by halving the trade size at each step validated against onchain
    // dryrun and accept the first size that passes, the backoff stops early if a step fails
    // with any other error
    const reason = partialTradeSizeSimResult.error.reason;
    if (SimulationHaltReason.needsRetry(partialTradeSizeSimResult.error.spanAttributes["error"])) {
        let fallbackTradeSize = partialTradeSize;
        for (let i = 1; i <= 4; i++) {
            fallbackTradeSize /= 2n;
            if (fallbackTradeSize <= 0n) break;
            const partialFallbackSimulator = RouterTradeSimulator.withArgs({
                type: TradeType.Router,
                solver: this,
                orderDetails,
                fromToken,
                toToken,
                signer,
                maximumInputFixed: fallbackTradeSize,
                ethPrice,
                isPartial: true,
                blockNumber,
                excludeDexes,
            });
            const partialFallbackSimResult = await partialFallbackSimulator.trySimulateTrade();
            if (partialFallbackSimResult.isOk()) {
                return { result: partialFallbackSimResult, quote, tradeSize: fallbackTradeSize };
            }
            extendObjectWithHeader(
                spanAttributes,
                partialFallbackSimResult.error.spanAttributes,
                `partialFallback${i}`,
            );
            if (
                !SimulationHaltReason.needsRetry(
                    partialFallbackSimResult.error.spanAttributes["error"],
                )
            ) {
                break;
            }
        }
    }
    return {
        result: Result.err({
            type: fullTradeSizeSimResult.error.type,
            spanAttributes,
            noneNodeError:
                fullTradeSizeSimResult.error.noneNodeError ??
                partialTradeSizeSimResult.error.noneNodeError,
            reason,
        }),
        quote,
    };
}
