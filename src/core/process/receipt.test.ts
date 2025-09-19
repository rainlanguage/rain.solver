import { sleep } from "../../common";
import { Token } from "sushi/currency";
import { TransactionReceipt } from "viem";
import { handleRevert } from "../../error";
import { RainSolverSigner } from "../../signer";
import { OpStackTransactionReceipt } from "viem/chains";
import { ProcessOrderHaltReason, ProcessOrderStatus } from "../types";
import { getActualClearAmount, getIncome, getTotalIncome } from "./log";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { getL1Fee, tryGetReceipt, processReceipt, ProcessReceiptArgs } from "./receipt";

vi.mock("../../error", () => ({
    handleRevert: vi.fn(),
}));

vi.mock("../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    sleep: vi.fn(),
}));

vi.mock("./log", async (importOriginal) => ({
    ...(await importOriginal()),
    getIncome: vi.fn(),
    getTotalIncome: vi.fn(),
    getActualClearAmount: vi.fn(),
}));

describe("Test processReceipt", () => {
    let mockSigner: RainSolverSigner;
    let mockArgs: ProcessReceiptArgs;
    let mockReceipt: TransactionReceipt;

    beforeEach(() => {
        vi.clearAllMocks();

        // mock signer
        mockSigner = {
            account: {
                address: "0xSignerAddress",
            },
            getSelfBalance: vi.fn().mockResolvedValue("1000000000000000000"),
        } as any;

        // mock receipt
        mockReceipt = {
            status: "success",
            transactionHash: "0xTxHash123",
            gasUsed: 21000n,
            effectiveGasPrice: 20000000000n,
        } as any as TransactionReceipt;

        // mock arguments
        mockArgs = {
            receipt: mockReceipt,
            signer: mockSigner,
            rawtx: {
                to: "0xContractAddress",
                data: "0xTxData",
            },
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
            txUrl: "https://etherscan.io/tx/0xTxHash123",
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
            txSendTime: Date.now(),
        };
    });

    describe("successful receipt processing", () => {
        it("should process successful receipt and return ok result", async () => {
            const mockClearAmount = 1000000n;
            const mockInputIncome = 2000000000n;
            const mockOutputIncome = 1000000000000000000n;
            const mockTotalIncome = 4000000000000000000n;
            (getActualClearAmount as Mock).mockReturnValue(mockClearAmount);
            (getIncome as Mock)
                .mockReturnValueOnce(mockInputIncome) // input token income
                .mockReturnValueOnce(mockOutputIncome); // output token income
            (getTotalIncome as Mock).mockReturnValue(mockTotalIncome);
            const result = await processReceipt(mockArgs);

            assert(result.isOk());
            expect(result.value.status).toBe(ProcessOrderStatus.FoundOpportunity);
            expect(result.value.clearedAmount).toBe(mockClearAmount.toString());
            expect(result.value.gasCost).toBe(420000000000000n); // gasUsed * effectiveGasPrice
            expect(result.value.income).toBe(mockTotalIncome);
            expect(result.value.inputTokenIncome).toBe("2000");
            expect(result.value.outputTokenIncome).toBe("1");
            expect(result.value.netProfit).toBeDefined();
            expect(result.value.endTime).toBeTypeOf("number");
            expect(result.value.spanAttributes["didClear"]).toBe(true);
            expect(result.value.spanAttributes["details.actualGasCost"]).toBeDefined();
            expect(result.value.spanAttributes["details.actualGasCost"]).toBeTypeOf("number");
            expect(result.value.spanAttributes["details.income"]).toBeDefined();
            expect(result.value.spanAttributes["details.income"]).toBeTypeOf("number");
            expect(result.value.spanAttributes["details.inputTokenIncome"]).toBeDefined();
            expect(result.value.spanAttributes["details.inputTokenIncome"]).toBe("2000");
            expect(result.value.spanAttributes["details.outputTokenIncome"]).toBeDefined();
            expect(result.value.spanAttributes["details.outputTokenIncome"]).toBe("1");
            expect(result.value.spanAttributes["details.netProfit"]).toBeDefined();
            expect(result.value.spanAttributes["details.netProfit"]).toBeTypeOf("number");
            expect(result.value.spanAttributes["details.gasCostL1"]).toBeUndefined();
        });

        it("should calculate gas cost correctly including L1 fee", async () => {
            mockArgs.receipt = {
                ...mockReceipt,
                l1Fee: 50000000000000n,
            } as any;
            (getActualClearAmount as Mock).mockReturnValue(1000000n);
            (getIncome as Mock).mockReturnValue(undefined);
            (getTotalIncome as Mock).mockReturnValue(undefined);
            const result = await processReceipt(mockArgs);

            assert(result.isOk());
            expect(result.value.gasCost).toBe(470000000000000n);
            expect(result.value.endTime).toBeTypeOf("number");
            expect(mockArgs.baseResult.spanAttributes["details.gasCostL1"]).toBeDefined();
        });

        it("should handle case with no income", async () => {
            (getActualClearAmount as Mock).mockReturnValue(1000000n);
            (getIncome as Mock).mockReturnValue(undefined);
            (getTotalIncome as Mock).mockReturnValue(undefined);

            const result = await processReceipt(mockArgs);

            assert(result.isOk());
            expect(result.value.income).toBeUndefined();
            expect(result.value.netProfit).toBeUndefined();
            expect(result.value.inputTokenIncome).toBeUndefined();
            expect(result.value.outputTokenIncome).toBeUndefined();
            expect(result.value.endTime).toBeTypeOf("number");
        });
    });

    describe("failed receipt processing", () => {
        beforeEach(() => {
            mockArgs.receipt = {
                ...mockReceipt,
                status: "reverted",
            } as TransactionReceipt;
        });

        it("should process reverted receipt and return error result", async () => {
            const mockSimulation = {
                snapshot: "Transaction reverted: insufficient balance",
                nodeError: false,
            };
            (handleRevert as Mock).mockResolvedValue(mockSimulation);
            const result = await processReceipt(mockArgs);

            assert(result.isErr());
            expect(result.error.reason).toBe(ProcessOrderHaltReason.TxReverted);
            expect(result.error.error).toBe(mockSimulation);
            expect(result.error.txUrl).toBe(mockArgs.txUrl);
            expect(result.error.spanAttributes["txNoneNodeError"]).toBe(true);
            expect(result.error.endTime).toBeTypeOf("number");
        });

        it("should retry handleRevert when simulation fails to find revert reason", async () => {
            const firstSimulation = {
                snapshot: "simulation failed to find the revert reason",
                nodeError: false,
            };
            const retrySimulation = {
                snapshot: "Transaction reverted: gas limit exceeded",
                nodeError: false,
            };
            (handleRevert as Mock)
                .mockResolvedValueOnce(firstSimulation)
                .mockResolvedValueOnce(retrySimulation);
            const result = await processReceipt(mockArgs);

            expect(sleep).toHaveBeenCalledWith(expect.any(Number));
            expect(handleRevert as Mock).toHaveBeenCalledTimes(2);
            assert(result.isErr());
            expect(result.error.reason).toBe(ProcessOrderHaltReason.TxReverted);
            expect(result.error.error).toBe(retrySimulation);
            expect(result.error.endTime).toBeTypeOf("number");
        });

        it("should handle node error correctly in span attributes", async () => {
            const mockSimulation = {
                snapshot: "Node connection failed",
                nodeError: true,
            };
            (handleRevert as Mock).mockResolvedValue(mockSimulation);
            const result = await processReceipt(mockArgs);

            assert(result.isErr());
            expect(result.error.spanAttributes["txNoneNodeError"]).toBe(false);
            expect(result.error.endTime).toBeTypeOf("number");
        });

        it("should call handleRevert with correct parameters", async () => {
            const mockBalance = "1000000000000000000";
            (handleRevert as Mock).mockResolvedValue({ snapshot: "test", nodeError: false });
            await processReceipt(mockArgs);

            expect(handleRevert as Mock).toHaveBeenCalledWith(
                mockSigner,
                mockArgs.receipt.transactionHash,
                mockArgs.receipt,
                mockArgs.rawtx,
                mockBalance,
                mockArgs.orderbook,
            );
        });
    });
});

