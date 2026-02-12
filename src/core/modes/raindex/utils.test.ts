import { parseUnits } from "viem";
import { describe, it, expect } from "vitest";
import {
    calcCounterpartyInputProfit,
    calcCounterpartyInputToEthPrice,
    calcCounterpartyOutputToEthPrice,
} from "./utils";

describe("Test calcCounterpartyInputProfit function", () => {
    it("should return zero input profit when sushi output equals counterparty max input", () => {
        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("2", 18),
                },
            },
        } as any;

        const quote = {
            amountOut: parseUnits("200", 18),
            price: parseUnits("1", 18),
        } as any;

        const result = calcCounterpartyInputProfit(counterparty, quote);

        // maxSushiOutput: 200e18
        // counterpartyMaxInputFixed: 100e18 * 2e18 / 1e18 = 200e18
        // counterpartyInputProfit: 0 (equal)
        // counterpartyMaxOutput: 100e18 (full capacity)
        expect(result.counterpartyInputProfit).toBe(0n);
        expect(result.counterpartyMaxOutput).toBe(parseUnits("100", 18));
    });

    it("should calculate positive input profit when sushi output exceeds counterparty max input", () => {
        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("2", 18),
                },
            },
        } as any;

        const quote = {
            amountOut: parseUnits("250", 18),
            price: parseUnits("1", 18),
        } as any;

        const result = calcCounterpartyInputProfit(counterparty, quote);

        // maxSushiOutput: 250e18
        // counterpartyMaxInputFixed: 100e18 * 2e18 / 1e18 = 200e18
        // counterpartyInputProfit: 250e18 - 200e18 = 50e18
        // counterpartyMaxOutput: 100e18 (at full capacity)
        expect(result.counterpartyInputProfit).toBe(parseUnits("50", 18));
        expect(result.counterpartyMaxOutput).toBe(parseUnits("100", 18));
    });

    it("should return zero input profit when sushi output is less than counterparty max input", () => {
        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("2", 18),
                },
            },
        } as any;

        const quote = {
            amountOut: parseUnits("150", 18),
            price: parseUnits("1", 18),
        } as any;

        const result = calcCounterpartyInputProfit(counterparty, quote);

        // maxSushiOutput: 150e18
        // counterpartyMaxInputFixed: 100e18 * 2e18 / 1e18 = 200e18
        // counterpartyInputProfit: 0 (less than max)
        // counterpatryMaxInput: 150e18
        // counterpartyMaxOutput: 150e18 * 1e18 / 2e18 = 75e18
        expect(result.counterpartyInputProfit).toBe(0n);
        expect(result.counterpartyMaxOutput).toBe(parseUnits("75", 18));
    });

    it("should handle counterparty ratio of zero", () => {
        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: 0n,
                },
            },
        } as any;

        const quote = {
            amountOut: parseUnits("50", 18),
            price: parseUnits("1", 18),
        } as any;

        const result = calcCounterpartyInputProfit(counterparty, quote);

        // maxSushiOutput: 50e18
        // counterpartyMaxInputFixed: 100e18 * 0 / 1e18 = 0
        // counterpartyInputProfit: 50e18 - 0 = 50e18
        // ratio is 0, so counterpartyMaxOutput uses original maxOutput
        expect(result.counterpartyInputProfit).toBe(parseUnits("50", 18));
        expect(result.counterpartyMaxOutput).toBe(parseUnits("100", 18));
    });

    it("should calculate counterparty max output when not at full capacity", () => {
        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("200", 18),
                    ratio: parseUnits("2", 18),
                },
            },
        } as any;

        const quote = {
            amountOut: parseUnits("300", 18),
            price: parseUnits("1", 18),
        } as any;

        const result = calcCounterpartyInputProfit(counterparty, quote);

        // maxSushiOutput: 300e18
        // counterpartyMaxInputFixed: 200e18 * 2e18 / 1e18 = 400e18
        // counterpartyInputProfit: 0 (300 < 400)
        // counterpatryMaxInput: 300e18
        // counterpartyMaxOutput: 300e18 * 1e18 / 2e18 = 150e18
        expect(result.counterpartyInputProfit).toBe(0n);
        expect(result.counterpartyMaxOutput).toBe(parseUnits("150", 18));
    });
});

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
});
