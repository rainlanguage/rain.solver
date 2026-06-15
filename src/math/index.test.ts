import { describe, it, assert } from "vitest";
import { scaleTo18, scaleFrom18, calculatePrice18, toNumber, isBigNumberish, ONE18 } from ".";
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

    it("should convert a bigint to its 18-decimal float number", async function () {
        // exactly one ether -> 1 (pins the 18-decimals divisor: any other decimals shifts the value)
        assert.strictEqual(toNumber(ONE18), 1);

        // fractional value -> retains the fractional part (rules out integer-only truncation)
        assert.strictEqual(toNumber(1_500_000_000_000_000_000n), 1.5);

        // larger whole multiple of one ether (pins exact scaling, not just "non-zero")
        assert.strictEqual(toNumber(123n * ONE18), 123);

        // zero maps to zero
        assert.strictEqual(toNumber(0n), 0);
    });

    describe("Test isBigNumberish", () => {
        it("should accept integer numbers but reject non-integer numbers", async function () {
            // integer number -> true (kills `value % 1 === 0` -> `!== 0`)
            assert.strictEqual(isBigNumberish(5), true);
            assert.strictEqual(isBigNumberish(0), true);
            // non-integer number -> false (kills relaxing the modulo check / dropping it)
            assert.strictEqual(isBigNumberish(5.5), false);
            assert.strictEqual(isBigNumberish(0.1), false);
        });

        it("should accept all-digit strings (optionally signed) but reject other strings", async function () {
            // all-digit string -> true (kills regex branch removal)
            assert.strictEqual(isBigNumberish("123"), true);
            // leading-minus all-digit string -> true (pins the `-?` regex prefix)
            assert.strictEqual(isBigNumberish("-123"), true);
            // decimal string -> false (kills an over-broad regex that would allow a dot)
            assert.strictEqual(isBigNumberish("12.3"), false);
            // non-numeric string -> false
            assert.strictEqual(isBigNumberish("abc"), false);
            // empty string -> false (no digits to match)
            assert.strictEqual(isBigNumberish(""), false);
        });

        it("should accept hex strings via the isHex branch", async function () {
            // hex string with letters -> only the isHex branch can accept it
            // (the digit regex rejects the `x` and letters, it is not a bigint/bytes)
            assert.strictEqual(isBigNumberish("0xabcdef"), true);
        });

        it("should accept bigint and byte-array values", async function () {
            // bigint -> true (kills `typeof value === "bigint"` branch removal)
            assert.strictEqual(isBigNumberish(7n), true);
            // byte array -> true (kills isBytes branch removal)
            assert.strictEqual(isBigNumberish(new Uint8Array([1, 2, 3])), true);
        });

        it("should reject nullish and non-numberish values", async function () {
            // null/undefined -> false (kills the `value != null` guard -> `== null`)
            assert.strictEqual(isBigNumberish(null), false);
            assert.strictEqual(isBigNumberish(undefined), false);
            // plain object -> false (none of the branches match)
            assert.strictEqual(isBigNumberish({}), false);
        });
    });
});