describe("Test getL1Fee", () => {
    let mockStandardReceipt: TransactionReceipt;

    beforeEach(() => {
        mockStandardReceipt = {
            transactionHash: "0xHash123",
            blockNumber: 12345n,
            gasUsed: 21000n,
            effectiveGasPrice: 20000000000n,
            status: "success",
        } as any as TransactionReceipt;
    });

    describe("receipts with no L1 fees", () => {
        it("should return 0n when when receipt does not contains l1 fees", () => {
            const result = getL1Fee(mockStandardReceipt);
            expect(result).toBe(0n);
        });
    });

    describe("receipts with L1 fees", () => {
        it("should return l1Fee when receipt has l1Fee property", () => {
            const l1Fee = 75000000000000n;
            const receiptWithL1Fee = {
                ...mockStandardReceipt,
                l1Fee,
            } as OpStackTransactionReceipt;
            const result = getL1Fee(receiptWithL1Fee);

            expect(result).toBe(l1Fee);
        });
    });

    describe("receipts with L1 gas properties", () => {
        it("should calculate and return l1GasPrice * l1GasUsed", () => {
            const l1GasPrice = 15000000000n;
            const l1GasUsed = 2100n;
            const expectedFee = l1GasPrice * l1GasUsed;
            const receiptWithL1Gas = {
                ...mockStandardReceipt,
                l1GasPrice,
                l1GasUsed,
            } as OpStackTransactionReceipt;

            const result = getL1Fee(receiptWithL1Gas);

            expect(result).toBe(expectedFee);
            expect(result).toBe(31500000000000n);
        });
    });
});

