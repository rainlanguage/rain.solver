import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { AppOptions } from "../../../config";
import { LiquidityProviders } from "sushi";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { SushiRouterQuote, TradeSizeStatus } from "../../../router";
import { SimulationResult, TradeType } from "../../types";
import { Result, extendObjectWithHeader } from "../../../common";

/** Represents the result of a router trade attempt paired with its full trade size quote */
export type RouterTradeAttempt = {
    /** The simulation result of the attempt */
    result: SimulationResult;
    /** The quote of the attempt's full trade size simulation */
    quote?: RouterTradeSimulator["quote"];
};

/**
 * Tries to find the best trade against rain router (balancer and sushi) for the
 * given order, it will first try normally with all enabled dexes, and if the best
 * route got rejected onchain during dryrun, it will try once more with the failing
 * route's dexes excluded, so the next best route is tried, this is because the
 * sushi router lib pool models can be inaccurate for some dexes leading to false
 * positive quotes that dont hold up onchain and also shadow other good routes as
 * long as they wrongly quote the best amount out
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
    if (primary.result.isOk()) {
        return primary.result;
    }

    // retry once more with the primary attempt's failing route dexes
    // excluded if it was rejected onchain during dryrun
    const excludeDexes = SushiRouterQuote.is(primary.quote)
        ? SushiRouterQuote.getRouteDexes(primary.quote)
        : new Set<LiquidityProviders>();
    if (
        primary.result.error.reason === SimulationHaltReason.NoOpportunity &&
        excludeDexes.size == 1
    ) {
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
        if (secondary.result.isOk()) {
            return secondary.result;
        }
        extendObjectWithHeader(
            primary.result.error.spanAttributes,
            secondary.result.error.spanAttributes,
            "secondary",
        );
        primary.result.error.noneNodeError ??= secondary.result.error.noneNodeError;
    }
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
        return { result: fullTradeSizeSimResult, quote };
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

    // try simulation for partial trade size, a price mismatch result still
    // carries the biggest routed size which is simulated as partial trade
    // size and can then feed the fallback backoff on failure
    const partialTradeSizeResult = this.state.router.findLargestTradeSize(
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
        this.state.gasPrice,
        this.appOptions.route,
        false,
        excludeDexes,
    );
    if (partialTradeSizeResult.status === TradeSizeStatus.NoWay) {
        spanAttributes["partial.error"] = "found no route for any trade size";
        return {
            result: Result.err({
                type: fullTradeSizeSimResult.error.type,
                spanAttributes,
                noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
            }),
            quote,
        };
    }
    const partialTradeSize = partialTradeSizeResult.size;
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
        // plug in the winning probe quote of the size search, so the sushi
        // router doesnt recompute the same route for the same size again
        sushiQuote: partialTradeSizeResult.quote,
    });
    const partialTradeSizeSimResult = await partialTradeSimulator.trySimulateTrade();
    quote = partialTradeSimulator.quote ?? quote;
    if (partialTradeSizeSimResult.isOk()) {
        return { result: partialTradeSizeSimResult, quote };
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
    // with any other error, the backoff only runs when enabled by config, and for orders
    // of max profile owners with strictMaxOwnerProfilePartialTradeSizeCheck config enabled,
    // it runs on ANY partial sim failure, so smaller sizes get probed against the real
    // chain even when the offchain quotes show no price match
    const reason = partialTradeSizeSimResult.error.reason;
    if (
        this.appOptions.routerPartialFallback &&
        (SimulationHaltReason.needsRetry(partialTradeSizeSimResult.error.spanAttributes["error"]) ||
            (this.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck &&
                AppOptions.isMaxOwnerProfile(
                    orderDetails.takeOrder.struct.order.owner,
                    this.appOptions.ownerProfile,
                )))
    ) {
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
                return { result: partialFallbackSimResult, quote };
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
