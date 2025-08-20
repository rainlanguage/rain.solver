import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { Result } from "../../../common";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { extendObjectWithHeader } from "../../../logger";
import { SimulationResult, TradeType } from "../../types";
import { trySimulateTrade } from "./simulate";

/**
 * Tries to find the best trade against balancer protocol for the given order,
 * it will try to simulate a trade for full trade size (order's max output)
 * and if it was not successful it will try again with partial trade size
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param ethPrice - The current ETH price
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 */
export async function findBestBalancerTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    ethPrice: string,
    toToken: Token,
    fromToken: Token,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};

    // exit early if eth price is unknown
    if (!ethPrice) {
        spanAttributes["error"] = "no route to get price of input token to eth";
        return Result.err({
            type: TradeType.Balancer,
            spanAttributes,
        });
    }

    const maximumInput = orderDetails.takeOrder.quote!.maxOutput;
    const blockNumber = await this.state.client.getBlockNumber();

    // try simulation for full trade size and return if succeeds
    const simResult = await trySimulateTrade.call(this, {
        orderDetails,
        fromToken,
        toToken,
        signer,
        maximumInputFixed: maximumInput,
        ethPrice,
        isPartial: false,
        blockNumber,
    });
    if (simResult.isOk()) {
        return simResult;
    }
    extendObjectWithHeader(spanAttributes, simResult.error.spanAttributes, "full");

    return Result.err({
        type: TradeType.Balancer,
        spanAttributes,
        noneNodeError: simResult.error.noneNodeError,
    });
}
