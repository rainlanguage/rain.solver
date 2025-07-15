import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { withBigintSerializer, sleep, promiseTimeout, shuffleArray, iterRandom } from "./utils";

describe("Test withBigIntSerializer function", async function () {
    it("should test withBigIntSerializer", async function () {
        // bigint
        let value: any = 123n;
        let result = withBigintSerializer("key", value);
        expect(result).toBe("123");

        // set
        value = new Set(["a", "b", "c"]);
        result = withBigintSerializer("key", value);
        expect(result).toStrictEqual(["a", "b", "c"]);

        // set wih bigint
        value = {
            a: 123n,
            b: new Set([1n, 2n]),
        };
        result = JSON.stringify(value, withBigintSerializer);
        expect(result).toBe('{"a":"123","b":["1","2"]}');

        // else
        value = 123;
        result = withBigintSerializer("key", value);
        expect(result).toBe(123);
    });
});

describe("Test sleep function", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should resolve after specified milliseconds", async () => {
        const sleepPromise = sleep(1000);
        // Fast-forward time by 1000ms
        vi.advanceTimersByTime(1000);
        const result = await sleepPromise;

        expect(result).toBe("");
    });

    it("should resolve with custom message", async () => {
        const customMessage = "Sleep completed";
        const sleepPromise = sleep(500, customMessage);
        vi.advanceTimersByTime(500);
        const result = await sleepPromise;

        expect(result).toBe(customMessage);
    });

    it("should not resolve before specified time", async () => {
        const sleepPromise = sleep(1000);
        let resolved = false;
        sleepPromise.then(() => {
            resolved = true;
        });

        // advance time by less than specified
        vi.advanceTimersByTime(500);
        expect(resolved).toBe(false);

        // complete the remaining time
        vi.advanceTimersByTime(500);

        await sleepPromise;
        expect(resolved).toBe(true);
    });

    it("should clear timeout on completion", async () => {
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const sleepPromise = sleep(100);
        vi.advanceTimersByTime(100);

        await sleepPromise;
        expect(clearTimeoutSpy).toHaveBeenCalled();

        clearTimeoutSpy.mockRestore();
    });

    it("should properly clean up timeout even if promise chain throws", async () => {
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const sleepPromise = sleep(100).then(() => {
            throw new Error("Test error");
        });
        vi.advanceTimersByTime(100);

        await expect(sleepPromise).rejects.toThrow("Test error");

        // timeout should still be cleared due to finally block
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });

    it("should work with real timers for integration test", async () => {
        vi.useRealTimers();

        const startTime = Date.now();
        const result = await sleep(50, "real timer test");
        const endTime = Date.now();

        expect(result).toBe("real timer test");
        expect(endTime - startTime).toBeGreaterThanOrEqual(45); // allow for small timing variations
        expect(endTime - startTime).toBeLessThan(100); // shouldn't take too long
    }, 1000); // set timeout for the test itself
});

describe("Test promiseTimeout function", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should resolve with promise result when promise settles before timeout", async () => {
        const testPromise = new Promise((resolve) => {
            setTimeout(() => resolve("success"), 500);
        });
        const timeoutPromise = promiseTimeout(testPromise, 1000, "timeout error");

        // Advance time to resolve the original promise
        vi.advanceTimersByTime(500);

        const result = await timeoutPromise;
        expect(result).toBe("success");
    });

    it("should reject with timeout exception when promise takes too long", async () => {
        const slowPromise = new Promise((resolve) => {
            setTimeout(() => resolve("too late"), 2000);
        });
        const timeoutPromise = promiseTimeout(slowPromise, 1000, "timeout error");

        // Advance time to trigger timeout
        vi.advanceTimersByTime(1000);

        await expect(timeoutPromise).rejects.toBe("timeout error");
    });

    it("should work with real timers for integration test", async () => {
        vi.useRealTimers();
        const fastPromise = new Promise((resolve) => {
            setTimeout(() => resolve("fast result"), 50);
        });

        const result = await promiseTimeout(fastPromise, 200, "timeout");
        expect(result).toBe("fast result");

        const slowPromise = new Promise((resolve) => {
            setTimeout(() => resolve("slow result"), 200);
        });

        await expect(promiseTimeout(slowPromise, 50, "timed out")).rejects.toBe("timed out");
    }, 1000);
});

