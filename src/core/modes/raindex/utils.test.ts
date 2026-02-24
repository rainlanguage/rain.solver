import { parseUnits } from "viem";
import { describe, it, expect } from "vitest";
import { calcCounterpartyInputToEthPrice, calcCounterpartyOutputToEthPrice } from "./utils";

describe("Test calcCounterpartyOutputToEthPrice function", () => {
    it("should use provided counterpartyOutputToEthPrice when available", () => {
        const counterpartyInputToEthPrice = parseUnits("2", 18);
        const ratio = parseUnits("1.5", 18);
        const counterpartyOutputToEthPrice = "3.5";

        const result = calcCounterpartyOutputToEthPrice(
            counterpartyInputToEthPrice,
            ratio,
            counterpartyOutputToEthPrice,
        );

        // Should return the provided price
        expect(result).toBe(parseUnits("3.5", 18));
    });

    it("should calculate from ratio when counterpartyOutputToEthPrice is not provided", () => {
        const counterpartyInputToEthPrice = parseUnits("2", 18);
        const ratio = parseUnits("1.5", 18);

        const result = calcCounterpartyOutputToEthPrice(counterpartyInputToEthPrice, ratio);

        // Should calculate: (2e18 * 1.5e18) / 1e18 = 3e18
        expect(result).toBe(parseUnits("3", 18));
    });
});

describe("Test calcCounterpartyInputToEthPrice function", () => {
    it("should return zero when outputToEthPrice is not provided", () => {
        const quote = {
            amountOut: 100n,
            price: parseUnits("2", 18),
        } as any;

        const result = calcCounterpartyInputToEthPrice(quote);

        expect(result).toBe(0n);
    });

    it("should return zero when outputToEthPrice is undefined", () => {
        const quote = {
            amountOut: 100n,
            price: parseUnits("2", 18),
        } as any;

        const result = calcCounterpartyInputToEthPrice(quote, undefined);

        expect(result).toBe(0n);
    });

    it("should calculate input to ETH price with 1:1 quote price", () => {
        const quote = {
            amountOut: 100n,
            price: parseUnits("1", 18),
        } as any;
        const outputToEthPrice = "2.0";

        const result = calcCounterpartyInputToEthPrice(quote, outputToEthPrice);

        // (2e18 * 1e18) / 1e18 = 2e18
        expect(result).toBe(parseUnits("2", 18));
    });

    it("should calculate input to ETH price with high quote price", () => {
        const quote = {
            amountOut: 100n,
            price: parseUnits("2", 18),
        } as any;
        const outputToEthPrice = "4.0";

        const result = calcCounterpartyInputToEthPrice(quote, outputToEthPrice);

        // (4e18 * 1e18) / 2e18 = 2e18
        expect(result).toBe(parseUnits("2", 18));
    });

    it("should calculate input to ETH price with low quote price", () => {
        const quote = {
            amountOut: 100n,
            price: parseUnits("0.5", 18),
        } as any;
        const outputToEthPrice = "1.0";

        const result = calcCounterpartyInputToEthPrice(quote, outputToEthPrice);

        // (1e18 * 1e18) / 0.5e18 = 2e18
        expect(result).toBe(parseUnits("2", 18));
    });

    it("should return zero when quote price is zero", () => {
        const quote = { amountOut: 100n, price: 0n } as any;
        expect(calcCounterpartyInputToEthPrice(quote, "2.0")).toBe(0n);
    });
});
