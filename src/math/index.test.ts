import { scaleTo18, scaleFrom18 } from ".";
import { describe, it, assert } from "vitest";

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
});
