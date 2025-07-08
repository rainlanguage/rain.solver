import { ONE18 } from "../../../math";

/** Estimates profit for a route processor clear mode */
export function estimateProfit(
    orderDetails: any,
    ethPrice: bigint,
    marketPrice: bigint,
    maxInput: bigint,
): bigint {
    const marketAmountOut = (maxInput * marketPrice) / ONE18;
    const orderInput = (maxInput * orderDetails.takeOrders[0].quote.ratio) / ONE18;
    const estimatedProfit = marketAmountOut - orderInput;
    return (estimatedProfit * ethPrice) / ONE18;
}
