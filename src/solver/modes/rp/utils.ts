import { ONE18 } from "../../../math";
import { Token } from "sushi/currency";
import { RouteLeg } from "sushi/tines";

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

/**
 * Method to visualize the routes, returns array of route strings sorted from highest to lowest percentage
 * @param fromToken - The from token address
 * @param toToken - The to token address
 * @param legs - The legs of the route
 */
export function visualizeRoute(fromToken: Token, toToken: Token, legs: RouteLeg[]): string[] {
    return [
        // direct
        ...legs
            .filter(
                (v) =>
                    v.tokenTo.address.toLowerCase() === toToken.address.toLowerCase() &&
                    v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase(),
            )
            .map((v) => [v]),

        // indirect
        ...legs
            .filter(
                (v) =>
                    v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase() &&
                    v.tokenTo.address.toLowerCase() !== toToken.address.toLowerCase(),
            )
            .map((v) => {
                const portions: RouteLeg[] = [v];
                while (
                    portions.at(-1)?.tokenTo.address.toLowerCase() !== toToken.address.toLowerCase()
                ) {
                    const legPortion = legs.find(
                        (e) =>
                            e.tokenFrom.address.toLowerCase() ===
                                portions.at(-1)?.tokenTo.address.toLowerCase() &&
                            portions.every(
                                (k) => k.poolAddress.toLowerCase() !== e.poolAddress.toLowerCase(),
                            ),
                    );
                    if (legPortion) {
                        portions.push(legPortion);
                    } else {
                        break;
                    }
                }
                return portions;
            }),
    ]
        .sort((a, b) => b[0].absolutePortion - a[0].absolutePortion)
        .map(
            (v) =>
                (v[0].absolutePortion * 100).toFixed(2).padStart(5, "0") +
                "%   --->   " +
                v
                    .map(
                        (e) =>
                            (e.tokenTo.symbol ??
                                (e.tokenTo.address.toLowerCase() === toToken.address.toLowerCase()
                                    ? toToken.symbol
                                    : "unknownSymbol")) +
                            "/" +
                            (e.tokenFrom.symbol ??
                                (e.tokenFrom.address.toLowerCase() ===
                                fromToken.address.toLowerCase()
                                    ? fromToken.symbol
                                    : "unknownSymbol")) +
                            " (" +
                            (e as any).poolName +
                            " " +
                            e.poolAddress +
                            ")",
                    )
                    .join(" >> "),
        );
}
