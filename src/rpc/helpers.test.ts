import { describe, it, assert, expect, vi } from "vitest";
import { getRpcError, normalizeUrl, probablyPicksFrom, shouldThrow } from "./helpers";
import {
    BaseError,
    ExecutionRevertedError,
    UserRejectedRequestError,
    TransactionRejectedRpcError,
} from "viem";

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
            6000, // 60% succes rate, equals to 20% of all probabilities adjusted with weights
            3000, // 30% succes rate, equals to 10% of all probabilities adjusted with weights
            1000, // 10% succes rate, equals to 4% of all probabilities adjusted with weights
        ];
        const weights = [1, 1, 0.5]; // weights to adjust the probability of each item being picked
        const result = {
            first: 0,
            second: 0,
            third: 0,
            outOfRange: 0,
        };

        // run 10000 times to get a accurate distribution of results for test
        for (let i = 0; i < 10000; i++) {
            const rand = probablyPicksFrom(selectionRange, weights);
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

        assert.closeTo(result.first, 24, 2); // has been picked close to 24% of times (60% adjusted with weight of 1)
        assert.closeTo(result.second, 12, 2); // has been picked close to 12% of times (30% adjusted with weight of 1)
        assert.closeTo(result.third, 4, 2); // has been picked close to 4% of times (10% adjusted with weight of 0.5)
        assert.closeTo(result.outOfRange, 60, 2); // has been picked close to 60% of times (out of range)
    });

    it("should always land in proportion to the ranges when asked to", async function () {
        const ranges = [6000, 3000, 1000];
        const weights = [1, 1, 0.5]; // play no part in a draw that always lands
        const counts = [0, 0, 0];
        for (let i = 0; i < 10000; i++) {
            const picked = probablyPicksFrom(ranges, weights, true);
            expect(Number.isNaN(picked)).toBe(false);
            counts[picked]++;
        }
        assert.closeTo(counts[0] / 100, 60, 2);
        assert.closeTo(counts[1] / 100, 30, 2);
        assert.closeTo(counts[2] / 100, 10, 2);

        // the floor rates alone still land, every time
        for (let i = 0; i < 1000; i++) {
            expect([0, 1]).toContain(probablyPicksFrom([10, 10], [1, 1], true));
        }

        // a zero range is never picked, and nothing to land on is a miss
        for (let i = 0; i < 1000; i++) {
            expect(probablyPicksFrom([0, 5000], [1, 1], true)).toBe(1);
        }
        expect(Number.isNaN(probablyPicksFrom([0, 0], [1, 1], true))).toBe(true);
    });

    it("should match the draw against the ranges alone when asked to always land", async function () {
        const ranges = [6000, 3000, 1000];
        const weights = [1, 1, 0.5];
        const randomSpy = vi.spyOn(Math, "random");

        // a 10000 wide draw, the slots are [1, 6000], [6001, 9000] and [9001, 10000]
        const cases: [number, number][] = [
            [0, 0],
            [0.59995, 0],
            [0.60005, 1],
            [0.89995, 1],
            [0.90005, 2],
            [0.99999, 2],
        ];
        for (const [random, expected] of cases) {
            randomSpy.mockReturnValueOnce(random);
            expect(probablyPicksFrom(ranges, weights, true)).toBe(expected);
        }

        // the same draw misses when the weights reserve room, the default
        randomSpy.mockReturnValueOnce(0.60005);
        expect(Number.isNaN(probablyPicksFrom(ranges, weights, false))).toBe(true);
        randomSpy.mockReturnValueOnce(0.60005);
        expect(Number.isNaN(probablyPicksFrom(ranges, weights))).toBe(true);

        randomSpy.mockRestore();
    });

    describe("Test getRpcError", () => {
        it("should extract RPC error from nested cause", () => {
            const mockError = new Error("Outer error") as any;
            mockError.cause = {
                code: -32000,
                message: "execution reverted",
                data: "0x08c379a0",
            };
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32000,
                message: "execution reverted",
                data: "0x08c379a0",
            });
        });

        it("should extract RPC error from direct properties", () => {
            const mockError = {
                code: -32603,
                message: "Internal error",
                data: "0x12345678",
            } as any;
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32603,
                message: "Internal error",
                data: "0x12345678",
            });
        });

        it("should handle deeply nested causes", () => {
            const mockError = new Error("Level 1") as any;
            mockError.cause = {
                cause: {
                    cause: {
                        code: -32000,
                        message: "Deep nested error",
                        data: "0xdeep",
                    },
                },
            };
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32000,
                message: "Deep nested error",
                data: "0xdeep",
            });
        });

        it("should handle breaker limit to prevent infinite recursion", () => {
            const mockError = new Error("Recursive error") as any;
            mockError.cause = mockError; // circular reference
            const result = getRpcError(mockError);
            expect(result.message).toBe("Found no rpc error in the given viem error");
        });
    });

    describe("Test shouldThrow", () => {
        it("should return true for execution reverted message", () => {
            const mockError = new BaseError("Transaction execution reverted") as any;
            mockError.name = "ExecutionError";
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for unknown reason message", () => {
            const mockError = new BaseError("Transaction failed for unknown reason") as any;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true when RPC error has data", () => {
            const mockError = new Error("Test error") as any;
            mockError.cause = {
                data: "0x08c379a0",
            };
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for ExecutionRevertedError instance", () => {
            const mockError = new ExecutionRevertedError({
                cause: new BaseError("Execution reverted"),
            });
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for UserRejectedRequestError code", () => {
            const mockError = new Error("User rejected") as any;
            mockError.code = UserRejectedRequestError.code;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for TransactionRejectedRpcError code", () => {
            const mockError = new Error("Transaction rejected") as any;
            mockError.code = TransactionRejectedRpcError.code;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for UserRejectedRequestError code (5000)", () => {
            const mockError = new Error("User rejected CAIP") as any;
            mockError.code = 5000;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return false for generic network errors", () => {
            const mockError = new Error("Network timeout");
            const result = shouldThrow(mockError);
            expect(result).toBe(false);
        });

        it("should check error details and shortMessage", () => {
            const mockError = new Error("Test error") as any;
            mockError.details = "execution reverted: insufficient balance";
            mockError.shortMessage = "Call failed";
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should handle missing properties gracefully", () => {
            const mockError = new Error("Test error") as any;
            // Intentionally not setting name, details, shortMessage
            const result = shouldThrow(mockError);
            expect(result).toBe(false);
        });

        it("should check nested cause for execution reverted", () => {
            const mockError = new BaseError("Outer error") as any;
            mockError.cause = {
                code: 1,
                message: "inner execution reverted",
            };
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });
    });
});
