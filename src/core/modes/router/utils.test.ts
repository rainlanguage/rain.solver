import { ONE18 } from "../../../math";
import { estimateProfit } from "./utils";
import { describe, it, expect } from "vitest";

describe("Test estimateProfit", () => {
    it("should estimate profit correctly for typical values", () => {
        const orderDetails = {
            takeOrder: { quote: { ratio: 2n * ONE18 } }, // ratio = 2.0
        } as any;
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
            takeOrder: { quote: { ratio: 5n * ONE18 } },
        } as any;
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
            takeOrder: { quote: { ratio: 8n * ONE18 } },
        } as any;
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
