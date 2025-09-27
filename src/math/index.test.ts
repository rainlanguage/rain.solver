import { describe, it, assert } from "vitest";
import { scaleTo18, scaleFrom18, calculatePrice18, ONE18 } from ".";
import { maxUint256 } from "viem";

describe("Test math functions", () => {
    it("should test scale to 18", async function () {
        // down
        const value1 = 123456789n;
        const decimals1 = 3;
        const result1 = scaleTo18(value1, decimals1);
        const expected1 = 123456789000000000000000n;
        assert.deepEqual(result1, expected1);

        // up
        const value2 = 123456789n;
        const decimals2 = 23;
        const result2 = scaleTo18(value2, decimals2);
        const expected2 = 1234n;
        assert.deepEqual(result2, expected2);
    });

    it("should test scale from 18", async function () {
        // down
        const value1 = 123456789n;
        const decimals1 = 12;
        const result1 = scaleFrom18(value1, decimals1);
        const expected1 = 123n;
        assert.deepEqual(result1, expected1);

        // up
        const value2 = 123456789n;
        const decimals2 = 23;
        const result2 = scaleFrom18(value2, decimals2);
        const expected2 = 12345678900000n;
        assert.deepEqual(result2, expected2);
    });

    it("should calculate price in 18 decimal fixed point for same decimals", async function () {
        // Test case: 1 WETH (18 decimals) = 3000 USDC (6 decimals)
        const amountIn = 1000000000000000000n; // 1 WETH (1e18)
        const amountOut = 3000000000n; // 3000 USDC (3000 * 1e6)
        const decimalsIn = 18;
        const decimalsOut = 6;

        const price = calculatePrice18(amountIn, amountOut, decimalsIn, decimalsOut);

        // Expected: 3000 * 1e18 (3000 in 18 decimal fixed point)
        const expected = 3000n * ONE18;
        assert.deepEqual(price, expected);
    });

    it("should calculate price in 18 decimal fixed point for different decimals and handle edge cases", async function () {
        // Test case: 0.5 WBTC (8 decimals) = 25000 USDC (6 decimals)
        const amountIn = 50000000n; // 0.5 WBTC (0.5 * 1e8)
        const amountOut = 25000000000n; // 25000 USDC (25000 * 1e6)
        const decimalsIn = 8;
        const decimalsOut = 6;

        const price = calculatePrice18(amountIn, amountOut, decimalsIn, decimalsOut);

        // Expected: 50000 * 1e18 (50000 USDC per WBTC in 18 decimal fixed point)
        const expected = 50000n * ONE18;
        assert.deepEqual(price, expected);

        // Edge case: zero input amount should return maxUint256
        const priceZeroInput = calculatePrice18(0n, amountOut, decimalsIn, decimalsOut);
        assert.deepEqual(priceZeroInput, maxUint256);

        // Edge case: very small amounts
        const smallAmountIn = 1n; // smallest possible amount
        const smallAmountOut = 1n; // smallest possible amount
        const priceSmall = calculatePrice18(smallAmountIn, smallAmountOut, 18, 18);

        // Expected: 1 * 1e18 / 1 = 1e18 (price of 1 in 18 decimal fixed point)
        assert.deepEqual(priceSmall, ONE18);
    });
});
