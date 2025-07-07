import { maxUint256 } from "viem";
import { ONE18 } from "../../../math";
import { Pair } from "../../../order";

/** Estimates profit for a inter-orderbook trade */
export function estimateProfit(
    orderDetails: any,
    inputToEthPrice: bigint,
    outputToEthPrice: bigint,
    counterpartyOrder: Pair,
    maxInput: bigint,
): bigint {
    const orderOutput = maxInput;
    const orderInput = (maxInput * orderDetails.takeOrders[0].quote.ratio) / ONE18;

    let opposingMaxInput =
        orderDetails.takeOrders[0].quote.ratio === 0n
            ? maxUint256
            : (maxInput * orderDetails.takeOrders[0].quote.ratio) / ONE18;
    const opposingMaxIORatio =
        orderDetails.takeOrders[0].quote.ratio === 0n
            ? maxUint256
            : ONE18 ** 2n / orderDetails.takeOrders[0].quote.ratio;

    let counterpartyInput = 0n;
    let counterpartyOutput = 0n;
    const quote = counterpartyOrder.takeOrder.quote!;
    if (opposingMaxIORatio >= quote.ratio) {
        const maxOut = opposingMaxInput < quote.maxOutput ? opposingMaxInput : quote.maxOutput;
        counterpartyOutput += maxOut;
        counterpartyInput += (maxOut * quote.ratio) / ONE18;
        opposingMaxInput -= maxOut;
    }
    const outputProfit = ((orderOutput - counterpartyInput) * outputToEthPrice) / ONE18;
    const inputProfit = ((counterpartyOutput - orderInput) * inputToEthPrice) / ONE18;
    return outputProfit + inputProfit;
}
