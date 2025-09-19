import { Router } from "sushi";
import { parseUnits } from "viem";
import { fundVault } from "./fundVault";
import { SelfFundVault } from "../config";
import { RainSolverSigner } from "../signer";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("sushi", async (importOriginal) => ({
    ...(await importOriginal()),
    Router: {
        routeProcessor4Params: vi.fn(),
    } as any,
    Native: {
        onChain: vi.fn().mockReturnValue({
            name: "Ethereum",
            symbol: "ETH",
            chainId: 1,
        }),
    },
}));

vi.mock("sushi/tines", async (importOriginal) => ({
    ...(await importOriginal()),
    findMultiRouteExactOut: vi.fn().mockReturnValue({
        amountInBI: parseUnits("1", 18),
        legs: [
            {
                tokenFrom: { symbol: "ETH" },
                tokenTo: { symbol: "TEST" },
                poolAddress: "0xpool",
            },
        ],
    }),
}));

vi.mock("sushi/currency", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        Token: class {
            constructor(args: any) {
                return { ...args };
            }
        },
    };
});

describe("Test fundVault", () => {
    let mockSigner: RainSolverSigner;
    let vaultDetails: SelfFundVault;

    beforeEach(() => {
        vi.clearAllMocks();

        // setup mock signer
        mockSigner = {
            account: {
                address: "0xwallet",
            },
            chain: {
                id: 1,
            },
            state: {
                chainConfig: {
                    id: 1,
                    routeProcessors: {
                        "4": "0xrp4",
                    },
                    nativeWrappedToken: {
                        address: "0xweth",
                        symbol: "WETH",
                    },
                },
                watchedTokens: new Map(),
                watchToken: vi.fn(),
                dataFetcher: {
                    updatePools: vi.fn(),
                    fetchPoolsForToken: vi.fn(),
                    getCurrentPoolCodeMap: vi
                        .fn()
                        .mockReturnValue(new Map([["0xpool", { pool: {}, poolName: "TestPool" }]])),
                },
                gasPrice: parseUnits("20", 9), // 20 gwei
            },
            readContract: vi.fn(),
            writeContract: vi.fn(),
            sendTx: vi.fn(),
            waitForTransactionReceipt: vi.fn(),
        } as any;

        // setup vault details
        vaultDetails = {
            orderbook: "0xorderbook",
            token: "0xtoken",
            vaultId: "1",
            threshold: "100",
            topupAmount: "1000",
        };
    });

    it("should successfully fund vault without gas swap when signer has sufficient token balance", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance below threshold
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("2000", 18)) // sufficient token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // sufficient allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "success" });

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.writeContract as Mock).toHaveBeenCalledWith({
            address: vaultDetails.orderbook,
            abi: expect.any(Array),
            functionName: "deposite2",
            args: [
                vaultDetails.token,
                BigInt(vaultDetails.vaultId),
                parseUnits(vaultDetails.topupAmount, 18),
                [],
            ],
        });
        expect(mockSigner.sendTx as Mock).not.toHaveBeenCalled(); // No swap should occur
    });

    it("should successfully fund vault with gas swap when signer has insufficient token balance", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance below threshold
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("100", 18)) // insufficient token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // sufficient allowance after swap

        vi.mocked(Router.routeProcessor4Params).mockReturnValue({
            data: "0xswapdata",
            amountOutMin: parseUnits("950", 18),
        } as any);

        (mockSigner.sendTx as Mock).mockResolvedValue("0xswap");
        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock)
            .mockResolvedValueOnce({ status: "success" }) // swap receipt
            .mockResolvedValueOnce({ status: "success" }); // deposit receipt

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });

        // verify swap occurred
        expect(mockSigner.sendTx as Mock).toHaveBeenCalledWith({
            to: "0xrp4",
            data: "0xswapdata",
            value: parseUnits("1", 18), // from mocked findMultiRouteExactOut
        });

        // verify deposit occurred
        expect(mockSigner.writeContract as Mock).toHaveBeenCalledWith({
            address: vaultDetails.orderbook,
            abi: expect.any(Array),
            functionName: "deposite2",
            args: [
                vaultDetails.token,
                BigInt(vaultDetails.vaultId),
                parseUnits(vaultDetails.topupAmount, 18),
                [],
            ],
        });

        // verify dataFetcher methods were called for swap preparation
        expect(mockSigner.state.dataFetcher.updatePools).toHaveBeenCalled();
        expect(mockSigner.state.dataFetcher.fetchPoolsForToken).toHaveBeenCalled();
    });

    it("should fetch token details and cache them when not available", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("2000", 18)) // token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "success" });

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.state.watchToken).toHaveBeenCalledWith({
            address: "0xtoken",
            decimals: 18,
            symbol: "TEST",
        });
    });

    it("should use cached token details when available", async () => {
        mockSigner.state.watchedTokens.set("0xtoken", {
            address: "0xtoken",
            decimals: 18,
            symbol: "TEST",
        });

        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(parseUnits("2000", 18)) // token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "success" });

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.readContract as Mock).not.toHaveBeenCalledWith(
            expect.objectContaining({ functionName: "decimals" }),
        );
    });

    it("should handle symbol fetch failure gracefully", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockRejectedValueOnce(new Error("Symbol fetch failed")) // symbol fails
            .mockResolvedValueOnce(parseUnits("2000", 18)) // token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "success" });

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.state.watchToken).toHaveBeenCalledWith(
            expect.objectContaining({ symbol: "UnknownSymbol" }),
        );
    });

    it("should skip deposit if vault balance is above threshold", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("150", 18)) // vault balance above threshold
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST"); // symbol

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toBeUndefined();
        expect(mockSigner.writeContract as Mock).not.toHaveBeenCalled();
    });

    it("should perform swap when token balance is insufficient", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("10", 18)) // insufficient token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // allowance

        vi.mocked(Router.routeProcessor4Params).mockReturnValue({
            data: "0xswapdata",
            amountOutMin: parseUnits("950", 18),
        } as any);

        (mockSigner.sendTx as Mock).mockResolvedValue("0xswap");
        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock)
            .mockResolvedValueOnce({ status: "success" }) // swap
            .mockResolvedValueOnce({ status: "success" }); // deposit

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.sendTx as Mock).toHaveBeenCalledWith(
            expect.objectContaining({ data: "0xswapdata" }),
        );
    });

    it("should throw error when swap transaction reverts", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("10", 18)); // insufficient token balance

        (mockSigner.sendTx as Mock).mockResolvedValue("0xswap");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "reverted" });

        await expect(fundVault(vaultDetails, mockSigner)).rejects.toThrow(
            "Failed to swap gas to target token to acquire the balance needed for depositing into the vault",
        );
    });

    it("should handle approval when needed", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("2000", 18)) // sufficient token balance
            .mockResolvedValueOnce(0n); // zero allowance

        (mockSigner.writeContract as Mock)
            .mockResolvedValueOnce("0xapprove") // approve tx
            .mockResolvedValueOnce("0xdeposit"); // deposit tx

        (mockSigner.waitForTransactionReceipt as Mock)
            .mockResolvedValueOnce({ status: "success" }) // approve
            .mockResolvedValueOnce({ status: "success" }); // deposit

        const result = await fundVault(vaultDetails, mockSigner);

        expect(result).toEqual({ txHash: "0xdeposit" });
        expect(mockSigner.writeContract as Mock).toHaveBeenCalledWith(
            expect.objectContaining({ functionName: "approve" }),
        );
    });

    it("should throw error when approval transaction reverts", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("2000", 18)) // sufficient token balance
            .mockResolvedValueOnce(0n); // zero allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xapprove");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "reverted" });

        await expect(fundVault(vaultDetails, mockSigner)).rejects.toThrow(
            "Failed to approve token spend cap for depositing",
        );
    });

    it("should throw error object when deposit transaction reverts", async () => {
        (mockSigner.readContract as Mock)
            .mockResolvedValueOnce(parseUnits("50", 18)) // vault balance
            .mockResolvedValueOnce(18) // decimals
            .mockResolvedValueOnce("TEST") // symbol
            .mockResolvedValueOnce(parseUnits("2000", 18)) // sufficient token balance
            .mockResolvedValueOnce(parseUnits("2000", 18)); // sufficient allowance

        (mockSigner.writeContract as Mock).mockResolvedValue("0xdeposit");
        (mockSigner.waitForTransactionReceipt as Mock).mockResolvedValue({ status: "reverted" });

        await expect(fundVault(vaultDetails, mockSigner)).rejects.toMatchObject({
            txHash: "0xdeposit",
            error: new Error("Failed to deposit, reason: transaction reverted onchain"),
        });
    });
});
