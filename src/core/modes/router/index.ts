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

/** Represents the result of a router trade attempt paired with the quote it was judged on */
export type RouterTradeAttempt = {
    /** The simulation result of the attempt */
    result: SimulationResult;
    /** The quote every sim of the attempt was locked to, ie the one a secondary route try excludes the dexes of */
    quote?: RouterTradeSimulator["quote"];
};

/**
 * Tries to find the best trade against rain router (balancer and sushi) for the
 * given order, it will first try normally with all enabled dexes, and if the best
 * route got rejected onchain during dryrun, it will try once more with the failing
 * route's dexes excluded, so the next best route is tried, this is because the
 * sushi router lib pool models can be inaccurate for some dexes leading to false
 * positive quotes that dont hold up onchain and also shadow other good routes as
 * long as they wrongly quote the best amount out, the routerSecondaryRouteTry config
 * sets which orders get the secondary try, all orders, max profile owners only, or none
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param blockNumber - The current block number
 * @param outputToEthPrice - (optional) The output token to eth price, used for the dust checks
 */
export async function findBestRouterTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
    blockNumber: bigint,
    outputToEthPrice?: string,
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
        undefined,
        outputToEthPrice,
    );
    if (primary.result.isOk()) {
        return primary.result;
    }

    // retry once more with the primary attempt's failing route dexes excluded
    // if it was rejected onchain during dryrun and the config allows it for this order
    const secondaryRouteTry = this.appOptions.routerSecondaryRouteTry;
    const isSecondaryRouteTryEnabled =
        secondaryRouteTry === "all" ||
        (secondaryRouteTry === "max" &&
            AppOptions.isMaxOwnerProfile(
                orderDetails.takeOrder.struct.order.owner,
                this.appOptions.ownerProfile,
            ));
    const excludeDexes = SushiRouterQuote.is(primary.quote)
        ? SushiRouterQuote.getRouteDexes(primary.quote)
        : new Set<LiquidityProviders>();
    if (
        isSecondaryRouteTryEnabled &&
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
            outputToEthPrice,
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
 * Tries to find a trade against rain router for the given order, the size finder
 * settles on the biggest trade size that routes and clears the order ratio offchain,
 * probing the full size (order's max output) first, the route it settles on is then
 * locked for every sim of the attempt, which all run concurrently as one batch of
 * trade sizes validated against the onchain dryrun, the found size and its halved
 * sizes (three quarters of it and its halved sizes), the biggest size that passes
 * wins, the backoff sizes run when enabled by
 * routerPartialFallback config, or for orders of max profile owners when enabled by
 * strictMaxOwnerProfilePartialTradeSizeCheck config, a found size that counts as
 * dust is never simulated, orders of max profile owners with the strict check
 * enabled then back off from the full size instead, as the pool model most likely
 * underestimated what the route can take, while other orders bail out
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param blockNumber - The current block number
 * @param excludeDexes - (optional) Liquidity providers (dexes) to exclude from route finding
 * @param outputToEthPrice - (optional) The output token to eth price, used for the dust checks
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
    outputToEthPrice?: string,
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

    // find the biggest trade size that routes and clears the order ratio offchain,
    // the full size is probed first, so a full size that clears it costs no search,
    // no route at any size or no size that clears the ratio means no trade
    const tradeSizeResult = this.state.router.findLargestTradeSize(
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
        this.state.gasPrice,
        this.appOptions.route,
        false,
        excludeDexes,
    );
    if (tradeSizeResult.status === TradeSizeStatus.NoWay) {
        spanAttributes["error"] = "found no route for any trade size";
        return {
            result: Result.err({
                type: TradeType.Router,
                spanAttributes,
                reason: SimulationHaltReason.NoRoute,
            }),
        };
    }
    if (tradeSizeResult.status === TradeSizeStatus.PriceMismatch) {
        spanAttributes["error"] = "found no trade size that clears the order ratio";
        return {
            result: Result.err({
                type: TradeType.Router,
                spanAttributes,
                reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            }),
            quote: tradeSizeResult.quote,
        };
    }
    const { size: tradeSize, quote } = tradeSizeResult;
    const isFullSize = tradeSize >= maximumInput;
    const shouldStrictSimulate =
        this.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck &&
        AppOptions.isMaxOwnerProfile(
            orderDetails.takeOrder.struct.order.owner,
            this.appOptions.ownerProfile,
        );
    const steps = this.appOptions.routerPartialFallbackSteps;

    // a trade size is dust by the dust checks enabled in the app options, the state
    // decides with its best known gas cost estimate for the pair, an undecided check
    // (for lack of its inputs) does not count as dust, with no dust check enabled there
    // is no dust logic at all, a dust size never gets simulated as it cannot pay the gas
    const isDustSize = (size: bigint): boolean =>
        !!this.state.isDustTrade(orderDetails, outputToEthPrice, this.state.gasTokenUsdPrice, size);

    // build the batch of trade sizes, the found size and its backoff sizes, a dust
    // found size is not worth a sim, the pool model most likely underestimated what
    // the route can take in that case, so orders of max profile owners with the
    // strict check enabled back off from the full size instead, other orders bail out
    let tradeSizes: bigint[];
    if (!isFullSize && isDustSize(tradeSize)) {
        spanAttributes["dustTradeSize"] = true;
        tradeSizes = shouldStrictSimulate
            ? getHalvedTradeSizes(maximumInput, steps, isDustSize)
            : [];
        if (!tradeSizes.length) {
            spanAttributes["error"] = "dust trade size";
            return {
                result: Result.err({
                    type: TradeType.Router,
                    spanAttributes,
                    reason: SimulationHaltReason.DustTradeSize,
                }),
                quote,
            };
        }
    } else {
        tradeSizes = [tradeSize];
        if (this.appOptions.routerPartialFallback || shouldStrictSimulate) {
            tradeSizes.push(...getHalvedTradeSizes(tradeSize, steps, isDustSize));
        }
    }

    const result = await simulateTradeSizes.call(
        this,
        orderDetails,
        signer,
        ethPrice,
        toToken,
        fromToken,
        blockNumber,
        tradeSizes,
        spanAttributes,
        quote,
        excludeDexes,
    );
    return { result, quote };
}

/**
 * Builds the backoff trade sizes of the given size, three quarters of it first,
 * followed by its halved sizes, as many as the given steps, the first one being half
 * of the given size, the sizes stop at the first one that reaches zero or counts as
 * dust, since the smaller sizes are then dust as well, no steps means no sizes at all
 * @param size - The trade size to back off from
 * @param steps - The max number of halved sizes
 * @param isDust - (optional) Tells if a trade size is dust, no size is dust by default
 */
export function getHalvedTradeSizes(
    size: bigint,
    steps: number,
    isDust: (size: bigint) => boolean = () => false,
): bigint[] {
    if (steps <= 0) return [];
    const sizes: bigint[] = [];
    const threeQuarters = (size * 3n) / 4n;
    if (threeQuarters <= 0n || isDust(threeQuarters)) return sizes;
    sizes.push(threeQuarters);
    for (let i = 0; i < steps; i++) {
        size /= 2n;
        if (size <= 0n || isDust(size)) break;
        sizes.push(size);
    }
    return sizes;
}

/**
 * Simulates the given trade sizes (in descending order) validated against onchain
 * dryrun and returns the biggest size that passes, the sims all launch concurrently
 * and are all awaited, the sims are all locked to the route of the given quote instead
 * of quoting again and skip the offchain price match check to go straight to dryrun,
 * since the onchain dryrun is the judge of the sizes, a size below the order's max
 * output counts as a partial trade, when none of the sizes pass, their span attributes
 * get merged into the given attributes indexed by size order and the biggest size
 * failure represents the batch in the returned error, with the given attributes as its own
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param blockNumber - The current block number
 * @param tradeSizes - The trade sizes to simulate, in descending order
 * @param spanAttributes - The attributes to merge the failed sims attributes into
 * @param quote - The sushi quote to lock the route of
 * @param excludeDexes - (optional) Liquidity providers (dexes) to exclude from route finding
 */
export async function simulateTradeSizes(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
    blockNumber: bigint,
    tradeSizes: bigint[],
    spanAttributes: Attributes,
    quote: SushiRouterQuote,
    excludeDexes?: Set<LiquidityProviders>,
): Promise<SimulationResult> {
    const maximumInput = orderDetails.takeOrder.quote!.maxOutput;
    const sims = tradeSizes.map((size) =>
        RouterTradeSimulator.withArgs({
            type: TradeType.Router,
            solver: this,
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: size,
            ethPrice,
            isPartial: size < maximumInput,
            blockNumber,
            excludeDexes,
            sushiQuote: quote,
            lockRoute: true,
            skipPriceMatchCheck: true,
        }).trySimulateTrade(),
    );
    // wait for all sims and take the biggest size that passed, not the first
    // one that resolved, the sims run concurrently so this only costs the
    // slowest sim's latency, which is paid anyway when all of them fail
    const results = await Promise.all(sims);
    const pick = results.find((result) => result.isOk());
    if (pick) {
        return pick;
    }

    // merge the failed sims attributes indexed by size order
    const failures = results.flatMap((result) => (result.isErr() ? [result.error] : []));
    failures.forEach((failure, i) => {
        extendObjectWithHeader(spanAttributes, failure.spanAttributes, `step${i + 1}`);
    });
    // the biggest size failure represents the batch
    return Result.err({
        type: failures[0]?.type ?? TradeType.Router,
        spanAttributes,
        reason: failures[0]?.reason,
        noneNodeError: failures[0]?.noneNodeError,
    });
}
