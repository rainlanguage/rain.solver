import { maxUint256 } from "viem";
import { TokenDetails } from "../common";
import { RainDataFetcher } from "sushi";
import { RainSolverSigner } from "../signer";
import { describe, it, expect, vi, Mock, beforeEach } from "vitest";
import { transferTokenFrom, transferRemainingGasFrom, convertToGas } from "./sweep";

vi.mock("viem", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        encodeFunctionData: vi.fn().mockReturnValue("0xencoded_data"),
    };
});

vi.mock("sushi", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        Router: class {
            static routeProcessor4Params() {
                return { data: "0xdata", amountOutMin: 1000n };
            }
        },
    };
});

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
            state: { appOptions: {} },
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
            state: { appOptions: {} },
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

    describe("Test convertToGas", () => {
        const rp4Address = "0xrp4" as `0x${string}`;
        let mockRouter: RainDataFetcher;
        let mockToken: TokenDetails;

        beforeEach(() => {
            vi.clearAllMocks();
            vi.resetAllMocks();

            // setup mock token
            mockToken = {
                address: "0xtoken" as `0x${string}`,
                symbol: "TEST",
                decimals: 18,
            };

            // setup mock router
            mockRouter = {
                findBestRoute: vi.fn(),
            } as any;

            // setup mock state
            mockFromSigner.state = {
                appOptions: {},
                chainConfig: {
                    id: 1,
                    routeProcessors: {
                        "4": rp4Address,
                    },
                },
                gasPrice: 20000000000n,
                liquidityProviders: ["SushiSwap"],
                router: {
                    sushi: {
                        dataFetcher: mockRouter,
                    },
                },
            } as any;
        });

        it("should return early if token balance is zero", async () => {
            (mockFromSigner.readContract as Mock).mockResolvedValueOnce(0n); // balance check
            const result = await convertToGas(mockFromSigner, mockToken);

            expect(result).toEqual({
                amount: 0n,
                status: "Zero balance",
            });
            expect(mockRouter.findBestRoute).not.toHaveBeenCalled();
        });

        it("should handle allowance approval when needed", async () => {
            // mock balance and allowance checks
            (mockFromSigner.readContract as Mock)
                .mockResolvedValueOnce(1000n) // balance check
                .mockResolvedValueOnce(500n); // allowance check

            // mock approval transaction
            (mockFromSigner.writeContract as Mock).mockResolvedValue("0xapprove");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            // mock route finding with minimal route
            (mockRouter.findBestRoute as Mock).mockResolvedValue({
                pcMap: new Map(),
                route: {
                    legs: [],
                    amountOutBI: 2000n,
                },
            });

            // mock gas estimation to make swap worthwhile
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 10n });

            // mock successful swap
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xswap");

            await convertToGas(mockFromSigner, mockToken);

            // verify approval transaction
            expect(mockFromSigner.writeContract).toHaveBeenCalledWith({
                address: mockToken.address,
                abi: expect.anything(),
                functionName: "approve",
                args: [rp4Address, maxUint256],
            });
        });

        it("should skip swap if cost outweighs benefit", async () => {
            // mock balance and allowance checks
            (mockFromSigner.readContract as Mock)
                .mockResolvedValueOnce(1000n) // balance check
                .mockResolvedValueOnce(1000n); // allowance check (sufficient)

            // mock route finding
            const mockRoute = {
                legs: [
                    {
                        tokenFrom: { symbol: "TEST" },
                        tokenTo: { symbol: "ETH" },
                        poolAddress: "0xpool",
                    },
                ],
                amountOutBI: 100n,
            };
            (mockRouter.findBestRoute as Mock).mockResolvedValue({
                pcMap: new Map(),
                route: mockRoute,
            });

            // mock high gas cost
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 5000n });

            const result = await convertToGas(
                mockFromSigner,
                mockToken,
                2n, // set multiplier to 2 to make sure 50n * 2n > 100n (amountOutBI)
            );

            expect(result.status).toBe(
                "Skipped because balance not large enough to justify swapping to gas",
            );
            expect(result.amount).toBe(1000n);
            expect(result.expectedGasCost).toBe(5000n);
            expect(mockFromSigner.sendTx).not.toHaveBeenCalled();
        });

        it("should successfully swap tokens to gas", async () => {
            // mock balance and allowance checks
            (mockFromSigner.readContract as Mock)
                .mockResolvedValueOnce(1000n) // balance check
                .mockResolvedValueOnce(1000n); // allowance check (sufficient)

            // mock route finding
            const mockRoute = {
                legs: [
                    {
                        tokenFrom: { symbol: "TEST" },
                        tokenTo: { symbol: "ETH" },
                        poolAddress: "0xpool",
                        poolName: "SushiSwap",
                    },
                ],
                amountOutBI: 1000n,
            };
            (mockRouter.findBestRoute as Mock).mockResolvedValue({
                pcMap: new Map(),
                route: mockRoute,
            });

            // mock low gas cost
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 10n });

            // mock successful swap
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xswap");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const result = await convertToGas(mockFromSigner, mockToken);

            expect(result.status).toBe("Successfully swapped");
            expect(result.txHash).toBe("0xswap");
            expect(result.amount).toBe(1000n);
            expect(result.receivedAmount).toBe(1000n);
            expect(result.route).toContain("ETH/TEST(SushiSwap 0xpool)");
        });

        it("should handle failed swap transaction", async () => {
            // mock balance and allowance checks
            (mockFromSigner.readContract as Mock)
                .mockResolvedValueOnce(1000n) // balance check
                .mockResolvedValueOnce(1000n); // allowance check (sufficient)

            // mock route finding
            const mockRoute = {
                legs: [
                    {
                        tokenFrom: { symbol: "TEST" },
                        tokenTo: { symbol: "ETH" },
                        poolAddress: "0xpool",
                    },
                ],
                amountOutBI: 1000n,
            };
            (mockRouter.findBestRoute as Mock).mockResolvedValue({
                pcMap: new Map(),
                route: mockRoute,
            });

            // mock low gas cost
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 10n });

            // mock failed swap
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xfailed");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "reverted",
            });

            await expect(convertToGas(mockFromSigner, mockToken)).rejects.toMatchObject({
                txHash: "0xfailed",
                error: new Error(
                    "Failed to swap token to gas, reason: transaction reverted onchain",
                ),
            });
        });

        it("should use custom swap cost multiplier correctly", async () => {
            // mock balance and allowance checks
            (mockFromSigner.readContract as Mock)
                .mockResolvedValueOnce(1000n) // balance check
                .mockResolvedValueOnce(1000n); // allowance check (sufficient)

            // mock route finding
            const mockRoute = {
                legs: [
                    {
                        tokenFrom: { symbol: "TEST" },
                        tokenTo: { symbol: "ETH" },
                        poolAddress: "0xpool",
                    },
                ],
                amountOutBI: 500n,
            };
            (mockRouter.findBestRoute as Mock).mockResolvedValue({
                pcMap: new Map(),
                route: mockRoute,
            });

            // mock gas cost
            // with multiplier of 4, if totalGasCost (100n) * 4 < amountOutMin (500n), execute swap
            (mockFromSigner.estimateGasCost as Mock).mockResolvedValue({ totalGasCost: 100n });

            // mock successful swap
            (mockFromSigner.sendTx as Mock).mockResolvedValue("0xswap");
            (mockFromSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const result = await convertToGas(
                mockFromSigner,
                mockToken,
                4n, // set multiplier to 4: 100n * 4n < 500n (amountOutBI), so swap should execute
            );

            expect(result.status).toBe("Successfully swapped");
            expect(result.txHash).toBe("0xswap");
            expect(result.expectedGasCost).toBe(100n);
            expect(result.receivedAmount).toBe(500n);
        });
    });
});
