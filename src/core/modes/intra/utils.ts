import { ONE18 } from "../../../math";
import { Pair, TakeOrderDetails } from "../../../order";

/**
 * Estimates profit for a arb/clear2 tx
 * @param orderDetails
 * @param inputToEthPrice
 * @param outputToEthPrice
 * @param counterpartyOrder
 * @param marketPrice
 * @param maxInput
 */
export function estimateProfit(
    orderDetails: Pair,
    inputToEthPrice: bigint,
    outputToEthPrice: bigint,
    counterpartyOrder: TakeOrderDetails,
): bigint {
    const orderMaxInput =
        (orderDetails.takeOrder.quote!.maxOutput * orderDetails.takeOrder.quote!.ratio) / ONE18;
    const opposingMaxInput =
        (counterpartyOrder.quote!.maxOutput * counterpartyOrder.quote!.ratio) / ONE18;

    const orderOutput =
        counterpartyOrder.quote!.ratio === 0n
            ? orderDetails.takeOrder.quote!.maxOutput
            : orderDetails.takeOrder.quote!.maxOutput <= opposingMaxInput
              ? orderDetails.takeOrder.quote!.maxOutput
              : opposingMaxInput;
    const orderInput = (orderOutput * orderDetails.takeOrder.quote!.ratio) / ONE18;

    const opposingOutput =
        counterpartyOrder.quote!.ratio === 0n
            ? counterpartyOrder.quote!.maxOutput
            : orderMaxInput <= counterpartyOrder.quote!.maxOutput
              ? orderMaxInput
              : counterpartyOrder.quote!.maxOutput;
    const opposingInput = (opposingOutput * counterpartyOrder.quote!.ratio) / ONE18;

    let outputProfit = orderOutput - opposingInput;
    if (outputProfit < 0n) outputProfit = 0n;
    outputProfit = (outputProfit * outputToEthPrice) / ONE18;

    let inputProfit = opposingOutput - orderInput;
    if (inputProfit < 0n) inputProfit = 0n;
    inputProfit = (inputProfit * inputToEthPrice) / ONE18;

    return outputProfit + inputProfit;
}
