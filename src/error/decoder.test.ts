import axios from "axios";
import { decodeErrorResult, isHex, parseAbiItem } from "viem";
import { PANIC_REASONS, PANIC_SELECTOR, SELECTOR_REGISTRY } from "./types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { tryDecodeError, tryGetSignature, tryDecodePanic, SelectorCache } from "./decoder";

vi.mock("axios");
vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    decodeErrorResult: vi.fn(),
    isHex: vi.fn(),
}));

describe("Test decoder functions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        SelectorCache.clear();
    });

    describe("Test tryDecodeError function", () => {
        it("should return error for invalid hex data", async () => {
            (isHex as any as Mock).mockReturnValue(false);
            const result = await tryDecodeError("invalid-hex");

            assert(result.isErr());
            expect(result.error.message).toBe(
                "invalid data, expected hex string with at least 32 bytes",
            );
            expect(isHex).toHaveBeenCalledWith("invalid-hex", { strict: true });
        });

        it("should decode panic error successfully", async () => {
            (isHex as any as Mock).mockReturnValue(true);
            const panicData = `${PANIC_SELECTOR}0000000000000000000000000000000000000000000000000000000000000001`;
            (decodeErrorResult as Mock).mockReturnValue({
                errorName: "Panic",
                args: [0x01n],
            });

            const result = await tryDecodeError(panicData);

            assert(result.isOk());
            expect(result.value).toEqual({
                name: "Panic",
                args: ["asserted with an argument that evaluates to false"],
            });
        });

        it("should decode custom error with cached signature", async () => {
            (isHex as any as Mock).mockReturnValue(true);
            const customSelector = "0x12345678";
            const errorData = `${customSelector}1234567890abcdef`;
            const cachedSignatures = ["CustomError(string message)"];
            // Pre-populate cache
            SelectorCache.set(customSelector, cachedSignatures);
            (decodeErrorResult as Mock).mockReturnValue({
                errorName: "CustomError",
                args: ["Test error message"],
            });

            const result = await tryDecodeError(errorData);

            assert(result.isOk());
            expect(result.value).toEqual({
                name: "CustomError",
                args: ["Test error message"],
            });
            expect(decodeErrorResult).toHaveBeenCalledWith({
                abi: [parseAbiItem("error " + cachedSignatures[0])],
                data: errorData,
            });
        });

        it("should fetch signature from registry when not cached", async () => {
            (isHex as any as Mock).mockReturnValue(true);
            const customSelector = "0x87654321";
            const errorData = `${customSelector}abcdef1234567890`;
            const registrySignatures = [
                { name: "TestError(uint256 value)" },
                { name: "TestError(string reason)" },
            ];
            (axios.get as Mock).mockResolvedValue({
                data: {
                    result: {
                        function: {
                            [customSelector]: registrySignatures,
                        },
                    },
                },
            });
            (decodeErrorResult as Mock)
                .mockImplementationOnce(() => {
                    throw new Error("First signature failed");
                })
                .mockReturnValueOnce({
                    errorName: "TestError",
                    args: ["Decode successful"],
                });

            const result = await tryDecodeError(errorData);

            assert(result.isOk());
            expect(result.value).toEqual({
                name: "TestError",
                args: ["Decode successful"],
            });
            expect(axios.get).toHaveBeenCalledWith(SELECTOR_REGISTRY, {
                params: {
                    function: customSelector,
                    filter: true,
                },
                headers: {
                    accept: "application/json",
                },
            });
            expect(SelectorCache.get(customSelector)).toEqual([
                "TestError(uint256 value)",
                "TestError(string reason)",
            ]);
        });

        it("should return error when signature fetch fails", async () => {
            (isHex as any as Mock).mockReturnValue(true);
            const customSelector = "0x99999999";
            const errorData = `${customSelector}1111111111111111`;
            (axios.get as Mock).mockRejectedValue(new Error("Registry unavailable"));

            const result = await tryDecodeError(errorData);

            assert(result.isErr());
            expect(result.error.message).toBe("Registry unavailable");
        });

        it("should return error when no signatures match", async () => {
            (isHex as any as Mock).mockReturnValue(true);

            const customSelector = "0x11111111";
            const errorData = `${customSelector}2222222222222222`;
            const registrySignatures = [{ name: "UnmatchedError(uint256 value)" }];
            (axios.get as Mock).mockResolvedValue({
                data: {
                    result: {
                        function: {
                            [customSelector]: registrySignatures,
                        },
                    },
                },
            });
            (decodeErrorResult as Mock).mockImplementation(() => {
                throw new Error("Decode failed");
            });

            const result = await tryDecodeError(errorData);

            assert(result.isErr());
            expect(result.error.message).toBe(
                "Failed to decode the error as none of the known signatures matched with the error",
            );
        });
    });

    describe("Test tryGetSignature function", () => {
        it("should return cached signature when available", async () => {
            const selector = "0x12345678";
            const cachedSigs = ["CachedError(uint256 value)"];
            SelectorCache.set(selector, cachedSigs);
            const result = await tryGetSignature(selector);
            assert(result.isOk());
            expect(result.value).toEqual(cachedSigs);
            expect(axios.get).not.toHaveBeenCalled();
        });

        it("should fetch from registry when not cached", async () => {
            const selector = "0x87654321";
            const registryResponse = [
                { name: "RegistryError(string reason)" },
                { name: "RegistryError(uint256 code)" },
            ];
            (axios.get as Mock).mockResolvedValue({
                data: {
                    result: {
                        function: {
                            [selector]: registryResponse,
                        },
                    },
                },
            });

            const result = await tryGetSignature(selector);

            assert(result.isOk());
            expect(result.value).toEqual([
                "RegistryError(string reason)",
                "RegistryError(uint256 code)",
            ]);
            expect(SelectorCache.get(selector)).toEqual([
                "RegistryError(string reason)",
                "RegistryError(uint256 code)",
            ]);
            expect(axios.get).toHaveBeenCalledWith(SELECTOR_REGISTRY, {
                params: {
                    function: selector,
                    filter: true,
                },
                headers: {
                    accept: "application/json",
                },
            });
        });

        it("should throw assertion error for invalid selector format", async () => {
            const invalidSelector = "0x123"; // too short
            await expect(tryGetSignature(invalidSelector)).rejects.toThrow();
        });

        it("should return error when registry request fails", async () => {
            const selector = "0x99999999";
            const networkError = new Error("Network timeout");
            (axios.get as Mock).mockRejectedValue(networkError);
            const result = await tryGetSignature(selector);
            assert(result.isErr());
            expect(result.error).toBe(networkError);
        });

        it("should return error when registry response is invalid", async () => {
            const selector = "0x11111111";
            (axios.get as Mock).mockResolvedValue({
                data: {
                    result: {
                        function: {
                            // Missing the selector key
                        },
                    },
                },
            });
            const result = await tryGetSignature(selector);
            assert(result.isErr());
            expect(result.error.message).toContain(
                "Response from registry contains no valid results",
            );
        });

        it("should return error when registry response is empty", async () => {
            const selector = "0x22222222";
            (axios.get as Mock).mockResolvedValue({
                data: {
                    result: {
                        function: {
                            [selector]: [], // empty array
                        },
                    },
                },
            });
            const result = await tryGetSignature(selector);
            assert(result.isErr());
            expect(result.error.message).toContain("Response from registry contains empty results");
        });

        it("should handle malformed registry response structure", async () => {
            const selector = "0x33333333";
            (axios.get as Mock).mockResolvedValue({
                data: {
                    // Missing result.function structure
                    invalid: "response",
                },
            });
            const result = await tryGetSignature(selector);
            assert(result.isErr());
        });
    });

    describe("Test tryDecodePanic function", () => {
        it("should decode panic with known reason codes", () => {
            const testCases = Object.entries(PANIC_REASONS).map(([code, reason]) => ({
                code,
                reason,
            }));

            testCases.forEach(({ code, reason }) => {
                (decodeErrorResult as Mock).mockReturnValue({
                    errorName: "Panic",
                    args: [code],
                });
                const result = tryDecodePanic("0x");

                assert(result.isOk());
                expect(result.value).toEqual({
                    name: "Panic",
                    args: [reason],
                });
            });
        });

        it("should handle unknown panic codes", () => {
            const unknownCode = 0x99n;
            (decodeErrorResult as Mock).mockReturnValue({
                errorName: "Panic",
                args: [unknownCode],
            });
            const result = tryDecodePanic("0x");
            assert(result.isOk());
            expect(result.value).toEqual({
                name: "Panic",
                args: ["unknown reason with code: 0x99"],
            });
        });

        it("should return error when decoding fails", () => {
            const decodeError = new Error("Invalid panic data");
            (decodeErrorResult as Mock).mockImplementation(() => {
                throw decodeError;
            });
            const result = tryDecodePanic("0x4e487b71invalid");
            assert(result.isErr());
            expect(result.error).toBe(decodeError);
        });
    });
});
