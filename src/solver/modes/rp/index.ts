import { RainSolver } from "../..";
import { Token } from "sushi/currency";
import { Result } from "../../../result";
import { BundledOrders } from "../../../order";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { extendObjectWithHeader } from "../../../logger";
import { SimulationResult, TradeType } from "../../types";
import {
    trySimulateTrade,
    findLargestTradeSize,
    RouteProcessorSimulationHaltReason,
} from "./simulate";

/**
 * Tries to find the best trade against route processor for the given order,
 * it will try to simulate a trade for full trade size (order's max output)
 * and if it was not successful it will try again with partial trade size
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 */
export async function findBestRouteProcessorTrade(
    this: RainSolver,
    orderDetails: BundledOrders,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};
    const maximumInput = orderDetails.takeOrders.reduce((a, b) => a + b.quote!.maxOutput, 0n);
    const blockNumber = await this.state.client.getBlockNumber();

    // try simulation for full trade size and return if succeeds
    const fullTradeSizeSimResult = await trySimulateTrade.call(this, {
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: maximumInput,
        ethPrice,
        isPartial: false,
        blockNumber,
    });
    if (fullTradeSizeSimResult.isOk()) {
        return fullTradeSizeSimResult;
    }
    extendObjectWithHeader(spanAttributes, fullTradeSizeSimResult.error.spanAttributes, "full");

    // return early if no route was found for this order's pair
    if (fullTradeSizeSimResult.error.reason === RouteProcessorSimulationHaltReason.NoRoute) {
        return Result.err({
            type: TradeType.RouteProcessor,
            spanAttributes,
            noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
        });
    }

    // try simulation for partial trade size
    const partialTradeSize = findLargestTradeSize.call(
        this,
        orderDetails,
        toToken,
        fromToken,
        maximumInput,
    );
    if (!partialTradeSize) {
        return Result.err({
            type: TradeType.RouteProcessor,
            spanAttributes,
            noneNodeError: fullTradeSizeSimResult.error.noneNodeError,
        });
    }
    const partialTradeSizeSimResult = await trySimulateTrade.call(this, {
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: maximumInput,
        ethPrice,
        isPartial: true,
        blockNumber,
    });
    if (partialTradeSizeSimResult.isOk()) {
        return partialTradeSizeSimResult;
    }
    extendObjectWithHeader(
        spanAttributes,
        partialTradeSizeSimResult.error.spanAttributes,
        "partial",
    );
    return Result.err({
        type: TradeType.RouteProcessor,
        spanAttributes,
        noneNodeError:
            fullTradeSizeSimResult.error.noneNodeError ??
            partialTradeSizeSimResult.error.noneNodeError,
    });
}
