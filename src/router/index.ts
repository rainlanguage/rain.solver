import { RouteLeg } from "sushi/tines";
import { Token } from "sushi/currency";
import { BlackList } from "./blacklist";
import { LiquidityProviders } from "sushi";

export * from "./marketPrice";
export * from "./balancer";

/** Blacklisted pools as a set, used by router */
export const PoolBlackList = new Set(BlackList);

/** A function that filters out blacklisted pools used by sushi router */
export function RPoolFilter(pool: any) {
    return !BlackList.includes(pool.address) && !BlackList.includes(pool.address.toLowerCase());
}

/**
 * List of liquidity providers that are excluded
 */
export const ExcludedLiquidityProviders = [
    LiquidityProviders.CurveSwap,
    LiquidityProviders.Camelot,
    LiquidityProviders.Trident,
] as const;

/**
 * Resolves an array of case-insensitive names to LiquidityProviders type, ignores the ones that are not valid
 * @param liquidityProviders - List of liquidity providers
 */
export function processLiquidityProviders(liquidityProviders?: string[]): LiquidityProviders[] {
    const LPS = Object.values(LiquidityProviders);
    if (!liquidityProviders || !liquidityProviders.length) {
        return LPS.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
    }
    const lps: LiquidityProviders[] = [];
    for (let i = 0; i < liquidityProviders.length; i++) {
        const index = LPS.findIndex(
            (v) => v.toLowerCase() === liquidityProviders[i].toLowerCase().trim(),
        );
        if (index > -1 && !lps.includes(LPS[index])) lps.push(LPS[index]);
    }
    return lps.length ? lps : LPS.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
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
