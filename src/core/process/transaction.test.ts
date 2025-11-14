import { RainSolver } from "..";
import { BaseError } from "viem";
import { Token } from "sushi/currency";
import { processReceipt } from "./receipt";
import { RainSolverSigner } from "../../signer";
import { PreAssembledSpan } from "../../logger";
import { SpanStatusCode } from "@opentelemetry/api";
import { containsNodeError, errorSnapshot, isTimeout } from "../../error";
import { RawTransaction, Result, withBigintSerializer } from "../../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    processTransaction,
    transactionSettlement,
    ProcessTransactionArgs,
    TransactionSettlementArgs,
} from "./transaction";
import {
    ProcessOrderStatus,
    ProcessOrderSuccess,
    ProcessOrderFailure,
    ProcessOrderHaltReason,
    ProcessTransactionSuccess,
} from "../types";

// mock dependencies
vi.mock("../../error", async (importOriginal) => ({
    ...(await importOriginal()),
    containsNodeError: vi.fn(),
    errorSnapshot: vi.fn(),
    isTimeout: vi.fn(),
}));

vi.mock("./receipt", async (importOriginal) => ({
    ...(await importOriginal()),
    processReceipt: vi.fn(),
}));

vi.mock("../../common", async (importOriginal) => {
    const org: any = await importOriginal();
    return {
        ...org,
        sleep: vi.fn(),
        withBigintSerializer: vi.spyOn(org, "withBigintSerializer"),
    };
});

