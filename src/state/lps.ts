import { LiquidityProviders } from "sushi";

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
