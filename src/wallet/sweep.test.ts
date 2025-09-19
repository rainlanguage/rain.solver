import { TokenDetails } from "../state";
import { RainSolverSigner } from "../signer";
import { PreAssembledSpan } from "../logger";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, expect, vi, Mock, beforeEach } from "vitest";
import { transferTokenFrom, transferRemainingGasFrom } from "./sweep";

vi.mock("viem", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        encodeFunctionData: vi.fn().mockReturnValue("0xencodedData"),
    };
});

describe("Test sweep functions", () => {
    let mockFromSigner: RainSolverSigner;
    let mockToSigner: RainSolverSigner;
    let mockToken: TokenDetails;

    beforeEach(() => {
        // reset all mocks
        vi.clearAllMocks();
        vi.resetAllMocks();

        // setup mock token
        mockToken = {
            address: "0xtoken" as `0x${string}`,
            symbol: "TEST",
            decimals: 18,
        };

        // setup mock from signer
        mockFromSigner = {
            account: { address: "0xfrom" },
            readContract: vi.fn(),
            writeContract: vi.fn(),
            getSelfBalance: vi.fn(),
            estimateGasCost: vi.fn(),
            waitForTransactionReceipt: vi.fn(),
            sendTx: vi.fn(),
        } as any;

        // setup mock to signer
        mockToSigner = {
            account: { address: "0xto" },
            readContract: vi.fn(),
            writeContract: vi.fn(),
            getSelfBalance: vi.fn(),
            estimateGasCost: vi.fn(),
            waitForTransactionReceipt: vi.fn(),
            sendTx: vi.fn(),
        } as any;
    });

    describe("Test transferTokenFrom", () => {
        it("should return early if token balance is zero", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValue(0n);

            const result = await transferTokenFrom(mockFromSigner, mockToSigner, mockToken);

            expect(result).toEqual({ amount: 0n });
            expect(mockFromSigner.writeContract).not.toHaveBeenCalled();
        });

        it("should fund wallet if gas balance is insufficient", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValue(100n);
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(50n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });
            (mockToSigner.sendTx as Mock).mockResolvedValue("0xhash");
            (mockToSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });
            (mockFromSigner.writeContract as Mock).mockResolvedValue("0xtransferhash");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const result = await transferTokenFrom(mockFromSigner, mockToSigner, mockToken);

            expect(mockToSigner.sendTx).toHaveBeenCalledWith({
                to: mockFromSigner.account.address,
                value: 110n, // 110% of gas cost
            });
            expect(result).toEqual({ amount: 100n, txHash: "0xtransferhash" });
        });

        it("should handle funding failure", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValue(100n);
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(50n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });
            (mockToSigner.sendTx as Mock).mockResolvedValue("0xhash");
            (mockToSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "reverted",
            });

            await expect(
                transferTokenFrom(mockFromSigner, mockToSigner, mockToken),
            ).rejects.toMatchObject({
                txHash: "0xhash",
                error: new Error(
                    "Failed to fund the wallet to transfer tokens, reason: transaction reverted onchain",
                ),
            });
        });

        it("should successfully transfer tokens", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValue(100n);
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(1000n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 50n });
            (mockFromSigner.writeContract as Mock).mockResolvedValue("0xhash");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const result = await transferTokenFrom(mockFromSigner, mockToSigner, mockToken);

            expect(result).toEqual({ amount: 100n, txHash: "0xhash" });
            expect(mockFromSigner.writeContract).toHaveBeenCalledWith({
                address: mockToken.address,
                abi: expect.any(Array),
                functionName: "transfer",
                args: [mockToSigner.account.address, 100n],
            });
        });

        it("should handle failed transfer transaction", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValue(100n);
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(1000n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 50n });
            (mockFromSigner.writeContract as Mock).mockResolvedValue("0xhash");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "reverted",
            });

            await expect(
                transferTokenFrom(mockFromSigner, mockToSigner, mockToken),
            ).rejects.toMatchObject({
                txHash: "0xhash",
                error: new Error("Failed to transfer tokens, reason: transaction reverted onchain"),
            });
        });
    });

    describe("Test transferRemainingGasFrom", () => {
        const toAddress = "0xto" as `0x${string}`;

        it("should return early if gas balance is zero", async () => {
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(0n);

            const result = await transferRemainingGasFrom(mockFromSigner, toAddress);

            expect(result).toEqual({ amount: 0n });
            expect(mockFromSigner.sendTx).not.toHaveBeenCalled();
        });

        it("should return early if balance is less than gas cost", async () => {
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(50n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });

            const result = await transferRemainingGasFrom(mockFromSigner, toAddress);

            expect(result).toEqual({ amount: 0n });
            expect(mockFromSigner.sendTx).not.toHaveBeenCalled();
        });

        it("should successfully transfer remaining gas", async () => {
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(1000n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xhash");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const result = await transferRemainingGasFrom(mockFromSigner, toAddress);

            // With 1000n balance and 100n gas cost, total cost is 102n (102%), remaining is 898n
            expect(result).toMatchObject({
                txHash: "0xhash",
                amount: 898n,
            });
            expect(mockFromSigner.sendTx).toHaveBeenCalledWith({
                to: toAddress,
                value: 898n,
            });
        });

        it("should handle failed gas transfer transaction", async () => {
            (mockFromSigner.getSelfBalance as Mock).mockResolvedValue(1000n);
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xhash");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "reverted",
            });

            await expect(transferRemainingGasFrom(mockFromSigner, toAddress)).rejects.toMatchObject(
                {
                    txHash: "0xhash",
                    error: new Error(
                        "Failed to transfer remaining gas, reason: transaction reverted onchain",
                    ),
                },
            );
        });
    });
});
