import { ONE18 } from "../../../math";
import { Pair } from "../../../order";

/** Estimates profit for a route processor clear mode */
export function estimateProfit(
    orderDetails: Pair,
    ethPrice: bigint,
    marketPrice: bigint,
    maxInput: bigint,
): bigint {
    const marketAmountOut = (maxInput * marketPrice) / ONE18;
    const orderInput = (maxInput * orderDetails.takeOrder.quote!.ratio) / ONE18;
    const estimatedProfit = marketAmountOut - orderInput;
    return (estimatedProfit * ethPrice) / ONE18;
}
