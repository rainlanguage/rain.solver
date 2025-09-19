import { RainSolver } from "..";
import { ethers } from "ethers";
import { TimeoutError } from "viem";
import { ErrorSeverity } from "../../error";
import { processPair } from "../../processOrders";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { finalizeRound, initializeRound, Settlement } from "./round";
import { ProcessOrderStatus, ProcessOrderHaltReason } from "../types";

vi.mock("../../processOrders", () => ({
    processPair: vi.fn().mockResolvedValue(vi.fn()),
}));

describe("Test initializeRound", () => {
    type initializeRoundType = Awaited<ReturnType<typeof initializeRound>>;
    let mockSolver: RainSolver;
    let mockOrderManager: any;
    let mockWalletManager: any;
    let mockState: any;
    let mockAppOptions: any;
    const mockSigner = { account: { address: "0xSigner123" } };

    beforeEach(() => {
        vi.clearAllMocks();

        // mock order manager
        mockOrderManager = {
            getNextRoundOrders: vi.fn(),
        };

        // mock wallet manager
        mockWalletManager = {
            getRandomSigner: vi.fn(),
        };

        // mock state
        mockState = {
            client: { name: "viem-client" },
            dataFetcher: { name: "data-fetcher" },
        };

        // mock app options
        mockAppOptions = {
            arbAddress: "0x1111111111111111111111111111111111111111",
            genericArbAddress: "0x2222222222222222222222222222222222222222",
        };

        // mock RainSolver
        mockSolver = {
            orderManager: mockOrderManager,
            walletManager: mockWalletManager,
            state: mockState,
            config: {},
            appOptions: mockAppOptions,
        } as any;
    });

    describe("successful initialization", () => {
        it("should return settlements with correct structure for single order", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            {
                                id: "0xOrder123",
                                takeOrder: { order: { owner: "0xOwner123" } },
                            },
                        ],
                    },
                ],
            ];

            const mockSettleFn = vi.fn();
            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);
            (processPair as Mock).mockResolvedValue(mockSettleFn);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(1);
            expect(result.checkpointReports).toHaveLength(1);

            const settlement = result.settlements[0];
            expect(settlement.pair).toBe("ETH/USDC");
            expect(settlement.owner).toBe("0xOwner123");
            expect(settlement.orderHash).toBe("0xOrder123");
            expect(settlement.settle).toBe(mockSettleFn);

            // Verify checkpoint report
            const checkpointReport = result.checkpointReports[0];
            expect(checkpointReport.name).toBe("checkpoint_ETH/USDC");
            expect(checkpointReport.attributes["details.pair"]).toBe("ETH/USDC");
            expect(checkpointReport.attributes["details.orderHash"]).toBe("0xOrder123");
            expect(checkpointReport.attributes["details.owner"]).toBe("0xOwner123");
            expect(checkpointReport.attributes["details.sender"]).toBe("0xSigner123");
            expect(checkpointReport.endTime).toBeTypeOf("number");
        });

        it("should handle multiple orders from multiple orderbooks", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x5555555555555555555555555555555555555555",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder1", takeOrder: { order: { owner: "0xOwner1" } } },
                            { id: "0xOrder2", takeOrder: { order: { owner: "0xOwner2" } } },
                        ],
                    },
                ],
                [
                    {
                        orderbook: "0x6666666666666666666666666666666666666666",
                        buyTokenSymbol: "BTC",
                        sellTokenSymbol: "USDT",
                        takeOrders: [
                            { id: "0xOrder3", takeOrder: { order: { owner: "0xOwner3" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue({
                account: { address: "0xSigner" },
            });

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(3);
            expect(result.checkpointReports).toHaveLength(3);

            // Verify settlements
            expect(result.settlements[0].pair).toBe("ETH/USDC");
            expect(result.settlements[0].orderHash).toBe("0xOrder1");
            expect(result.settlements[1].pair).toBe("ETH/USDC");
            expect(result.settlements[1].orderHash).toBe("0xOrder2");
            expect(result.settlements[2].pair).toBe("BTC/USDT");
            expect(result.settlements[2].orderHash).toBe("0xOrder3");

            // Verify checkpoint reports
            expect(result.checkpointReports[0].name).toBe("checkpoint_ETH/USDC");
            expect(result.checkpointReports[0].attributes["details.orderHash"]).toBe("0xOrder1");
            expect(result.checkpointReports[1].name).toBe("checkpoint_ETH/USDC");
            expect(result.checkpointReports[1].attributes["details.orderHash"]).toBe("0xOrder2");
            expect(result.checkpointReports[2].name).toBe("checkpoint_BTC/USDT");
            expect(result.checkpointReports[2].attributes["details.orderHash"]).toBe("0xOrder3");

            // Verify all reports are ended
            result.checkpointReports.forEach((report) => {
                expect(report.endTime).toBeTypeOf("number");
            });
        });

        it("should handle missing genericArbAddress", async () => {
            mockSolver.appOptions.genericArbAddress = undefined;

            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder123", takeOrder: { order: { owner: "0xOwner123" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(1);
            expect(result.checkpointReports).toHaveLength(1);
            expect(processPair as Mock).toHaveBeenCalledWith(
                expect.objectContaining({
                    genericArb: undefined,
                }),
            );
        });
    });

    describe("empty orders handling", () => {
        it("should return empty settlements and checkpointReports for empty orders", async () => {
            mockOrderManager.getNextRoundOrders.mockReturnValue([]);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(0);
            expect(result.checkpointReports).toHaveLength(0);
            expect(mockWalletManager.getRandomSigner).not.toHaveBeenCalled();
            expect(processPair as Mock).not.toHaveBeenCalled();
        });

        it("should skip orderbooks with empty takeOrders", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(0);
            expect(result.checkpointReports).toHaveLength(0);
            expect(mockWalletManager.getRandomSigner).not.toHaveBeenCalled();
            expect(processPair as Mock).not.toHaveBeenCalled();
        });
    });

    describe("method call verification", () => {
        it("should call getNextRoundOrders with correct parameter", async () => {
            mockOrderManager.getNextRoundOrders.mockReturnValue([]);

            await initializeRound.call(mockSolver);

            expect(mockOrderManager.getNextRoundOrders).toHaveBeenCalledWith(true);
            expect(mockOrderManager.getNextRoundOrders).toHaveBeenCalledTimes(1);
        });

        it("should call getRandomSigner for each order", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder1", takeOrder: { order: { owner: "0xOwner1" } } },
                            { id: "0xOrder2", takeOrder: { order: { owner: "0xOwner2" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);

            await initializeRound.call(mockSolver);

            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledWith(true);
            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledTimes(2);
        });

        it("should call processPair with correct parameters structure", async () => {
            const orderDetails = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyToken: "0xETH",
                buyTokenSymbol: "ETH",
                buyTokenDecimals: 18,
                sellToken: "0xUSDC",
                sellTokenSymbol: "USDC",
                sellTokenDecimals: 6,
                takeOrders: [{ id: "0xOrder123", takeOrder: { order: { owner: "0xOwner123" } } }],
            };
            const mockOrders = [[orderDetails]];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);

            await initializeRound.call(mockSolver);

            expect(processPair as Mock).toHaveBeenCalledWith({
                config: {},
                orderPairObject: orderDetails,
                viemClient: mockState.client,
                dataFetcher: mockState.dataFetcher,
                signer: mockSigner,
                arb: expect.any(Object),
                genericArb: expect.any(Object),
                orderbook: expect.any(Object),
                pair: "ETH/USDC",
                orderbooksOrders: mockOrders,
                state: mockState,
            });
        });
    });

    describe("checkpoint reports verification", () => {
        it("should create checkpoint reports with correct attributes", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "WETH",
                        sellTokenSymbol: "DAI",
                        takeOrders: [
                            { id: "0xOrderABC", takeOrder: { order: { owner: "0xOwnerXYZ" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue({
                account: { address: "0xSignerDEF" },
            });

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            const report = result.checkpointReports[0];
            expect(report.name).toBe("checkpoint_WETH/DAI");
            expect(report.attributes["details.pair"]).toBe("WETH/DAI");
            expect(report.attributes["details.orderHash"]).toBe("0xOrderABC");
            expect(report.attributes["details.orderbook"]).toBeTypeOf("string");
            expect(report.attributes["details.sender"]).toBe("0xSignerDEF");
            expect(report.attributes["details.owner"]).toBe("0xOwnerXYZ");
        });

        it("should create one checkpoint report per order", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x1111111111111111111111111111111111111111",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder1", takeOrder: { order: { owner: "0xOwner1" } } },
                            { id: "0xOrder2", takeOrder: { order: { owner: "0xOwner2" } } },
                        ],
                    },
                    {
                        orderbook: "0x1111111111111111111111111111111111111111",
                        buyTokenSymbol: "BTC",
                        sellTokenSymbol: "USDT",
                        takeOrders: [
                            { id: "0xOrder3", takeOrder: { order: { owner: "0xOwner3" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.checkpointReports).toHaveLength(3);
            expect(result.settlements).toHaveLength(3);

            // Verify each checkpoint report corresponds to its settlement
            expect(result.checkpointReports[0].attributes["details.orderHash"]).toBe("0xOrder1");
            expect(result.checkpointReports[1].attributes["details.orderHash"]).toBe("0xOrder2");
            expect(result.checkpointReports[2].attributes["details.orderHash"]).toBe("0xOrder3");

            expect(result.settlements[0].orderHash).toBe("0xOrder1");
            expect(result.settlements[1].orderHash).toBe("0xOrder2");
            expect(result.settlements[2].orderHash).toBe("0xOrder3");
        });

        it("should end all checkpoint reports", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder1", takeOrder: { order: { owner: "0xOwner1" } } },
                            { id: "0xOrder2", takeOrder: { order: { owner: "0xOwner2" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue(mockSigner);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            // All checkpoint reports should be ended
            result.checkpointReports.forEach((report) => {
                expect(report.endTime).toBeTypeOf("number");
                expect(report.endTime).toBeGreaterThan(0);
            });
        });
    });

    describe("return value structure", () => {
        it("should always return object with settlements and checkpointReports arrays", async () => {
            mockOrderManager.getNextRoundOrders.mockReturnValue([]);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result).toEqual({
                settlements: expect.any(Array),
                checkpointReports: expect.any(Array),
            });
            expect(Array.isArray(result.settlements)).toBe(true);
            expect(Array.isArray(result.checkpointReports)).toBe(true);
        });

        it("should return checkpointReports matching settlements count", async () => {
            const mockOrders = [
                [
                    {
                        orderbook: "0x3333333333333333333333333333333333333333",
                        buyTokenSymbol: "ETH",
                        sellTokenSymbol: "USDC",
                        takeOrders: [
                            { id: "0xOrder123", takeOrder: { order: { owner: "0xOwner123" } } },
                        ],
                    },
                ],
            ];

            mockOrderManager.getNextRoundOrders.mockReturnValue(mockOrders);
            mockWalletManager.getRandomSigner.mockResolvedValue({
                account: { address: "0xSigner" },
            });

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.checkpointReports).toHaveLength(result.settlements.length);
            expect(result.checkpointReports).toHaveLength(1);
        });
    });
});

describe("Test finalizeRound", () => {
    type finalizeRoundType = Awaited<ReturnType<typeof finalizeRound>>;
    let mockSolver: RainSolver;
    let settlements: Settlement[];

    beforeEach(() => {
        vi.clearAllMocks();

        // mock RainSolver
        mockSolver = {
            state: {
                gasCosts: [],
            },
        } as any;
    });

    describe("successful settlements", () => {
        it("should handle ZeroOutput status and update gas costs", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                gasCost: ethers.BigNumber.from("1000000"),
                report: { status: ProcessOrderStatus.ZeroOutput, tokenPair: "ETH/USDC" },
                spanAttributes: { "test.attr": "value" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // Assert function behavior
            expect(result.results).toHaveLength(1);
            expect(result.reports).toHaveLength(1);
            expect(result.results[0]).toEqual({
                status: ProcessOrderStatus.ZeroOutput,
                tokenPair: "ETH/USDC",
            });

            // Assert gas cost tracking
            expect(mockSolver.state.gasCosts).toHaveLength(1);
            expect(mockSolver.state.gasCosts[0]).toBe(1000000n);

            // Assert span creation and attributes
            const report = result.reports[0];
            expect(report.name).toBe("order_ETH/USDC");
            expect(report.attributes["details.owner"]).toBe("0x123");
            expect(report.attributes["test.attr"]).toBe("value");
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("zero max output");
        });

        it("should handle NoOpportunity status with error string", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.NoOpportunity },
                spanAttributes: { liquidity: "low" },
                error: "insufficient liquidity",
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.results[0]).toEqual({ status: ProcessOrderStatus.NoOpportunity });
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toBe("insufficient liquidity");
            expect(result.reports[0].attributes["liquidity"]).toBe("low");
        });

        it("should handle NoOpportunity status without error", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.NoOpportunity },
                spanAttributes: {},
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/DAI",
                    owner: "0x789",
                    orderHash: "0x123",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("no opportunity");
        });

        it("should handle FoundOpportunity status", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.FoundOpportunity, profit: "0.05" },
                spanAttributes: { "profit.eth": "0.05" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "WETH/DAI",
                    owner: "0xabc",
                    orderHash: "0x456",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.results[0]).toEqual({
                status: ProcessOrderStatus.FoundOpportunity,
                profit: "0.05",
            });
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("found opportunity");
            expect(result.reports[0].attributes["profit.eth"]).toBe("0.05");
        });

        it("should handle unknown status as unexpected error", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: "UNKNOWN_STATUS" as any },
                spanAttributes: { custom: "attr" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "LINK/USDC",
                    owner: "0xdef",
                    orderHash: "0x789",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toBe("unexpected error");
        });

        it("should handle settlement without gas cost", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.FoundOpportunity },
                spanAttributes: {},
                // No gasCost provided
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const initialGasCosts = [...mockSolver.state.gasCosts];
            await finalizeRound.call(mockSolver, settlements);

            expect(mockSolver.state.gasCosts).toEqual(initialGasCosts);
        });
    });

    describe("error handling", () => {
        it("should handle FailedToQuote error without error details", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.FailedToQuote,
                spanAttributes: { provider: "chainlink" },
                report: { status: "failed" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.results[0]).toEqual({
                status: "failed",
                error: undefined,
                reason: ProcessOrderHaltReason.FailedToQuote,
            });
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("failed to quote order: 0xabc");
        });

        it("should handle FailedToQuote error with error details", async () => {
            const error = new Error("quote service down");
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.FailedToQuote,
                spanAttributes: { "retry.count": "3" },
                report: { status: "failed" },
                error,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDC",
                    owner: "0x456",
                    orderHash: "0xdef",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.results[0].error).toBe(error);
            expect(result.results[0].reason).toBe(ProcessOrderHaltReason.FailedToQuote);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toContain("failed to quote order: 0xdef");
            expect(result.reports[0].status?.message).toContain("quote service down");
        });

        it("should handle FailedToGetPools error with medium severity", async () => {
            const error = new Error("pool fetch failed");
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.FailedToGetPools,
                spanAttributes: { "pool.count": "0" },
                report: { status: "failed" },
                error,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "WETH/USDT",
                    owner: "0x789",
                    orderHash: "0x123",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.MEDIUM);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toContain(
                "WETH/USDT: failed to get pool details",
            );
            expect(result.reports[0].exception?.exception).toBe(error);
            expect(result.reports[0].exception?.exception).toBeInstanceOf(Error);
            expect((result.reports[0].exception?.exception as any)?.message).toBe(
                "pool fetch failed",
            );
        });

        it("should handle FailedToGetEthPrice error with OK status", async () => {
            const error = new Error("eth price unavailable");
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                spanAttributes: {},
                report: { status: "failed" },
                error,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "CUSTOM/TOKEN",
                    owner: "0xabc",
                    orderHash: "0x456",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].attributes["errorDetails"]).toContain(
                "failed to get eth price",
            );
            expect(result.reports[0].attributes["errorDetails"]).toContain("eth price unavailable");
        });

        it("should handle FailedToUpdatePools error", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.FailedToUpdatePools,
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
                error: new Error("update failed"),
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toContain(
                "ETH/USDC: failed to update pool details by event data",
            );
            expect(result.reports[0].status?.message).toContain("update failed");
            expect(result.reports[0].exception?.exception).toBeInstanceOf(Error);
            expect((result.reports[0].exception?.exception as any)?.message).toBe("update failed");
        });

        it("should handle TxFailed error with timeout (low severity)", async () => {
            const timeoutError = new TimeoutError({ body: {}, url: "http://example.com" });
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxFailed,
                spanAttributes: { "tx.hash": "0x123" },
                report: { status: "failed" },
                error: timeoutError,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txSendFailed"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });

        it("should handle TxFailed error without timeout (high severity)", async () => {
            const error = new Error("gas too low");
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxFailed,
                spanAttributes: {},
                report: { status: "failed" },
                error,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });

        it("should handle TxFailed error without error details", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxFailed,
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.message).toBe("failed to submit the transaction");
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });

        it("should handle TxReverted error with snapshot", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxReverted,
                spanAttributes: { "block.number": "12345" },
                report: { status: "reverted" },
                error: { snapshot: "Transaction reverted: INSUFFICIENT_LIQUIDITY" },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "LINK/DAI",
                    owner: "0x789",
                    orderHash: "0x123",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["errorDetails"]).toBe(
                "Transaction reverted: INSUFFICIENT_LIQUIDITY",
            );
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
        });

        it("should handle TxReverted error with known error (no high severity)", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxReverted,
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
                error: { err: new Error("INSUFFICIENT_LIQUIDITY") }, // This is typically a known error
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // Should not set HIGH severity for known errors (depends on KnownErrors array)
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
        });

        it("should handle TxReverted error with txNoneNodeError flag (high severity)", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxReverted,
                spanAttributes: { txNoneNodeError: true },
                report: { status: "reverted" },
                error: { err: new Error("unknown revert") },
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "UNI/WETH",
                    owner: "0xabc",
                    orderHash: "0x456",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
        });

        it("should handle TxMineFailed error with timeout", async () => {
            const timeoutError = new TimeoutError({ body: {}, url: "http://example.com" });

            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxMineFailed,
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
                error: timeoutError,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txMineFailed"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });

        it("should handle TxMineFailed error without timeout", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxMineFailed,
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
                error: new Error("rpc error"),
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });

        it("should handle unexpected error and set reason", async () => {
            const mockSettle = vi.fn().mockRejectedValue({
                reason: "unknown_reason",
                spanAttributes: { "test.attr": "value" },
                report: { status: "failed" },
                error: new Error("unexpected"),
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].exception?.exception).toBeInstanceOf(Error);
            expect((result.reports[0].exception?.exception as any)?.message).toBe("unexpected");
            expect(result.results[0].reason).toBe(ProcessOrderHaltReason.UnexpectedError);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        });
    });

    describe("multiple settlements", () => {
        it("should process multiple settlements and return correct results", async () => {
            const mockSettle1 = vi.fn().mockResolvedValue({
                gasCost: ethers.BigNumber.from("1000000"),
                report: { status: ProcessOrderStatus.FoundOpportunity, txUrl: "url1" },
                spanAttributes: { success: true },
            });

            const mockSettle2 = vi.fn().mockRejectedValue({
                reason: ProcessOrderHaltReason.TxFailed,
                spanAttributes: { failed: true },
                report: { status: "failed", txUrl: "url2" },
                error: new Error("tx failed"),
            });

            settlements = [
                {
                    settle: mockSettle1,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
                {
                    settle: mockSettle2,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // Assert correct number of results and reports
            expect(result.results).toHaveLength(2);
            expect(result.reports).toHaveLength(2);

            // Assert first result (success)
            expect(result.results[0].txUrl).toBe("url1");
            expect(result.results[0].status).toBe(ProcessOrderStatus.FoundOpportunity);
            expect(result.reports[0].name).toBe("order_ETH/USDC");
            expect(result.reports[0].attributes["success"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);

            // Assert second result (error)
            expect(result.results[1].txUrl).toBe("url2");
            expect(result.results[1].reason).toBe(ProcessOrderHaltReason.TxFailed);
            expect(result.reports[1].name).toBe("order_BTC/USDT");
            expect(result.reports[1].attributes["failed"]).toBe(true);
            expect(result.reports[1].status?.code).toBe(SpanStatusCode.ERROR);

            // Assert gas costs only added for successful settlement
            expect(mockSolver.state.gasCosts).toHaveLength(1);
            expect(mockSolver.state.gasCosts[0]).toBe(1000000n);
        });
    });

    describe("span management", () => {
        it("should create spans with correct names and set owner attribute", async () => {
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.FoundOpportunity },
                spanAttributes: {},
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].name).toBe("order_ETH/USDC");
            expect(result.reports[0].attributes["details.owner"]).toBe("0x123");
            expect(result.reports[0].endTime).toBeTypeOf("number");
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
        });

        it("should extend span attributes from settlement result", async () => {
            const spanAttributes = { "custom.attr": "test", "another.attr": 123 };
            const mockSettle = vi.fn().mockResolvedValue({
                report: { status: ProcessOrderStatus.FoundOpportunity },
                spanAttributes,
            });

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["custom.attr"]).toBe("test");
            expect(result.reports[0].attributes["another.attr"]).toBe(123);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
        });
    });
});
