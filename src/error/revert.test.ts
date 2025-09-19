import { isDeepStrictEqual } from "util";
import { tryDecodeError } from "./decoder";
import { getRpcError } from "../rpc/helpers";
import { ABI, RawTransaction } from "../common";
import { errorSnapshot, containsNodeError } from "./common";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { BaseError, decodeFunctionData, Hex, isHex, TransactionReceipt } from "viem";
import {
    handleRevert,
    parseRevertError,
    tryDetectFrontrun,
    evaluateGasSufficiency,
} from "./revert";

vi.mock("util", () => ({
    isDeepStrictEqual: vi.fn(),
}));

vi.mock("./decoder", () => ({
    tryDecodeError: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    decodeFunctionData: vi.fn(),
    isHex: vi.fn(),
}));

vi.mock("./common", () => ({
    errorSnapshot: vi.fn(),
    containsNodeError: vi.fn(),
}));

vi.mock("../rpc/helpers", async (importOriginal) => ({
    ...(await importOriginal()),
    getRpcError: vi.fn(),
}));

describe("Test revert error handling functions", () => {
    let mockViemClient: any;
    let mockReceipt: TransactionReceipt;
    let mockRawTx: RawTransaction;

    beforeEach(() => {
        vi.clearAllMocks();

        mockViemClient = {
            getTransaction: vi.fn(),
            call: vi.fn(),
            getLogs: vi.fn(),
        };

        mockReceipt = {
            transactionHash: "0x123abc",
            blockHash: "0xblock123",
            transactionIndex: 5,
            gasUsed: 100000n,
            effectiveGasPrice: 20000000000n,
        } as any;

        mockRawTx = {
            to: "0xContractAddress",
            data: "0x7ea0b76a0000000000000000000000000000000000000000000000000000000000000001",
            gas: 200000n,
            gasPrice: 20000000000n,
        } as RawTransaction;
    });

    describe("Test handleRevert", () => {
        it("should return gas error when transaction ran out of specified gas", async () => {
            const signerBalance = 10000000000000000000n; // 10 ETH
            mockRawTx.gas = 100000n;
            mockReceipt.gasUsed = 99000n; // 99% of gas limit
            const result = await handleRevert(
                mockViemClient,
                "0x123abc",
                mockReceipt,
                mockRawTx,
                signerBalance,
                "0xOrderbook",
            );

            expect(result.err).toBe(
                "transaction reverted onchain, transaction ran out of specified gas",
            );
            expect(result.nodeError).toBe(false);
            expect(mockViemClient.getTransaction).not.toHaveBeenCalled();
        });

        it("should simulate transaction when no gas issues found", async () => {
            const signerBalance = 10000000000000000000n; // 10 ETH
            mockRawTx.gas = 200000n;
            mockReceipt.gasUsed = 100000n; // 50% of gas limit
            const mockTransaction = {
                from: "0xSender",
                to: "0xTo",
                input: "0xdata",
                gas: 200000n,
                gasPrice: 20000000000n,
                blockNumber: 12345n,
            };
            mockViemClient.getTransaction.mockResolvedValue(mockTransaction);
            // simulate successful call (no error thrown)
            mockViemClient.call.mockResolvedValue("0xresult");

            const result = await handleRevert(
                mockViemClient,
                "0x123abc",
                mockReceipt,
                mockRawTx,
                signerBalance,
                "0xOrderbook",
            );

            expect(result.err).toContain("simulation failed to find the revert reason");
            expect(result.nodeError).toBe(false);
            expect(mockViemClient.getTransaction).toHaveBeenCalledWith({
                hash: "0x123abc",
            });
            expect(mockViemClient.call).toHaveBeenCalledWith({
                account: mockTransaction.from,
                to: mockTransaction.to,
                data: mockTransaction.input,
                gas: mockTransaction.gas,
                gasPrice: mockTransaction.gasPrice,
                blockNumber: mockTransaction.blockNumber,
            });
        });

        it("should handle simulation error with frontrun detection", async () => {
            const signerBalance = 10000000000000000000n;
            const simulationError = new BaseError("Execution reverted");
            const frontrunHash = "0xfrontrun123";
            mockViemClient.getTransaction.mockResolvedValue({
                from: "0xSender",
                to: "0xTo",
                input: "0xdata",
                gas: 200000n,
                gasPrice: 20000000000n,
                blockNumber: 12345n,
            });
            mockViemClient.call.mockRejectedValue(simulationError);

            // mock tryDetectFrontrun to return a frontrun transaction
            const mockOrderConfig = { order: "config" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: frontrunHash,
                    transactionIndex: 3,
                    args: { config: mockOrderConfig },
                },
            ]);
            (isDeepStrictEqual as Mock).mockReturnValue(true);
            (containsNodeError as Mock).mockResolvedValue(true);
            (errorSnapshot as Mock).mockResolvedValue("Error snapshot with frontrun info");
            (getRpcError as Mock).mockReturnValue({});

            const result = await handleRevert(
                mockViemClient,
                "0x123abc",
                mockReceipt,
                mockRawTx,
                signerBalance,
                "0xOrderbook",
            );

            expect(result.err).toBe(simulationError);
            expect(result.nodeError).toBe(true);
            expect(result.snapshot).toBe("Error snapshot with frontrun info");
            expect(containsNodeError).toHaveBeenCalledWith(simulationError);
            expect(errorSnapshot).toHaveBeenCalledWith(
                "transaction reverted onchain",
                simulationError,
                {
                    receipt: mockReceipt,
                    rawtx: mockRawTx,
                    signerBalance,
                    frontrun: `current transaction with hash ${mockReceipt.transactionHash} has been actually frontrun by transaction with hash ${frontrunHash}`,
                },
            );
        });

        it("should handle simulation error without frontrun", async () => {
            const signerBalance = 10000000000000000000n;
            const simulationError = new BaseError("Execution reverted");
            mockViemClient.getTransaction.mockResolvedValue({
                from: "0xSender",
                to: "0xTo",
                input: "0xdata",
                gas: 200000n,
                gasPrice: 20000000000n,
                blockNumber: 12345n,
            });
            mockViemClient.call.mockRejectedValue(simulationError);

            // mock no frontrun detected
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [{ order: "config" }] }],
            });
            mockViemClient.getLogs.mockResolvedValue([]);
            (containsNodeError as Mock).mockResolvedValue(false);
            (errorSnapshot as Mock).mockResolvedValue("Error snapshot without frontrun");
            (getRpcError as Mock).mockReturnValue({});

            const result = await handleRevert(
                mockViemClient,
                "0x123abc",
                mockReceipt,
                mockRawTx,
                signerBalance,
                "0xOrderbook",
            );

            expect(result.err).toBe(simulationError);
            expect(result.nodeError).toBe(false);
            expect(result.snapshot).toBe("Error snapshot without frontrun");
            expect(errorSnapshot).toHaveBeenCalledWith(
                "transaction reverted onchain",
                simulationError,
                {
                    receipt: mockReceipt,
                    rawtx: mockRawTx,
                    signerBalance,
                    frontrun: undefined,
                },
            );
        });
    });

    describe("Test parseRevertError", () => {
        it("should parse error with decoded data", async () => {
            const mockError = new BaseError("Test error") as any;
            mockError.data = "0x1234";
            const mockRawError = {
                code: -32000,
                message: "execution reverted",
                data: mockError.data,
            };
            const mockDecodedError = {
                name: "Error",
                args: ["Error message"],
            };

            (getRpcError as Mock).mockReturnValue(mockRawError);
            (isHex as any as Mock).mockReturnValue(true);
            (tryDecodeError as Mock).mockResolvedValue({
                isOk: () => true,
                value: mockDecodedError,
            });

            const result = await parseRevertError(mockError);

            expect(result.raw).toBe(mockRawError);
            expect(result.decoded).toBe(mockDecodedError);
            expect(getRpcError).toHaveBeenCalledWith(mockError);
            expect(isHex).toHaveBeenCalledWith(mockError.data, { strict: true });
            expect(tryDecodeError).toHaveBeenCalledWith(mockError.data);
        });

        it("should parse error without decoded data when decoding fails", async () => {
            const mockError = new BaseError("Test error") as any;
            mockError.data = "0x1234";
            const mockRawError = {
                code: -32000,
                message: "execution reverted",
                data: mockError.data,
            };

            (getRpcError as Mock).mockReturnValue(mockRawError);
            (isHex as any as Mock).mockReturnValue(true);
            (tryDecodeError as Mock).mockResolvedValue({
                isOk: () => false,
                error: new Error("Decode failed"),
            });

            const result = await parseRevertError(mockError);

            expect(result.raw).toBe(mockRawError);
            expect(result.decoded).toBeUndefined();
        });

        it("should parse error without data property", async () => {
            const mockError = new BaseError("Test error");
            const mockRawError = {
                code: -32000,
                message: "execution reverted",
            };
            (getRpcError as Mock).mockReturnValue(mockRawError);

            const result = await parseRevertError(mockError);

            expect(result.raw).toBe(mockRawError);
            expect(result.decoded).toBeUndefined();
            expect(isHex).not.toHaveBeenCalled();
            expect(tryDecodeError).not.toHaveBeenCalled();
        });

        it("should parse error with invalid hex data", async () => {
            const mockError = new BaseError("Test error") as any;
            mockError.data = "invalid-hex";
            const mockRawError = {
                code: -32000,
                message: "execution reverted",
                data: mockError.data,
            };
            (getRpcError as Mock).mockReturnValue(mockRawError);
            (isHex as any as Mock).mockReturnValue(false);

            const result = await parseRevertError(mockError);

            expect(result.raw).toBe(mockRawError);
            expect(result.decoded).toBeUndefined();
            expect(tryDecodeError).not.toHaveBeenCalled();
        });
    });

    describe("Test evaluateGasSufficiency", () => {
        it("should return error when account ran out of gas for transaction cost", () => {
            const receipt = {
                gasUsed: 100000n,
                effectiveGasPrice: 20000000000n, // 20 gwei
            } as TransactionReceipt;

            const rawtx = {
                gas: 200000n,
            } as RawTransaction;
            const signerBalance = 1000000000000000n; // much less than tx cost
            const result = evaluateGasSufficiency(receipt, rawtx, signerBalance);
            expect(result).toBe("account ran out of gas for transaction gas cost");
        });

        it("should return error when transaction ran out of specified gas", () => {
            const receipt = {
                gasUsed: 198000n, // 99% of gas limit
                effectiveGasPrice: 20000000000n,
            } as TransactionReceipt;
            const rawtx = {
                gas: 200000n,
            } as RawTransaction;
            const signerBalance = 10000000000000000000n; // 10 ETH
            const result = evaluateGasSufficiency(receipt, rawtx, signerBalance);
            expect(result).toBe("transaction ran out of specified gas");
        });

        it("should return undefined when no gas issues", () => {
            const receipt = {
                gasUsed: 100000n, // 50% of gas limit
                effectiveGasPrice: 20000000000n,
            } as TransactionReceipt;
            const rawtx = {
                gas: 200000n,
            } as RawTransaction;
            const signerBalance = 10000000000000000000n; // 10 ETH
            const result = evaluateGasSufficiency(receipt, rawtx, signerBalance);
            expect(result).toBeUndefined();
        });

        it("should handle string gas value", () => {
            const receipt = {
                gasUsed: 100000n,
                effectiveGasPrice: 20000000000n,
            } as TransactionReceipt;
            const rawtx = {
                gas: "200000", // string instead of bigint
            } as any;
            const signerBalance = 10000000000000000000n;
            const result = evaluateGasSufficiency(receipt, rawtx, signerBalance);
            expect(result).toBeUndefined();
        });
    });

    describe("Test tryDetectFrontrun", () => {
        it("should detect frontrun for arb3 transaction", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            const frontrunHash = "0xfrontrun123";
            mockRawTx.data = ("0x7ea0b76a" + "0".repeat(56)) as Hex; // arb3 function selector
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: frontrunHash,
                    transactionIndex: 3, // earlier than current tx (index 5)
                    args: { config: mockOrderConfig },
                },
            ]);
            (isDeepStrictEqual as Mock).mockReturnValue(true);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );

            expect(result).toBe(frontrunHash);
            expect(decodeFunctionData).toHaveBeenCalledWith({
                abi: [ABI.Orderbook.Primary.Arb[1]],
                data: mockRawTx.data,
            });
            expect(mockViemClient.getLogs).toHaveBeenCalledWith({
                events: [ABI.Orderbook.Primary.Orderbook[13], ABI.Orderbook.Primary.Orderbook[15]],
                address: "0xOrderbook",
                blockHash: mockReceipt.blockHash,
            });
            expect(isDeepStrictEqual).toHaveBeenCalledWith(mockOrderConfig, mockOrderConfig);
        });

        it("should detect frontrun for clear2 transaction", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            const frontrunHash = "0xfrontrun456";
            mockRawTx.data = ("0x12345678" + "0".repeat(56)) as Hex;
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, mockOrderConfig],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: frontrunHash,
                    transactionIndex: 2,
                    args: { alice: mockOrderConfig },
                },
            ]);
            (isDeepStrictEqual as Mock).mockReturnValue(true);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );

            expect(result).toBe(frontrunHash);
            expect(decodeFunctionData).toHaveBeenCalledWith({
                abi: [ABI.Orderbook.Primary.Orderbook[12]],
                data: mockRawTx.data,
            });
        });

        it("should return undefined when no frontrun detected", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: "0xother123",
                    transactionIndex: 3,
                    args: { config: { different: "config" } },
                },
            ]);
            (isDeepStrictEqual as Mock).mockReturnValue(false);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });

        it("should return undefined when no logs found", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([]);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });

        it("should filter out logs from same transaction", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: mockReceipt.transactionHash, // same transaction
                    transactionIndex: 3,
                    args: { config: mockOrderConfig },
                },
            ]);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });

        it("should filter out logs with higher transaction index", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockResolvedValue([
                {
                    transactionHash: "0xafter123",
                    transactionIndex: 7, // After current tx (index 5)
                    args: { config: mockOrderConfig },
                },
            ]);
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });

        it("should handle decode function data failure", async () => {
            (decodeFunctionData as Mock).mockImplementation(() => {
                throw new Error("Decode failed");
            });
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });

        it("should handle getLogs failure", async () => {
            const mockOrderConfig = { order: "test", config: "data" };
            (decodeFunctionData as Mock).mockReturnValue({
                args: [null, { orders: [mockOrderConfig] }],
            });
            mockViemClient.getLogs.mockRejectedValue(new Error("RPC failed"));
            const result = await tryDetectFrontrun(
                mockViemClient,
                mockRawTx,
                mockReceipt,
                "0xOrderbook",
            );
            expect(result).toBeUndefined();
        });
    });
});
