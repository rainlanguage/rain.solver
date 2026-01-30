import { parseUnits } from "viem";
import { Pair } from "../../../order";
import { ONE18, scaleTo18 } from "../../../math";
import { SushiRouterQuote } from "../../../router";

export function calcCounterpartyInputProfit(
    counterparty: Pair,
    quote: SushiRouterQuote,
): {
    counterpartyInputProfit: bigint;
    counterpartyMaxOutput: bigint;
} {
    const maxSushiOutput = scaleTo18(quote.amountOut, counterparty.buyTokenDecimals);
    const counterpartyMaxInputFixed =
        (counterparty.takeOrder.quote!.maxOutput * counterparty.takeOrder.quote!.ratio) / ONE18;
    let counterpartyInputProfit = 0n;
    let counterpatryMaxInput = maxSushiOutput;
    if (maxSushiOutput > counterpartyMaxInputFixed) {
        counterpartyInputProfit = maxSushiOutput - counterpartyMaxInputFixed;
        counterpatryMaxInput = counterpartyMaxInputFixed;
    }
    let counterpartyMaxOutput = counterparty.takeOrder.quote!.maxOutput;
    if (
        counterparty.takeOrder.quote!.ratio === 0n ||
        counterpatryMaxInput === counterpartyMaxInputFixed
    ) {
        counterpartyMaxOutput = counterparty.takeOrder.quote!.maxOutput;
    } else {
        counterpartyMaxOutput =
            (counterpatryMaxInput * ONE18) / counterparty.takeOrder.quote!.ratio;
    }

    return {
        counterpartyInputProfit,
        counterpartyMaxOutput,
    };
}

export function calcCounterpartyOutputToEthPrice(
    counterpartyInputToEthPrice: bigint,
    ratio: bigint,
    counterpartyOutputToEthPrice?: string,
): bigint {
    if (counterpartyOutputToEthPrice) {
        return parseUnits(counterpartyOutputToEthPrice, 18);
    } else {
        return (counterpartyInputToEthPrice * ratio) / ONE18;
    }
}

export function calcCounterpartyInputToEthPrice(
    quote: SushiRouterQuote,
    outputToEthPrice?: string,
): bigint {
    if (!outputToEthPrice) return 0n;
    const outputEthPrice = parseUnits(outputToEthPrice, 18);
    return (outputEthPrice * ONE18) / quote.price;
}
