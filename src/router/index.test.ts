import { visualizeRoute } from ".";
import { Token } from "sushi/currency";
import { RouteLeg } from "sushi/tines";
import { LiquidityProviders } from "sushi";
import { describe, it, expect } from "vitest";
import { processLiquidityProviders, ExcludedLiquidityProviders } from ".";

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

describe("Test visualizeRoute", () => {
    function makeToken(address: string, symbol: string): Token {
        return { address, symbol, decimals: 18 } as any;
    }

    function makeLeg(
        from: any,
        to: any,
        poolAddress: string,
        poolName: string,
        absolutePortion: number,
    ): RouteLeg {
        return {
            tokenFrom: from,
            tokenTo: to,
            poolAddress,
            poolName,
            absolutePortion,
        } as any;
    }
    const tokenA = makeToken("0xA", "A");
    const tokenB = makeToken("0xB", "B");
    const tokenC = makeToken("0xC", "C");

    it("should return direct route string", () => {
        const legs = [makeLeg(tokenA, tokenB, "0xPool1", "Pool1", 0.8)];
        const result = visualizeRoute(tokenA, tokenB, legs);
        expect(result.length).toBe(1);
        expect(result[0]).toContain("80.00%");
        expect(result[0]).toContain("B/A (Pool1 0xPool1)");
    });

    it("should return indirect route string", () => {
        const legs = [
            makeLeg(tokenA, tokenC, "0xPool1", "Pool1", 0.5),
            makeLeg(tokenC, tokenB, "0xPool2", "Pool2", 0.5),
        ];
        const result = visualizeRoute(tokenA, tokenB, legs);
        expect(result.length).toBe(1);
        expect(result[0]).toContain("50.00%");
        expect(result[0]).toContain("C/A (Pool1 0xPool1) >> B/C (Pool2 0xPool2)");
    });

    it("should sort routes by absolutePortion descending", () => {
        const legs = [
            makeLeg(tokenA, tokenB, "0xPool1", "Pool1", 0.2),
            makeLeg(tokenA, tokenC, "0xPool2", "Pool2", 0.7),
            makeLeg(tokenC, tokenB, "0xPool3", "Pool3", 0.7),
        ];
        const result = visualizeRoute(tokenA, tokenB, legs);
        expect(result.length).toBe(2);
        // First route should be the one with 0.7 portion
        expect(result[0]).toContain("70.00%");
        expect(result[1]).toContain("20.00%");
    });

    it("should handle unknown symbols gracefully", () => {
        const tokenUnknown = { address: "0xD" }; // no symbol
        const legs = [
            makeLeg(tokenA, tokenUnknown, "0xPool1", "Pool1", 0.6),
            makeLeg(tokenUnknown, tokenB, "0xPool2", "Pool2", 0.6),
        ];
        const result = visualizeRoute(tokenA, tokenB, legs);
        expect(result[0]).toContain("unknownSymbol");
    });

    it("should return empty array if no valid routes", () => {
        const legs = [makeLeg(tokenC, tokenA, "0xPool1", "Pool1", 0.5)];
        const result = visualizeRoute(tokenA, tokenB, legs);
        expect(result).toEqual([]);
    });
});
