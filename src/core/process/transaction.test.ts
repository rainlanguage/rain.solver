import { BaseError } from "viem";
import { Result } from "../../common";
import { Token } from "sushi/currency";
import { processReceipt } from "./receipt";
import { containsNodeError } from "../../error";
import { withBigintSerializer } from "../../common";
import { RainSolverSigner, RawTransaction } from "../../signer";
import { processTransaction, ProcessTransactionArgs } from "./transaction";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    ProcessOrderFailure,
    ProcessOrderHaltReason,
    ProcessOrderStatus,
    ProcessOrderSuccess,
} from "../types";

// mock dependencies
vi.mock("../../error", () => ({
    containsNodeError: vi.fn(),
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
                client: {
                    waitForTransactionReceipt: vi.fn(),
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
            baseResult: {
                tokenPair: "ETH/USDC",
                buyToken: "0xUSDC",
                sellToken: "0xETH",
                spanAttributes: {},
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
    });

    describe("successful transaction sending", () => {
        it("should send transaction successfully", async () => {
            const mockTxHash = "0xTransactionHash123";
            mockWriteSigner.sendTx.mockResolvedValueOnce(mockTxHash);
            const mockReceipt = {
                status: "success",
                transactionHash: mockTxHash,
                gasUsed: 21000n,
                effectiveGasPrice: 20000000000n,
            };
            (mockSigner.state.client.waitForTransactionReceipt as Mock).mockResolvedValueOnce(
                mockReceipt,
            );
            const mockHandleReceiptResult = Result.ok<ProcessOrderSuccess, ProcessOrderFailure>({
                ...mockArgs.baseResult,
                clearedAmount: "100",
                gasCost: 420000000000000n,
            });
            (processReceipt as Mock).mockResolvedValueOnce(mockHandleReceiptResult);
            const settlerFn = await processTransaction(mockArgs);
            const result = await settlerFn();

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

            // verify result is passed through from processReceipt
            expect(result).toBe(mockHandleReceiptResult);
        });
    });

    describe("transaction sending failures", () => {
        it("should return error result when send attempt fail", async () => {
            const mockError = new Error("Persistent network error");
            mockWriteSigner.sendTx.mockRejectedValue(mockError);
            (containsNodeError as Mock).mockResolvedValue(false);
            const settlerFn = await processTransaction(mockArgs);
            const result = await settlerFn();

            // verify error result structure
            assert(result.isErr());
            expect(result.error).toEqual({
                ...mockArgs.baseResult,
                error: mockError,
                reason: ProcessOrderHaltReason.TxFailed,
            });

            // verify raw transaction was logged
            expect(mockArgs.baseResult.spanAttributes["details.rawTx"]).toBeDefined();
            expect(mockArgs.baseResult.spanAttributes["txNoneNodeError"]).toBe(true);
            expect(withBigintSerializer).toHaveBeenCalledTimes(7);
        });

        it("should correctly identify node errors in transaction failures", async () => {
            const mockNodeError = new BaseError("Node connection failed");
            mockWriteSigner.sendTx.mockRejectedValue(mockNodeError);
            (containsNodeError as Mock).mockResolvedValue(true);
            const settlerFn = await processTransaction(mockArgs);
            const result = await settlerFn();

            assert(result.isErr());
            expect(mockArgs.baseResult.spanAttributes["txNoneNodeError"]).toBe(false);
            expect(containsNodeError).toHaveBeenCalledWith(mockNodeError);
        });
    });

    describe("receipt processing failures", () => {
        it("should return error result when receipt retrieval fails completely", async () => {
            const mockTxHash = "0xFailedReceiptHash";
            const receiptError = new Error("Receipt retrieval failed");
            mockWriteSigner.sendTx.mockResolvedValueOnce(mockTxHash);
            (mockSigner.state.client.waitForTransactionReceipt as Mock).mockRejectedValueOnce(
                receiptError,
            );
            (mockSigner.state.client.getTransactionReceipt as Mock).mockRejectedValue(receiptError);
            (containsNodeError as Mock).mockResolvedValue(true);
            const settlerFn = await processTransaction(mockArgs);
            const result = await settlerFn();

            assert(result.isErr());
            expect(result.error).toEqual({
                ...mockArgs.baseResult,
                txUrl: "https://etherscan.io/tx/0xFailedReceiptHash",
                reason: ProcessOrderHaltReason.TxMineFailed,
                error: receiptError,
            });
            expect(result.error.spanAttributes["details.rawTx"]).toBeDefined();
            expect(result.error.spanAttributes["txNoneNodeError"]).toBe(false);
        });

        it("should return error result when processReceipt throws", async () => {
            const mockTxHash = "0xHandleReceiptFailHash";
            const mockReceipt = {
                status: "success",
                transactionHash: mockTxHash,
                gasUsed: 21000n,
                effectiveGasPrice: 20000000000n,
            };
            const handleReceiptError = new Error("Handle receipt failed");
            mockWriteSigner.sendTx.mockResolvedValueOnce(mockTxHash);
            (mockSigner.state.client.waitForTransactionReceipt as Mock).mockResolvedValueOnce(
                mockReceipt,
            );
            (processReceipt as Mock).mockRejectedValueOnce(handleReceiptError);
            (containsNodeError as Mock).mockResolvedValue(false);
            const settlerFn = await processTransaction(mockArgs);
            const result = await settlerFn();

            assert(result.isErr());
            expect(result.error).toEqual({
                ...mockArgs.baseResult,
                txUrl: "https://etherscan.io/tx/0xHandleReceiptFailHash",
                reason: ProcessOrderHaltReason.TxMineFailed,
                error: handleReceiptError,
            });
            expect(result.error.spanAttributes["txNoneNodeError"]).toBe(true);
        });
    });
});