describe("Test processTransaction", () => {
    let mockSigner: RainSolverSigner;
    let mockRawTx: RawTransaction;
    let mockArgs: ProcessTransactionArgs;
    let mockWriteSigner: any;
    let mockSolver: RainSolver;

    beforeEach(() => {
        vi.clearAllMocks();

        // mock write signer
        mockWriteSigner = {
            sendTx: vi.fn(),
        };

        // mock RainSolverSigner
        mockSigner = {
            account: {
                address: "0xSignerAddress",
            },
            state: {
                gasCosts: [],
                client: {
                    getTransactionReceipt: vi.fn(),
                },
                chainConfig: {
                    isSpecialL2: false,
                    blockExplorers: {
                        default: {
                            url: "https://etherscan.io",
                        },
                    },
                },
            },
            asWriteSigner: vi.fn().mockReturnValue(mockWriteSigner),
            waitForReceipt: vi.fn(),
        } as any;

        // mock raw transaction
        mockRawTx = {
            to: "0xContractAddress",
            data: "0xTransactionData",
            value: 0n,
            gas: 21000n,
            gasPrice: 20000000000n,
        };

        // mock arguments
        mockArgs = {
            signer: mockSigner,
            rawtx: mockRawTx,
            orderbook: "0xOrderbookAddress",
            inputToEthPrice: "2000.0",
            outputToEthPrice: "1.0",
            startTime: 123456,
            baseResult: {
                tokenPair: "ETH/USDC",
                buyToken: "0xUSDC",
                sellToken: "0xETH",
                spanAttributes: { baseAttr: "value" },
                spanEvents: { baseEvent: { startTime: 123, duration: 100 } },
                status: ProcessOrderStatus.FoundOpportunity,
            },
            toToken: {
                address: "0xUSDC",
                decimals: 6,
                symbol: "USDC",
            } as any as Token,
            fromToken: {
                address: "0xETH",
                decimals: 18,
                symbol: "ETH",
            } as any as Token,
        };
        mockSolver = {
            logger: { exportPreAssembledSpan: vi.fn() },
        } as any;
    });

    describe("successful transaction sending", () => {
        it("should send transaction successfully", async () => {
            const mockTxHash = "0xTransactionHash123";
            const mockReceipt = {
                status: "success",
                transactionHash: mockTxHash,
                gasUsed: 21000n,
                effectiveGasPrice: 20000000000n,
            };
            mockWriteSigner.sendTx.mockResolvedValueOnce({
                hash: mockTxHash,
                wait: vi.fn().mockResolvedValueOnce(mockReceipt),
            });
            (mockSigner.waitForReceipt as Mock).mockResolvedValueOnce(mockReceipt);
            const mockHandleReceiptResult = Result.ok<ProcessOrderSuccess, ProcessOrderFailure>({
                ...mockArgs.baseResult,
                endTime: 123,
            });
            (processReceipt as Mock).mockResolvedValueOnce(mockHandleReceiptResult);

            const settlerFn = await processTransaction.call(mockSolver, mockArgs);
            const result = await settlerFn();

            assert(result.isOk());

            // verify transaction was sent with correct parameters
            expect(mockWriteSigner.sendTx).toHaveBeenCalledWith({
                ...mockRawTx,
                type: "legacy",
            });
            expect(mockWriteSigner.sendTx).toHaveBeenCalledTimes(1);

            // verify span attributes were set
            expect(mockArgs.baseResult.spanAttributes["details.txUrl"]).toBe(
                "https://etherscan.io/tx/0xTransactionHash123",
            );

            // verify processReceipt was called with correct parameters
            expect(processReceipt as Mock).toHaveBeenCalledWith({
                receipt: mockReceipt,
                signer: mockSigner,
                rawtx: mockRawTx,
                orderbook: mockArgs.orderbook,
                inputToEthPrice: mockArgs.inputToEthPrice,
                outputToEthPrice: mockArgs.outputToEthPrice,
                baseResult: mockArgs.baseResult,
                txUrl: "https://etherscan.io/tx/0xTransactionHash123",
                toToken: mockArgs.toToken,
                fromToken: mockArgs.fromToken,
                txSendTime: expect.any(Number),
            });
        });
    });

    describe("transaction sending failures", () => {
        it("should return error result when send attempt fail", async () => {
            const mockError = new Error("Persistent network error");
            mockWriteSigner.sendTx.mockRejectedValue(mockError);
            (containsNodeError as Mock).mockResolvedValue(false);
            const settlerFn = await processTransaction.call(mockSolver, mockArgs);
            const result = await settlerFn();

            // verify error result structure
            assert(result.isErr());
            expect(result.error).toEqual({
                ...mockArgs.baseResult,
                error: mockError,
                reason: ProcessOrderHaltReason.TxFailed,
                endTime: expect.any(Number),
            });

            // verify raw transaction was logged
            expect(mockArgs.baseResult.spanAttributes["details.rawTx"]).toBeDefined();
            expect(mockArgs.baseResult.spanAttributes["txNoneNodeError"]).toBe(true);
            expect(withBigintSerializer).toHaveBeenCalledTimes(8);
        });

        it("should correctly identify node errors in transaction failures", async () => {
            const mockNodeError = new BaseError("Node connection failed");
            mockWriteSigner.sendTx.mockRejectedValue(mockNodeError);
            (containsNodeError as Mock).mockResolvedValue(true);
            const settlerFn = await processTransaction.call(mockSolver, mockArgs);
            const result = await settlerFn();

            assert(result.isErr());
            expect(mockArgs.baseResult.spanAttributes["txNoneNodeError"]).toBe(false);
            expect(containsNodeError).toHaveBeenCalledWith(mockNodeError);
        });
    });

    describe("Test transactionSettlement", () => {
        let mockArgsSettlement: TransactionSettlementArgs;

        beforeEach(() => {
            mockArgsSettlement = {
                ...mockArgs,
                txhash: "0xtxhash",
                txUrl: "https://example/tx/hash",
                txSendTime: 123,
            };
        });

        it("successful setllement", async () => {
            const mockReceipt = { status: "success" };
            const mockProcessResult = Result.ok<ProcessTransactionSuccess, ProcessOrderFailure>({
                clearedAmount: "100",
                gasCost: 420000000000000n,
                spanAttributes: { key: "value" },
                spanEvents: { event1: { duration: 100, startTime: 123 } },
            } as any);

            (mockSigner.waitForReceipt as Mock).mockResolvedValueOnce(mockReceipt);
            (processReceipt as Mock).mockResolvedValueOnce(mockProcessResult);
            const spanEventSpy = vi.spyOn(PreAssembledSpan.prototype, "addEvent");
            const spanSetStatusSpy = vi.spyOn(PreAssembledSpan.prototype, "setStatus");
            const spanExtendAttrsSpy = vi.spyOn(PreAssembledSpan.prototype, "extendAttrs");

            const result = await transactionSettlement.call(mockSolver, mockArgsSettlement);

            assert(result.isOk());
            expect(result.value.clearedAmount).toBe("100");

            // Verify receipt was fetched
            expect(mockSigner.waitForReceipt).toHaveBeenCalledWith({
                hash: mockArgsSettlement.txhash,
            });

            // Verify processReceipt was called with correct parameters
            expect(processReceipt).toHaveBeenCalledWith({
                receipt: mockReceipt,
                signer: mockArgsSettlement.signer,
                rawtx: mockArgsSettlement.rawtx,
                orderbook: mockArgsSettlement.orderbook,
                inputToEthPrice: mockArgsSettlement.inputToEthPrice,
                outputToEthPrice: mockArgsSettlement.outputToEthPrice,
                baseResult: mockArgsSettlement.baseResult,
                txUrl: mockArgsSettlement.txUrl,
                toToken: mockArgsSettlement.toToken,
                fromToken: mockArgsSettlement.fromToken,
                txSendTime: mockArgsSettlement.txSendTime,
            });

            // Verify gas cost was recorded
            expect(mockSigner.state.gasCosts).toContain(420000000000000n);

            // Verify logger was called
            expect(mockSolver.logger!.exportPreAssembledSpan).toHaveBeenCalledTimes(1);

            // Verify otel report calls
            expect(spanEventSpy).toHaveBeenNthCalledWith(1, "event1", { duration: 100 }, 123);
            expect(spanExtendAttrsSpy).toHaveBeenNthCalledWith(1, { key: "value" });
            expect(spanSetStatusSpy).toHaveBeenCalledWith({
                code: SpanStatusCode.OK,
                message: "found opportunity",
            });

            spanEventSpy.mockRestore();
            spanSetStatusSpy.mockRestore();
            spanExtendAttrsSpy.mockRestore();
        });

        it("reverted setllement", async () => {
            const mockReceipt = { status: "reverted" };
            const mockErrorResult = Result.err<ProcessTransactionSuccess, ProcessOrderFailure>({
                error: { err: new Error("Transaction reverted") },
                spanAttributes: { errorKey: "errorValue" },
                spanEvents: { event1: { duration: 100, startTime: 123 } },
            } as any);

            (mockSigner.waitForReceipt as Mock).mockResolvedValueOnce(mockReceipt);
            (processReceipt as Mock).mockResolvedValueOnce(mockErrorResult);
            (errorSnapshot as Mock).mockResolvedValue("Transaction reverted onchain");
            const spanEventSpy = vi.spyOn(PreAssembledSpan.prototype, "addEvent");
            const spanSetStatusSpy = vi.spyOn(PreAssembledSpan.prototype, "setStatus");
            const spanExtendAttrsSpy = vi.spyOn(PreAssembledSpan.prototype, "extendAttrs");

            const result = await transactionSettlement.call(mockSolver, mockArgsSettlement);

            assert(result.isErr());
            expect(result.error.error.err.message).toBe("Transaction reverted");

            // Verify receipt was fetched
            expect(mockSigner.waitForReceipt).toHaveBeenCalledWith({
                hash: mockArgsSettlement.txhash,
            });

            // Verify processReceipt was called
            expect(processReceipt).toHaveBeenCalled();

            // Verify error snapshot was created
            expect(errorSnapshot).toHaveBeenCalledWith(
                "transaction reverted onchain",
                (mockErrorResult as any).error.error.err,
            );

            // Verify logger was called
            expect(mockSolver.logger!.exportPreAssembledSpan).toHaveBeenCalled();

            // Verify processReceipt was called with correct parameters
            expect(processReceipt).toHaveBeenCalledWith({
                receipt: mockReceipt,
                signer: mockArgsSettlement.signer,
                rawtx: mockArgsSettlement.rawtx,
                orderbook: mockArgsSettlement.orderbook,
                inputToEthPrice: mockArgsSettlement.inputToEthPrice,
                outputToEthPrice: mockArgsSettlement.outputToEthPrice,
                baseResult: mockArgsSettlement.baseResult,
                txUrl: mockArgsSettlement.txUrl,
                toToken: mockArgsSettlement.toToken,
                fromToken: mockArgsSettlement.fromToken,
                txSendTime: mockArgsSettlement.txSendTime,
            });

            // Verify otel report calls
            expect(spanEventSpy).toHaveBeenNthCalledWith(1, "event1", { duration: 100 }, 123);
            expect(spanExtendAttrsSpy).toHaveBeenNthCalledWith(1, { errorKey: "errorValue" });
            expect(spanSetStatusSpy).toHaveBeenCalledWith({
                code: SpanStatusCode.ERROR,
                message: expect.any(String),
            });

            spanEventSpy.mockRestore();
            spanSetStatusSpy.mockRestore();
            spanExtendAttrsSpy.mockRestore();
        });

        it("failed setllement", async () => {
            const mockTimeoutError = new Error("Timeout error");
            (mockSigner.waitForReceipt as Mock).mockRejectedValueOnce(mockTimeoutError);
            (isTimeout as Mock).mockReturnValueOnce(true);
            (errorSnapshot as Mock).mockResolvedValue("Transaction timeout");
            const spanEventSpy = vi.spyOn(PreAssembledSpan.prototype, "addEvent");
            const spanSetStatusSpy = vi.spyOn(PreAssembledSpan.prototype, "setStatus");
            const spanExtendAttrsSpy = vi.spyOn(PreAssembledSpan.prototype, "extendAttrs");

            const result = await transactionSettlement.call(mockSolver, mockArgsSettlement);

            assert(result.isErr());
            expect(result.error.reason).toBe(ProcessOrderHaltReason.TxMineFailed);

            // Verify timeout was detected
            expect(isTimeout).toHaveBeenCalledWith(mockTimeoutError);

            // Verify error snapshot was created
            expect(errorSnapshot).toHaveBeenCalledWith("transaction failed", mockTimeoutError);

            // Verify logger was called
            expect(mockSolver.logger!.exportPreAssembledSpan).toHaveBeenCalled();

            // Verify processReceipt was not called
            expect(processReceipt).not.toHaveBeenCalled();

            // Verify otel report calls
            expect(spanEventSpy).toHaveBeenNthCalledWith(1, "baseEvent", { duration: 100 }, 123);
            expect(spanExtendAttrsSpy).toHaveBeenNthCalledWith(1, { baseAttr: "value" });
            expect(spanSetStatusSpy).toHaveBeenCalledWith({
                code: SpanStatusCode.ERROR,
                message: expect.any(String),
            });

            spanEventSpy.mockRestore();
            spanSetStatusSpy.mockRestore();
            spanExtendAttrsSpy.mockRestore();
        });
    });
});
