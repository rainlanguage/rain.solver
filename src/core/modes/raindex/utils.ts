import { parseUnits } from "viem";
import { ONE18 } from "../../../math";
import { SushiRouterQuote } from "../../../router";

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
    if (quote.price === 0n) return 0n; // not reachable, but handled just in case
    return (outputEthPrice * ONE18) / quote.price;
}
