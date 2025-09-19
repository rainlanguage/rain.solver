import { BaseError } from "viem";
import { AxiosError } from "axios";
import { RainSolverBaseError } from "./types";
import { evaluateGasSufficiency, parseRevertError } from "./revert";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { errorSnapshot, containsNodeError, isTimeout } from "./common";
import {
    TimeoutError,
    FeeCapTooLowError,
    ExecutionRevertedError,
    InsufficientFundsError,
    TransactionNotFoundError,
    TransactionReceiptNotFoundError,
    WaitForTransactionReceiptTimeoutError,
} from "viem";

vi.mock("./revert", () => ({
    parseRevertError: vi.fn(),
    evaluateGasSufficiency: vi.fn(),
}));

describe("Test common error utilities", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("Test errorSnapshot", () => {
        it("should create snapshot from RainSolverError with cause", async () => {
            const cause = new Error("Cause of the error");
            const err = new RainSolverBaseError("Test msg", cause);
            const result = await errorSnapshot("String Error", err);

            expect(result).toContain("String Error");
            expect(result).toContain("Test msg");
            expect(result).toContain("Reason: Cause of the error");
        });

        it("should create snapshot from RainSolverError without cause", async () => {
            const err = new RainSolverBaseError("Test msg");
            const result = await errorSnapshot("String Error", err);

            expect(result).toContain("String Error");
            expect(result).toContain("Reason: Test msg");
        });

        it("should create snapshot from BaseError with decoded revert", async () => {
            const mockError = new BaseError("Test error", {
                cause: {
                    code: -32000,
                    message: "execution reverted",
                    data: "0x08c379a0",
                } as any,
            });
            mockError.shortMessage = "Transaction reverted";
            mockError.details = "Contract call failed";

            (parseRevertError as Mock).mockResolvedValue({
                raw: { data: "0x08c379a0" },
                decoded: {
                    name: "Error",
                    args: ["Insufficient balance"],
                },
            });

            const result = await errorSnapshot("Test Header", mockError);

            expect(result).toContain("Test Header");
            expect(result).toContain("Reason: Transaction reverted");
            expect(result).toContain("Error: BaseError");
            expect(result).toContain("Details: Contract call failed");
            expect(result).toContain("RPC Error Code: -32000");
            expect(result).toContain("RPC Error Msg: execution reverted");
            expect(result).toContain("Error Name: Error");
            expect(result).toContain('Error Args: ["Insufficient balance"]');
            expect(parseRevertError).toHaveBeenCalledWith(mockError);
        });

        it("should create snapshot from BaseError with raw data only", async () => {
            const mockError = new BaseError("Test error", {
                cause: {
                    code: -32000,
                    message: "unknown reason",
                    data: "0x12345678",
                } as any,
            });

            (parseRevertError as Mock).mockResolvedValue({
                raw: { data: "0x12345678" },
                decoded: undefined,
            });

            const result = await errorSnapshot("Test Header", mockError);

            expect(result).toContain("Test Header");
            expect(result).toContain("RPC Error Code: -32000");
            expect(result).toContain("RPC Error Msg: unknown reason");
            expect(result).toContain("Error Raw Data: 0x12345678");
            expect(parseRevertError).toHaveBeenCalledWith(mockError);
        });

        it("should create snapshot with gas error when context provided and no decoded data", async () => {
            const mockError = new BaseError("Test error", {
                cause: {
                    message: "execution reverted",
                } as any,
            });

            const mockContext = {
                receipt: { gasUsed: 100000n } as any,
                rawtx: { gasLimit: 200000n } as any,
                signerBalance: 1000000000000000000n,
            };

            (parseRevertError as Mock).mockResolvedValue({
                raw: {},
                decoded: undefined,
            });
            (evaluateGasSufficiency as Mock).mockReturnValue("Insufficient gas for transaction");

            const result = await errorSnapshot("Test Header", mockError, mockContext);

            expect(result).toContain("Test Header");
            expect(result).toContain("Gas Error: Insufficient gas for transaction");
            expect(evaluateGasSufficiency).toHaveBeenCalledWith(
                mockContext.receipt,
                mockContext.rawtx,
                mockContext.signerBalance,
            );
        });

        it("should create snapshot with frontrun info when provided", async () => {
            const mockError = new BaseError("Test error", {
                cause: {
                    message: "execution reverted",
                } as any,
            });

            const mockContext = {
                receipt: { gasUsed: 100000n } as any,
                rawtx: { gasLimit: 200000n } as any,
                signerBalance: 1000000000000000000n,
                frontrun: "Transaction was frontrun by 0x123...",
            };

            (parseRevertError as Mock).mockResolvedValue({
                raw: {},
                decoded: undefined,
            });
            (evaluateGasSufficiency as Mock).mockReturnValue(undefined);

            const result = await errorSnapshot("Test Header", mockError, mockContext);

            expect(result).toContain("Test Header");
            expect(result).toContain("Actual Cause: Transaction was frontrun by 0x123...");
        });

        it("should create snapshot from AxiosError", async () => {
            const mockError = new AxiosError("Request failed", "ECONNREFUSED");
            mockError.code = "ECONNREFUSED";

            const result = await errorSnapshot("Network Error", mockError);

            expect(result).toContain("Network Error");
            expect(result).toContain("Reason: Request failed");
            expect(result).toContain("Code: ECONNREFUSED");
        });

        it("should create snapshot from Error with reason property", async () => {
            const mockError = new Error("Generic error") as any;
            mockError.reason = "Custom reason message";

            const result = await errorSnapshot("Generic Error", mockError);

            expect(result).toContain("Generic Error");
            expect(result).toContain("Reason: Custom reason message");
        });

        it("should create snapshot from string error", async () => {
            const result = await errorSnapshot("String Error", "Simple error message");

            expect(result).toContain("String Error");
            expect(result).toContain("Reason: Simple error message");
        });

        it("should handle unknown error types", async () => {
            const mockError = { custom: "object" };

            const result = await errorSnapshot("Unknown Error", mockError);

            expect(result).toContain("Unknown Error");
            expect(result).toContain("Reason: [object Object]");
        });

        it("should handle errors that can't be converted to string", async () => {
            const mockError = {
                toString: () => {
                    throw new Error("toString failed");
                },
            };

            const result = await errorSnapshot("Broken Error", mockError);

            expect(result).toContain("Broken Error");
            expect(result).toContain("Reason: unknown error type");
        });
    });

    describe("Test containsNodeError", () => {
        it("should return true for ExecutionRevertedError", async () => {
            const mockError = new ExecutionRevertedError({
                cause: new BaseError("Execution reverted"),
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return true for FeeCapTooLowError", async () => {
            const mockError = new FeeCapTooLowError({ feeCap: 1000n, baseFee: 2000n } as any);
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return true for InsufficientFundsError", async () => {
            const mockError = new InsufficientFundsError({ address: "0x123" } as any);
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return true when error has ExecutionRevertedError code", async () => {
            const mockError = new BaseError("Test error") as any;
            mockError.code = ExecutionRevertedError.code;
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return true when parseRevertError returns decoded data", async () => {
            const mockError = new BaseError("Test error");
            (parseRevertError as Mock).mockResolvedValue({
                decoded: { name: "Error", args: ["test"] },
                raw: {},
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
            expect(parseRevertError).toHaveBeenCalledWith(mockError);
        });

        it("should return true when parseRevertError returns raw data", async () => {
            const mockError = new BaseError("Test error");
            (parseRevertError as Mock).mockResolvedValue({
                decoded: undefined,
                raw: { data: "0x12345678" },
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return true for allowance error without out of gas", async () => {
            const mockError = new BaseError("Transfer exceeds allowance");
            (parseRevertError as Mock).mockResolvedValue({
                decoded: undefined,
                raw: {},
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return false for allowance error with out of gas", async () => {
            const mockError = new BaseError("Transfer exceeds allowance out of gas");
            (parseRevertError as Mock).mockResolvedValue({
                decoded: undefined,
                raw: {},
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(false);
        });

        it("should return true when nested cause contains node error", async () => {
            const mockError = new BaseError("Outer error", {
                cause: new ExecutionRevertedError({ cause: new BaseError("Inner error") }),
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(true);
        });

        it("should return false for non-node errors", async () => {
            const mockError = new BaseError("Network timeout");
            (parseRevertError as Mock).mockResolvedValue({
                decoded: undefined,
                raw: {},
            });
            const result = await containsNodeError(mockError);
            expect(result).toBe(false);
        });

        it("should return false when breaker limit reached", async () => {
            const mockError = new BaseError("Recursive error") as any;
            mockError.cause = mockError; // circular reference
            const result = await containsNodeError(mockError);
            expect(result).toBe(false);
        });

        it("should handle errors during processing", async () => {
            const mockError = new BaseError("Test error");
            (parseRevertError as Mock).mockRejectedValue(new Error("Parse failed"));
            const result = await containsNodeError(mockError);
            expect(result).toBe(false);
        });
    });

    describe("Test isTimeout", () => {
        it("should return true for TimeoutError", () => {
            const mockError = new TimeoutError({ url: "http://test.com", timeout: 5000 } as any);
            const result = isTimeout(mockError);
            expect(result).toBe(true);
        });

        it("should return true for TransactionNotFoundError", () => {
            const mockError = new TransactionNotFoundError({ hash: "0x123" });
            const result = isTimeout(mockError);
            expect(result).toBe(true);
        });

        it("should return true for TransactionReceiptNotFoundError", () => {
            const mockError = new TransactionReceiptNotFoundError({ hash: "0x123" });
            const result = isTimeout(mockError);
            expect(result).toBe(true);
        });

        it("should return true for WaitForTransactionReceiptTimeoutError", () => {
            const mockError = new WaitForTransactionReceiptTimeoutError({ hash: "0x123" });
            const result = isTimeout(mockError);
            expect(result).toBe(true);
        });

        it("should return true when nested cause is timeout error", () => {
            const mockError = new BaseError("Outer error", {
                cause: new TimeoutError({ url: "http://test.com", timeout: 5000 } as any),
            });
            const result = isTimeout(mockError);
            expect(result).toBe(true);
        });

        it("should return false for non-timeout errors", () => {
            const mockError = new BaseError("Generic error");
            const result = isTimeout(mockError);
            expect(result).toBe(false);
        });

        it("should return false when breaker limit reached", () => {
            const mockError = new BaseError("Recursive error") as any;
            mockError.cause = mockError; // circular reference
            const result = isTimeout(mockError);
            expect(result).toBe(false);
        });

        it("should handle errors during processing", () => {
            const mockError = {
                get cause() {
                    throw new Error("Getter failed");
                },
            } as any;
            const result = isTimeout(mockError);
            expect(result).toBe(false);
        });
    });
});