describe("Test tryGetReceipt", () => {
    let mockSigner: RainSolverSigner;
    let mockClient: any;
    const mockTxHash =
        "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}`;

    beforeEach(() => {
        vi.clearAllMocks();

        // mock client with receipt methods
        mockClient = {
            waitForTransactionReceipt: vi.fn(),
            getTransactionReceipt: vi.fn(),
        };

        // mock signer
        mockSigner = {
            state: {
                client: mockClient,
            },
        } as RainSolverSigner;
    });

    describe("successful waitForTransactionReceipt", () => {
        it("should return receipt when waitForTransactionReceipt succeeds", async () => {
            const mockReceipt: TransactionReceipt = {
                transactionHash: mockTxHash,
                blockNumber: 12345n,
                gasUsed: 21000n,
                effectiveGasPrice: 20000000000n,
                status: "success",
            } as TransactionReceipt;
            mockClient.waitForTransactionReceipt.mockResolvedValueOnce(mockReceipt);
            const result = await tryGetReceipt(mockSigner, mockTxHash, Date.now());

            expect(result).toBe(mockReceipt);
            expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: mockTxHash,
                confirmations: 1,
                timeout: 120_000,
            });
            expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
            expect(mockClient.getTransactionReceipt).not.toHaveBeenCalled();
        });

        it("should call waitForTransactionReceipt with correct parameters", async () => {
            const mockReceipt: TransactionReceipt = {
                transactionHash: mockTxHash,
                status: "success",
            } as TransactionReceipt;
            mockClient.waitForTransactionReceipt.mockResolvedValueOnce(mockReceipt);
            await tryGetReceipt(mockSigner, mockTxHash, Date.now());

            expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: mockTxHash,
                confirmations: 1,
                timeout: 120_000,
            });
        });
    });

    describe("waitForTransactionReceipt failure fallback", () => {
        it("should fallback to getTransactionReceipt when waitForTransactionReceipt fails", async () => {
            const mockReceipt: TransactionReceipt = {
                transactionHash: mockTxHash,
                blockNumber: 12345n,
                status: "success",
            } as TransactionReceipt;
            mockClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("Timeout"));
            mockClient.getTransactionReceipt.mockResolvedValueOnce(mockReceipt);
            const result = await tryGetReceipt(mockSigner, mockTxHash, Date.now());

            expect(result).toBe(mockReceipt);
            expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
            expect(sleep as Mock).toHaveBeenCalledTimes(1);
            expect(mockClient.getTransactionReceipt).toHaveBeenCalledWith({
                hash: mockTxHash,
            });
            expect(mockClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
        });

        it("should call getTransactionReceipt with correct parameters", async () => {
            const mockReceipt: TransactionReceipt = {
                transactionHash: mockTxHash,
                status: "success",
            } as TransactionReceipt;
            mockClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("Network error"));
            mockClient.getTransactionReceipt.mockResolvedValueOnce(mockReceipt);
            await tryGetReceipt(mockSigner, mockTxHash, Date.now());

            expect(mockClient.getTransactionReceipt).toHaveBeenCalledWith({
                hash: mockTxHash,
            });
        });
    });

    describe("error propagation", () => {
        it("should propagate error when getTransactionReceipt also fails", async () => {
            const waitError = new Error("Wait timeout");
            const getError = new Error("Receipt not found");

            mockClient.waitForTransactionReceipt.mockRejectedValueOnce(waitError);
            mockClient.getTransactionReceipt.mockRejectedValueOnce(getError);

            await expect(tryGetReceipt(mockSigner, mockTxHash, Date.now())).rejects.toThrow(
                "Receipt not found",
            );

            expect(mockClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
            expect(mockClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
        });
    });
});
