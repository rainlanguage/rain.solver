import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { LiquidityProviders } from "sushi";
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
    /** The quote of the attempt's trade size simulation */
    quote?: RouterTradeSimulator["quote"];
    /** The trade size (in 18 decimals) that the attempt succeeded with */
    tradeSize?: bigint;
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
 * it first finds the most profitable trade size offchain (full trade size included as
 * a candidate) and simulates that single trade size, then if the simulation gets
 * rejected onchain due to offchain pool data overestimation, it backs off by halving
 * the trade size validated against onchain dryrun until one passes
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

    // find the most profitable trade size offchain, the full trade size is
    // included as a candidate in the search so the winner competes among all
    // viable sizes including the full size
    const mostProfitableTradeSize = this.state.router.findLargestTradeSize(
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
        this.state.gasPrice,
        this.appOptions.route,
        false,
        excludeDexes,
    );

    // fall back to the full trade size when no profitable size was found, ie
    // when the order ratio is above the sushi market price or sushi has no
    // route at all, since the size finder only knows sushi liquidity, while
    // the simulation still quotes balancer and stabull routes as well
    const tradeSize = mostProfitableTradeSize ?? maximumInput;

    // simulate the trade for the determined trade size
    const simulator = RouterTradeSimulator.withArgs({
        type: TradeType.Router,
        solver: this,
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: tradeSize,
        ethPrice,
        isPartial: tradeSize < maximumInput,
        blockNumber,
        excludeDexes,
    });
    const simResult = await simulator.trySimulateTrade();
    const quote = simulator.quote;
    if (simResult.isOk()) {
        return { result: simResult, quote, tradeSize };
    }
    Object.assign(spanAttributes, simResult.error.spanAttributes);
    const reason = simResult.error.reason;

    // if the trade sim got rejected onchain with MinimalOutputBalanceViolation,
    // it means the offchain pool data overestimated the output for the found
    // trade size, so backoff by halving the trade size at each step validated
    // against onchain dryrun and accept the first size that passes, the backoff
    // stops early if a step fails with any other error
    if (SimulationHaltReason.needsRetry(simResult.error.spanAttributes["error"])) {
        let fallbackTradeSize = tradeSize;
        for (let i = 1; i <= 4; i++) {
            fallbackTradeSize /= 2n;
            if (fallbackTradeSize <= 0n) break;
            const fallbackSimulator = RouterTradeSimulator.withArgs({
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
            const fallbackSimResult = await fallbackSimulator.trySimulateTrade();
            if (fallbackSimResult.isOk()) {
                return { result: fallbackSimResult, quote, tradeSize: fallbackTradeSize };
            }
            extendObjectWithHeader(
                spanAttributes,
                fallbackSimResult.error.spanAttributes,
                `fallback${i}`,
            );
            if (!SimulationHaltReason.needsRetry(fallbackSimResult.error.spanAttributes["error"])) {
                break;
            }
        }
    }
    return {
        result: Result.err({
            type: simResult.error.type,
            spanAttributes,
            noneNodeError: simResult.error.noneNodeError,
            reason,
        }),
        quote,
    };
}