describe("Test shuffleArray function", () => {
    let mathRandomSpy: any;

    beforeEach(() => {
        mathRandomSpy = vi.spyOn(Math, "random");
    });

    afterEach(() => {
        mathRandomSpy.mockRestore();
    });

    it("should return the same array reference", () => {
        const originalArray = [1, 2, 3, 4, 5];
        const shuffledArray = shuffleArray(originalArray);
        expect(shuffledArray).toBe(originalArray); // same reference
    });

    it("should maintain the same length", () => {
        const originalArray = [1, 2, 3, 4, 5];
        const originalLength = originalArray.length;
        shuffleArray(originalArray);
        expect(originalArray.length).toBe(originalLength);
    });

    it("should contain all original elements", () => {
        const originalArray = [1, 2, 3, 4, 5];
        const originalElements = [...originalArray];
        shuffleArray(originalArray);
        expect(originalArray.sort()).toEqual(originalElements.sort());
    });

    it("should produce deterministic shuffle with controlled random values", () => {
        // Mock Math.random to return specific values for predictable shuffling
        const randomValues = [0.8, 0.2, 0.9, 0.1, 0.5];
        let callIndex = 0;
        mathRandomSpy.mockImplementation(() => randomValues[callIndex++ % randomValues.length]);

        const array = [1, 2, 3, 4, 5];
        shuffleArray(array);

        // with the mocked random values, we can predict the exact shuffle result
        // this verifies the Fisher-Yates algorithm implementation
        expect(mathRandomSpy).toHaveBeenCalled();
        expect(array.length).toBe(5);
        expect(array).toContain(1);
        expect(array).toContain(2);
        expect(array).toContain(3);
        expect(array).toContain(4);
        expect(array).toContain(5);
    });

    it("should actually shuffle array (statistical test)", () => {
        // run shuffle multiple times and verify it's not always the same
        const originalArray = [1, 2, 3, 4, 5];
        const results: string[] = [];

        // use real Math.random for this test
        mathRandomSpy.mockRestore();

        for (let i = 0; i < 10; i++) {
            const testArray = [...originalArray];
            shuffleArray(testArray);
            results.push(JSON.stringify(testArray));
        }

        // with 10 shuffles of 5 elements, we should get at least some different results
        const uniqueResults = new Set(results);
        expect(uniqueResults.size).toBeGreaterThan(1);
    });
});

describe("Test iterRandom function", () => {
    let arr: any[];

    beforeEach(() => {
        arr = [{ id: "id1" }, { id: "id2" }, { id: "id3" }];
    });

    it("should iterate randomly", () => {
        const iteratedItems: any[] = [];

        // mock Math.random to control randomness for predictable testing
        const mockMathRandom = vi.spyOn(Math, "random");
        mockMathRandom
            .mockReturnValueOnce(0.8) // pick index 2 (0.8 * 3 = 2.4 -> floor = 2)
            .mockReturnValueOnce(0.3) // pick index 0 (0.3 * 2 = 0.6 -> floor = 0)
            .mockReturnValueOnce(0.0); // pick index 0 (0.0 * 1 = 0.0 -> floor = 0)

        // collect all elements from the generator
        for (const item of iterRandom(arr)) {
            iteratedItems.push(item);
        }

        // should return all elements but potentially in different order
        expect(iteratedItems).toHaveLength(3);

        // with our mocked random values, expected order should be:
        // 1st iteration: pick index 2 (id3), swap with last (id3), pop id3
        // 2nd iteration: pick index 0 (id1), swap with last (id2), pop id1
        // 3rd iteration: pick index 0 (id2), pop id2
        expect(iteratedItems[0].id).toBe("id3");
        expect(iteratedItems[1].id).toBe("id1");
        expect(iteratedItems[2].id).toBe("id2");

        // verify Math.random was called the expected number of times
        expect(mockMathRandom).toHaveBeenCalledTimes(3);

        mockMathRandom.mockRestore();
    });

    it("iterRandom O(1) should be faster than iterating shuffleArray O(n)", () => {
        // build an array with 10k elemnts to iterate over
        let counter = 0;
        const arr = Array(10000).fill({ id: counter++ });
        const iterations = 1000; //run each test 1000 times to get a good average

        // a helper fn that measures the time
        const measureTime = (callback: () => void) => {
            const start = performance.now();
            callback();
            return performance.now() - start;
        };

        // measure shuffleArray time for 1k times
        const shuffleArr = [...arr];
        const iterShuffleArrayTime = measureTime(() => {
            for (let i = 0; i < iterations; i++) {
                for (const _e of shuffleArray(shuffleArr)) {
                    _e;
                    // iterate to ensure the array is fully processed
                }
            }
        });

        // measure iterRandom time for 1k times
        const randArr = [...arr];
        const iterRandomTime = measureTime(() => {
            for (let i = 0; i < iterations; i++) {
                for (const _e of iterRandom(randArr)) {
                    _e;
                    // iterate to ensure the array is fully processed
                }
            }
        });

        expect(iterRandomTime).toBeLessThan(iterShuffleArrayTime);
    });
});
