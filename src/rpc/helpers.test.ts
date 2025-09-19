import { describe, it, assert } from "vitest";
import { normalizeUrl, probablyPicksFrom } from ".";

describe("Test rpc helpers", async function () {
    it("should normalize url", async function () {
        const url1 = "https://example1.com/";
        const result1 = normalizeUrl(url1);
        assert.equal(result1, "https://example1.com/");

        const url2 = "https://example2.com";
        const result2 = normalizeUrl(url2);
        assert.equal(result2, "https://example2.com/");
    });

    it("should test probablyPicksFrom", async function () {
        const selectionRange = [
            6000, // 60% succes rate, equals to 20% of all probabilities
            3000, // 30% succes rate, equals to 10% of all probabilities
            1000, // 10% succes rate, equals to 3.33% of all probabilities
        ];
        const result = {
            first: 0,
            second: 0,
            third: 0,
            outOfRange: 0,
        };

        // run 10000 times to get a accurate distribution of results for test
        for (let i = 0; i < 10000; i++) {
            const rand = probablyPicksFrom(selectionRange);
            if (rand === 0) result.first++;
            else if (rand === 1) result.second++;
            else if (rand === 2) result.third++;
            else result.outOfRange++;
        }

        // convert to percentage
        result.first /= 100;
        result.second /= 100;
        result.third /= 100;
        result.outOfRange /= 100;

        assert.closeTo(result.first, 20, 2);
        assert.closeTo(result.second, 10, 2);
        assert.closeTo(result.third, 3.33, 2);
        assert.closeTo(result.outOfRange, 66.66, 2);
    });
});
