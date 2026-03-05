import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { SimulationResult, TradeType } from "../../types";
import { Result, extendObjectWithHeader } from "../../../common";

/**
 * Tries to find the best trade against rain router (balancer and sushi) for the given order,
 * it will try to simulate a trade for full trade size (order's max output)
 * and if it was not successful it will try again with partial trade size
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
    const spanAttributes: Attributes = {};

    // exit early if required trade addresses are not configured
    if (!this.state.contracts.getAddressesForTrade(orderDetails, TradeType.Router)) {
        spanAttributes["error"] =
            `Cannot trade as sushi route processor and balancer arb addresses are not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
        return Result.err({
            type: TradeType.Router,
            spanAttributes,
            reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
        });
    }

    // exit early if eth price is unknown
    if (!ethPrice) {
        spanAttributes["error"] = "no route to get price of input token to eth";
        return Result.err({
            type: TradeType.Router,
            spanAttributes,
        });
    }

    const maximumInput = orderDetails.takeOrder.quote!.maxOutput;

    // try simulation for full trade size and return if succeeds
    const fullTradeSizeSimResult = await RouterTradeSimulator.withArgs({
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
    }).trySimulateTrade();
    if (fullTradeSizeSimResult.isOk()) {
        return fullTradeSizeSimResult;
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
        return Result.err({
            type: fullTradeSizeSimResult.error.type,
            spanAttributes,
            noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
        });
    }

    // try simulation for partial trade size
    const partialTradeSize = this.state.router.findLargestTradeSize(
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
        this.state.gasPrice,
        this.appOptions.route,
    );
    if (!partialTradeSize) {
        return Result.err({
            type: fullTradeSizeSimResult.error.type,
            spanAttributes,
            noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
        });
    }
    const partialTradeSizeSimResult = await RouterTradeSimulator.withArgs({
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
    }).trySimulateTrade();
    if (partialTradeSizeSimResult.isOk()) {
        return partialTradeSizeSimResult;
    }
    extendObjectWithHeader(
        spanAttributes,
        partialTradeSizeSimResult.error.spanAttributes,
        "partial",
    );
    return Result.err({
        type: fullTradeSizeSimResult.error.type,
        spanAttributes,
        noneNodeError:
            fullTradeSizeSimResult.error.noneNodeError ??
            partialTradeSizeSimResult.error.noneNodeError,
    });
}
