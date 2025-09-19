import { LiquidityProviders } from "sushi";
import { describe, it, expect } from "vitest";
import { processLiquidityProviders, ExcludedLiquidityProviders } from "./lps";

describe("Test processLiquidityProviders", () => {
    it("should return all providers except excluded when input is undefined", () => {
        const result = processLiquidityProviders();
        ExcludedLiquidityProviders.forEach((lp) => {
            expect(result).not.toContain(lp);
        });
        // should contain at least one included provider
        expect(result.length).toBeGreaterThan(0);
    });

    it("should return all providers except excluded when input is empty", () => {
        const result = processLiquidityProviders([]);
        ExcludedLiquidityProviders.forEach((lp) => {
            expect(result).not.toContain(lp);
        });
        expect(result.length).toBeGreaterThan(0);
    });

    it("should return only valid providers from input (case-insensitive)", () => {
        const input = ["UniswapV2", "uniswapv3", "curveSwap", "camelot", "notAProvider"];
        const result = processLiquidityProviders(input);
        expect(result).toContain(LiquidityProviders.UniswapV2);
        expect(result).toContain(LiquidityProviders.UniswapV3);
        expect(result).toContain(LiquidityProviders.CurveSwap);
        expect(result).toContain(LiquidityProviders.Camelot);
        expect(result).not.toContain("notAProvider" as any);
    });

    it("should ignore invalid providers and return filtered list", () => {
        const input = ["notAProvider", "anotherFake"];
        const result = processLiquidityProviders(input);
        ExcludedLiquidityProviders.forEach((lp) => {
            expect(result).not.toContain(lp);
        });
        expect(result.length).toBeGreaterThan(0);
    });

    it("should not include duplicates", () => {
        const input = ["UniswapV2", "uniswapv2", "UNISWAPV2"];
        const result = processLiquidityProviders(input);
        const count = result.filter((lp) => lp === LiquidityProviders.UniswapV2).length;
        expect(count).toBe(1);
    });
});
