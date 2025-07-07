import { ONE18 } from "../../../math";
import { Token } from "sushi/currency";
import { RouteLeg } from "sushi/tines";
import { describe, it, expect } from "vitest";
import { visualizeRoute, estimateProfit } from "./utils";

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

describe("Test estimateProfit", () => {
    it("should estimate profit correctly for typical values", () => {
        const orderDetails = {
            takeOrders: [
                { quote: { ratio: 2n * ONE18 } }, // ratio = 2.0
            ],
        };
        const ethPrice = 3n * ONE18; // 3 ETH
        const marketPrice = 4n * ONE18; // 4.0
        const maxInput = 10n * ONE18; // 10 units

        // marketAmountOut = (10 * 4) / 1 = 40
        // orderInput = (10 * 2) / 1 = 20
        // estimatedProfit = 40 - 20 = 20
        // final = (20 * 3) / 1 = 60
        const result = estimateProfit(orderDetails, ethPrice, marketPrice, maxInput);
        expect(result).toBe(60n * ONE18);
    });

    it("should return 0 if marketPrice equals order ratio", () => {
        const orderDetails = {
            takeOrders: [{ quote: { ratio: 5n * ONE18 } }],
        };
        const ethPrice = 1n * ONE18;
        const marketPrice = 5n * ONE18;
        const maxInput = 2n * ONE18;

        // marketAmountOut = (2 * 5) / 1 = 10
        // orderInput = (2 * 5) / 1 = 10
        // estimatedProfit = 0
        // final = 0
        const result = estimateProfit(orderDetails, ethPrice, marketPrice, maxInput);
        expect(result).toBe(0n);
    });

    it("should return negative profit if order ratio > marketPrice", () => {
        const orderDetails = {
            takeOrders: [{ quote: { ratio: 8n * ONE18 } }],
        };
        const ethPrice = 2n * ONE18;
        const marketPrice = 5n * ONE18;
        const maxInput = 1n * ONE18;

        // marketAmountOut = 5
        // orderInput = 8
        // estimatedProfit = -3
        // final = -6
        const result = estimateProfit(orderDetails, ethPrice, marketPrice, maxInput);
        expect(result).toBe(-6n * ONE18);
    });
});
