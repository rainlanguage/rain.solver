import { RainSolver } from "..";
import { TimeoutError } from "viem";
import { Dispair, Result } from "../../common";
import { SharedState } from "../../state";
import { AppOptions } from "../../config";
import { Order, OrderManager } from "../../order";
import { ErrorSeverity } from "../../error";
import { WalletManager } from "../../wallet";
import { SpanStatusCode } from "@opentelemetry/api";
import { PreAssembledSpan, RainSolverLogger } from "../../logger";
import { ProcessOrderStatus, ProcessOrderHaltReason } from "../types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    iterOrders,
    Settlement,
    prepareRouter,
    finalizeRound,
    initializeRound,
    processOrderInit,
} from "./round";

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

describe("Test initializeRound", () => {
    type initializeRoundType = Awaited<ReturnType<typeof initializeRound>>;
    let mockSolver: RainSolver;
    let mockOrderManager: OrderManager;
    let mockWalletManager: WalletManager;
    let mockState: SharedState;
    let mockAppOptions: AppOptions;
    let dispair: Dispair;
    let destination: `0x${string}`;
    const mockSigner = { account: { address: "0xSigner123" } };

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";

        // mock order manager
        mockOrderManager = {
            getNextRoundOrders: vi.fn(),
            ownerTokenVaultMap: new Map(),
        } as any;

        // mock wallet manager
        mockWalletManager = {
            getRandomSigner: vi.fn(),
        } as any;

        // mock state
        mockState = {
            chainConfig: { id: 1 },
            client: {
                name: "viem-client",
                getBlockNumber: vi.fn().mockResolvedValue(123n),
            },
            contracts: {
                getAddressesForTrade: vi.fn().mockReturnValue({
                    dispair,
                    destination,
                }),
            },
            router: {
                sushi: { update: vi.fn().mockResolvedValue(undefined) },
                cache: new Map(),
            },
            getMarketPrice: vi.fn().mockResolvedValue(null),
        } as any;

        // mock app options
        mockAppOptions = {} as any;

        // mock RainSolver
        mockSolver = {
            orderManager: mockOrderManager,
            walletManager: mockWalletManager,
            state: mockState,
            appOptions: mockAppOptions,
            processOrder: vi.fn(),
        } as any;
    });

    describe("successful initialization", () => {
        it("should return settlements with correct structure for single order", async () => {
            const mockOrders = [
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken",
                    buyToken: "0xbuyToken",
                    takeOrder: {
                        id: "0xOrder123",
                        struct: { order: { owner: "0xOwner123" } },
                    },
                },
            ];

            const mockSettleFn = vi.fn();
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            (mockSolver.processOrder as Mock).mockResolvedValue(mockSettleFn);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(1);
            expect(result.checkpointReports).toHaveLength(1);

            const settlement = result.settlements[0];
            expect(settlement.pair).toBe("ETH/USDC");
            expect(settlement.owner).toBe("0xowner123");
            expect(settlement.orderHash).toBe("0xOrder123");
            expect(settlement.startTime).toBeTypeOf("number");
            expect(settlement.settle).toBe(mockSettleFn);

            // Verify checkpoint report
            const checkpointReport = result.checkpointReports[0];
            expect(checkpointReport.name).toBe("checkpoint_ETH/USDC");
            expect(checkpointReport.attributes["details.pair"]).toBe("ETH/USDC");
            expect(checkpointReport.attributes["details.orderHash"]).toBe("0xOrder123");
            expect(checkpointReport.attributes["details.owner"]).toBe("0xowner123");
            expect(checkpointReport.attributes["details.sender"]).toBe("0xSigner123");
            expect(checkpointReport.endTime).toBeTypeOf("number");
        });

        it("should handle multiple orders from multiple orderbooks", async () => {
            const mockOrders = [
                {
                    orderbook: "0x5555555555555555555555555555555555555555",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken1",
                    buyToken: "0xbuyToken1",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
                {
                    orderbook: "0x5555555555555555555555555555555555555555",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken2",
                    buyToken: "0xbuyToken2",
                    takeOrder: { id: "0xOrder2", struct: { order: { owner: "0xOwner2" } } },
                },
                {
                    orderbook: "0x6666666666666666666666666666666666666666",
                    buyTokenSymbol: "BTC",
                    sellTokenSymbol: "USDT",
                    sellToken: "0xsellToken3",
                    buyToken: "0xbuyToken3",
                    takeOrder: { id: "0xOrder3", struct: { order: { owner: "0xOwner3" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue({
                account: { address: "0xSigner" },
            });

            const result: initializeRoundType = await initializeRound.call(
                mockSolver,
                undefined,
                false,
            );

            expect(result.settlements).toHaveLength(3);
            expect(result.checkpointReports).toHaveLength(3);

            // Verify settlements
            expect(result.settlements[0].pair).toBe("ETH/USDC");
            expect(result.settlements[0].orderHash).toBe("0xOrder1");
            expect(result.settlements[0].startTime).toBeTypeOf("number");
            expect(result.settlements[1].pair).toBe("ETH/USDC");
            expect(result.settlements[1].orderHash).toBe("0xOrder2");
            expect(result.settlements[1].startTime).toBeTypeOf("number");
            expect(result.settlements[2].pair).toBe("BTC/USDT");
            expect(result.settlements[2].orderHash).toBe("0xOrder3");
            expect(result.settlements[2].startTime).toBeTypeOf("number");

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
    });

    describe("empty orders handling", () => {
        it("should return empty settlements and checkpointReports for empty orders", async () => {
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue([]);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.settlements).toHaveLength(0);
            expect(result.checkpointReports).toHaveLength(0);
            expect(mockWalletManager.getRandomSigner).not.toHaveBeenCalled();
            expect(mockSolver.processOrder).not.toHaveBeenCalled();
        });
    });

    describe("method call verification", () => {
        it("should call getNextRoundOrders with correct parameter", async () => {
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue([]);

            await initializeRound.call(mockSolver, undefined, false);

            expect(mockOrderManager.getNextRoundOrders).toHaveBeenCalledOnce();
        });

        it("should call getRandomSigner for each order", async () => {
            const mockOrders = [
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken1",
                    buyToken: "0xbuyToken1",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken2",
                    buyToken: "0xbuyToken2",
                    takeOrder: { id: "0xOrder2", struct: { order: { owner: "0xOwner2" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            await initializeRound.call(mockSolver);

            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledWith(true);
            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledTimes(2);
        });

        it("should call processOrder with correct parameters structure", async () => {
            const orderDetails = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyToken: "0xETH",
                buyTokenSymbol: "ETH",
                buyTokenDecimals: 18,
                sellToken: "0xUSDC",
                sellTokenSymbol: "USDC",
                sellTokenDecimals: 6,
                takeOrder: { id: "0xOrder123", struct: { order: { owner: "0xOwner123" } } },
            };
            const mockOrders = [orderDetails];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            await initializeRound.call(mockSolver);

            expect(mockSolver.processOrder).toHaveBeenCalledWith({
                orderDetails,
                signer: mockSigner,
                blockNumber: 123n,
            });
        });
    });

    describe("checkpoint reports verification", () => {
        it("should create checkpoint reports with correct attributes", async () => {
            const mockOrders = [
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "WETH",
                    sellTokenSymbol: "DAI",
                    sellToken: "0xsellToken",
                    buyToken: "0xbuyToken",
                    takeOrder: { id: "0xOrderABC", struct: { order: { owner: "0xOwnerXYZ" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue({
                account: { address: "0xSignerDEF" },
            });

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            const report = result.checkpointReports[0];
            expect(report.name).toBe("checkpoint_WETH/DAI");
            expect(report.attributes["details.pair"]).toBe("WETH/DAI");
            expect(report.attributes["details.orderHash"]).toBe("0xOrderABC");
            expect(report.attributes["details.orderbook"]).toBeTypeOf("string");
            expect(report.attributes["details.sender"]).toBe("0xSignerDEF");
            expect(report.attributes["details.owner"]).toBe("0xownerxyz");
        });

        it("should create one checkpoint report per order", async () => {
            const mockOrders = [
                {
                    orderbook: "0x1111111111111111111111111111111111111111",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken1",
                    buyToken: "0xbuyToken1",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
                {
                    orderbook: "0x1111111111111111111111111111111111111111",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken2",
                    buyToken: "0xbuyToken2",
                    takeOrder: { id: "0xOrder2", struct: { order: { owner: "0xOwner2" } } },
                },
                {
                    orderbook: "0x1111111111111111111111111111111111111111",
                    buyTokenSymbol: "BTC",
                    sellTokenSymbol: "USDT",
                    sellToken: "0xsellToken3",
                    buyToken: "0xbuyToken3",
                    takeOrder: { id: "0xOrder3", struct: { order: { owner: "0xOwner3" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            const result: initializeRoundType = await initializeRound.call(
                mockSolver,
                undefined,
                false,
            );

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
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken1",
                    buyToken: "0xbuyToken1",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken2",
                    buyToken: "0xbuyToken2",
                    takeOrder: { id: "0xOrder2", struct: { order: { owner: "0xOwner2" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            // all checkpoint reports should be ended
            result.checkpointReports.forEach((report) => {
                expect(report.endTime).toBeTypeOf("number");
                expect(report.endTime).toBeGreaterThan(0);
            });
        });

        it("should export checkpoint report if logger is available", async () => {
            const mockOrders = [
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken",
                    buyToken: "0xbuyToken",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
            ];
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            (mockSolver as any).logger = {
                exportPreAssembledSpan: vi.fn(),
            } as any;
            const mockCtx = { fields: {} } as any;
            await initializeRound.call(mockSolver, { span: {} as any, context: mockCtx });

            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledTimes(1);
            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledWith(
                expect.anything(),
                mockCtx,
            );

            (mockSolver as any).logger = undefined; // reset logger
        });

        it("should NOT export checkpoint report if logger is NOT available", async () => {
            const mockOrders = [
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken",
                    buyToken: "0xbuyToken",
                    takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
                },
            ];
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            const loggerExportReport = vi.spyOn(
                RainSolverLogger.prototype,
                "exportPreAssembledSpan",
            );
            await initializeRound.call(mockSolver);

            expect(loggerExportReport).not.toHaveBeenCalled();
            loggerExportReport.mockRestore();
        });
    });

    describe("return value structure", () => {
        it("should always return object with settlements and checkpointReports arrays", async () => {
            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue([]);

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
                {
                    orderbook: "0x3333333333333333333333333333333333333333",
                    buyTokenSymbol: "ETH",
                    sellTokenSymbol: "USDC",
                    sellToken: "0xsellToken",
                    buyToken: "0xbuyToken",
                    takeOrder: { id: "0xOrder123", struct: { order: { owner: "0xOwner123" } } },
                },
            ];

            (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue({
                account: { address: "0xSigner" },
            });

            const result: initializeRoundType = await initializeRound.call(mockSolver);

            expect(result.checkpointReports).toHaveLength(result.settlements.length);
            expect(result.checkpointReports).toHaveLength(1);
        });
    });

    it("should skip orders with zero vault balance and create settlement with ZeroOutput status", async () => {
        const mockOrders = [
            {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                buyToken: "0xBuyToken1",
                sellTokenSymbol: "USDC",
                sellToken: "0xSellToken1",
                sellTokenVaultBalance: 0n, // zero balance - should be skipped
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            },
            {
                orderbook: "0x4444444444444444444444444444444444444444",
                buyTokenSymbol: "BTC",
                buyToken: "0xBuyToken2",
                sellTokenSymbol: "USDT",
                sellToken: "0xSellToken2",
                takeOrder: { id: "0xOrder2", struct: { order: { owner: "0xOwner2" } } },
            },
        ];
        const mockSettleFn = vi.fn();
        (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
        (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
        (mockSolver.processOrder as Mock).mockResolvedValue(mockSettleFn);

        const result: initializeRoundType = await initializeRound.call(
            mockSolver,
            undefined,
            false,
        );

        // should have 2 settlements total
        expect(result.settlements).toHaveLength(2);
        expect(result.checkpointReports).toHaveLength(2);

        // first settlement (zero balance) - should be skipped and have ZeroOutput status
        const zeroBalanceSettlement = result.settlements[0];
        expect(zeroBalanceSettlement.pair).toBe("ETH/USDC");
        expect(zeroBalanceSettlement.owner).toBe("0xowner1");
        expect(zeroBalanceSettlement.orderHash).toBe("0xOrder1");

        // test the settle function for zero balance order
        const zeroBalanceResult = await zeroBalanceSettlement.settle();
        expect(zeroBalanceResult.isOk()).toBe(true);
        if (zeroBalanceResult.isOk()) {
            expect(zeroBalanceResult.value.status).toBe(ProcessOrderStatus.ZeroOutput);
            expect(zeroBalanceResult.value.tokenPair).toBe("ETH/USDC");
            expect(zeroBalanceResult.value.buyToken).toBe("0xBuyToken1");
            expect(zeroBalanceResult.value.sellToken).toBe("0xSellToken1");
            expect(zeroBalanceResult.value.spanAttributes).toEqual({
                "details.pair": "ETH/USDC",
                "details.orders": "0xOrder1",
            });
        }

        // second settlement (non-zero balance) - should be processed normally
        const normalSettlement = result.settlements[1];
        expect(normalSettlement.pair).toBe("BTC/USDT");
        expect(normalSettlement.owner).toBe("0xowner2");
        expect(normalSettlement.orderHash).toBe("0xOrder2");
        expect(normalSettlement.settle).toBe(mockSettleFn);

        // verify processOrder was called only once (for the non-zero balance order)
        expect(mockSolver.processOrder).toHaveBeenCalledTimes(1);
        expect(mockSolver.processOrder).toHaveBeenCalledWith({
            orderDetails: mockOrders[1], // second order with non-zero balance
            signer: mockSigner,
            blockNumber: 123n,
        });

        // verify getRandomSigner was called only once (for the non-zero balance order)
        expect(mockWalletManager.getRandomSigner).toHaveBeenCalledTimes(1);
        expect(mockWalletManager.getRandomSigner).toHaveBeenCalledWith(true);

        // verify checkpoint reports
        const zeroBalanceReport = result.checkpointReports[0];
        expect(zeroBalanceReport.name).toBe("checkpoint_ETH/USDC");
        expect(zeroBalanceReport.attributes["details.pair"]).toBe("ETH/USDC");
        expect(zeroBalanceReport.attributes["details.orderHash"]).toBe("0xOrder1");
        expect(zeroBalanceReport.attributes["details.owner"]).toBe("0xowner1");
        expect(zeroBalanceReport.attributes["details.orderbook"]).toBe(
            "0x3333333333333333333333333333333333333333",
        );
        expect(zeroBalanceReport.endTime).toBeTypeOf("number");
        // should NOT have sender attribute since it was skipped
        expect(zeroBalanceReport.attributes["details.sender"]).toBeUndefined();

        const normalReport = result.checkpointReports[1];
        expect(normalReport.name).toBe("checkpoint_BTC/USDT");
        expect(normalReport.attributes["details.pair"]).toBe("BTC/USDT");
        expect(normalReport.attributes["details.orderHash"]).toBe("0xOrder2");
        expect(normalReport.attributes["details.owner"]).toBe("0xowner2");
        expect(normalReport.attributes["details.orderbook"]).toBe(
            "0x4444444444444444444444444444444444444444",
        );
        expect(normalReport.attributes["details.sender"]).toBe("0xSigner123");
        expect(normalReport.endTime).toBeTypeOf("number");
    });

    it("should skip orders when trade addresses are not configured", async () => {
        const mockOrders = [
            {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                buyToken: "0xBuyToken1",
                sellTokenSymbol: "USDC",
                sellToken: "0xSellToken1",
                sellTokenVaultBalance: 123n,
                takeOrder: {
                    id: "0xOrder1",
                    struct: { order: { owner: "0xOwner1", type: Order.Type.V4 } },
                },
            },
        ];
        const mockSettleFn = vi.fn();
        (mockOrderManager.getNextRoundOrders as Mock).mockReturnValue(mockOrders);
        (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
        (mockSolver.processOrder as Mock).mockResolvedValue(mockSettleFn);
        (mockState.contracts.getAddressesForTrade as Mock).mockReturnValue(undefined); // simulate missing trade addresses

        const result: initializeRoundType = await initializeRound.call(
            mockSolver,
            undefined,
            false,
        );

        // should have 1 settlements total
        expect(result.settlements).toHaveLength(1);
        expect(result.checkpointReports).toHaveLength(1);

        // first settlement (zero balance) - should be skipped and have ZeroOutput status
        const zeroBalanceSettlement = result.settlements[0];
        expect(zeroBalanceSettlement.pair).toBe("ETH/USDC");
        expect(zeroBalanceSettlement.owner).toBe("0xowner1");
        expect(zeroBalanceSettlement.orderHash).toBe("0xOrder1");

        // test the settle function for missing trade addresses
        const missingTradeAddresses = await zeroBalanceSettlement.settle();
        assert(missingTradeAddresses.isOk());
        expect(missingTradeAddresses.value.tokenPair).toBe("ETH/USDC");
        expect(missingTradeAddresses.value.buyToken).toBe("0xBuyToken1");
        expect(missingTradeAddresses.value.sellToken).toBe("0xSellToken1");
        expect(missingTradeAddresses.value.spanAttributes).toEqual({
            "details.pair": "ETH/USDC",
            "details.orders": "0xOrder1",
        });
        expect(missingTradeAddresses.value.endTime).toBeTypeOf("number");
        expect(missingTradeAddresses.value.status).toBe(ProcessOrderStatus.UndefinedTradeAddresses);
        expect(missingTradeAddresses.value.message).toBe(
            "Cannot trade as dispair addresses are not configured for order V4 trade",
        );
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
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    gasCost: 1000000n,
                    status: ProcessOrderStatus.ZeroOutput,
                    tokenPair: "ETH/USDC",
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // assert function behavior
            expect(result.results).toHaveLength(1);
            expect(result.reports).toHaveLength(1);
            const result1 = result.results[0];
            assert(result1.isOk());
            expect(result1.value).toEqual({
                status: ProcessOrderStatus.ZeroOutput,
                tokenPair: "ETH/USDC",
                gasCost: 1000000n,
                spanAttributes: { "test.attr": "value" },
                endTime: 789,
                spanEvents: {},
            });

            // assert gas cost tracking
            expect(mockSolver.state.gasCosts).toHaveLength(1);
            expect(mockSolver.state.gasCosts[0]).toBe(1000000n);

            // assert span creation and attributes
            const report = result.reports[0];
            expect(report.name).toBe("order_ETH/USDC");
            expect(report.startTime).toBe(123);
            expect(report.endTime).toBe(789);
            expect(report.attributes["test.attr"]).toBe("value");
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("zero max output");
        });

        it("should handle NoOpportunity status with message string", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.NoOpportunity,
                    spanAttributes: { liquidity: "low" },
                    message: "insufficient liquidity",
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            const result1 = result.results[0];
            assert(result1.isOk());
            expect(result1.value).toEqual({
                status: ProcessOrderStatus.NoOpportunity,
                spanAttributes: { liquidity: "low" },
                message: "insufficient liquidity",
                endTime: 789,
                spanEvents: {},
            });
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toBe("insufficient liquidity");
            expect(result.reports[0].attributes["liquidity"]).toBe("low");
        });

        it("should handle NoOpportunity status without error", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.NoOpportunity,
                    spanAttributes: {},
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/DAI",
                    owner: "0x789",
                    orderHash: "0x123",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("no opportunity");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle FoundOpportunity status", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    profit: "0.05",
                    spanAttributes: { "profit.eth": "0.05" },
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "WETH/DAI",
                    owner: "0xabc",
                    orderHash: "0x456",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            const result1 = result.results[0];
            assert(result1.isOk());
            expect(result1.value).toEqual({
                status: ProcessOrderStatus.FoundOpportunity,
                profit: "0.05",
                spanAttributes: { "profit.eth": "0.05" },
                endTime: 789,
                spanEvents: {},
            });
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("found opportunity");
            expect(result.reports[0].attributes["profit.eth"]).toBe("0.05");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle unknown status as unexpected error", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: "UNKNOWN_STATUS" as any,
                    spanAttributes: { custom: "attr" },
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "LINK/USDC",
                    owner: "0xdef",
                    orderHash: "0x789",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].status?.message).toBe("unexpected error");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle settlement without gas cost", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes: {},
                    spanEvents: {},
                    endTime: 789,
                    // No gasCost provided
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const initialGasCosts = [...mockSolver.state.gasCosts];
            await finalizeRound.call(mockSolver, settlements);

            expect(mockSolver.state.gasCosts).toEqual(initialGasCosts);
        });

        it("should record events for successful settlement", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes: {},
                    spanEvents: {
                        something: { startTime: 1234, duration: 456 },
                        another: { startTime: 5678, duration: 123 },
                    },
                    endTime: 789,
                }),
            );
            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];
            const addEventSpy = vi.spyOn(PreAssembledSpan.prototype, "addEvent");
            await finalizeRound.call(mockSolver, settlements);

            expect(addEventSpy).toHaveBeenCalledWith("something", { duration: 456 }, 1234);
            expect(addEventSpy).toHaveBeenCalledWith("another", { duration: 123 }, 5678);

            addEventSpy.mockRestore();
        });

        it("should handle UndefinedTradeAddresses status when trade addresses were undefined", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.UndefinedTradeAddresses,
                    tokenPair: "ETH/USDC",
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    endTime: 789,
                    message: "undefined addresses",
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // assert function behavior
            expect(result.results).toHaveLength(1);
            expect(result.reports).toHaveLength(1);
            const result1 = result.results[0];
            assert(result1.isOk());
            expect(result1.value).toEqual({
                status: ProcessOrderStatus.UndefinedTradeAddresses,
                tokenPair: "ETH/USDC",
                spanAttributes: { "test.attr": "value" },
                endTime: 789,
                message: "undefined addresses",
                spanEvents: {},
            });

            // assert span creation and attributes
            const report = result.reports[0];
            expect(report.name).toBe("order_ETH/USDC");
            expect(report.startTime).toBe(123);
            expect(report.endTime).toBe(789);
            expect(report.attributes["test.attr"]).toBe("value");
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("undefined addresses");
        });
    });

    describe("error handling", () => {
        it("should handle FailedToQuote error without error details", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.FailedToQuote,
                    spanAttributes: { provider: "chainlink" },
                    spanEvents: {},
                    status: "failed",
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            const result1 = result.results[0];
            assert(result1.isErr());
            expect(result1.error).toEqual({
                status: "failed",
                reason: ProcessOrderHaltReason.FailedToQuote,
                spanAttributes: { provider: "chainlink" },
                endTime: 789,
                spanEvents: {},
            });
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toBe("failed to quote order: 0xabc");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle FailedToQuote error with error details", async () => {
            const error = new Error("quote service down");
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.FailedToQuote,
                    spanAttributes: { "retry.count": "3" },
                    spanEvents: {},
                    status: "failed",
                    error,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDC",
                    owner: "0x456",
                    orderHash: "0xdef",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            const result1 = result.results[0];
            assert(result1.isErr());
            expect(result1.error.error).toBe(error);
            expect(result1.error.reason).toBe(ProcessOrderHaltReason.FailedToQuote);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].status?.message).toContain("failed to quote order: 0xdef");
            expect(result.reports[0].status?.message).toContain("quote service down");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle FailedToGetPools error with medium severity", async () => {
            const error = new Error("pool fetch failed");
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.FailedToGetPools,
                    spanAttributes: { "pool.count": "0" },
                    spanEvents: {},
                    status: "failed",
                    error,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "WETH/USDT",
                    owner: "0x789",
                    orderHash: "0x123",
                    startTime: 123,
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
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle FailedToGetEthPrice error with OK status", async () => {
            const error = new Error("eth price unavailable");
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.FailedToGetEthPrice,
                    spanAttributes: {},
                    spanEvents: {},
                    status: "failed",
                    error,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "CUSTOM/TOKEN",
                    owner: "0xabc",
                    orderHash: "0x456",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].attributes["errorDetails"]).toContain(
                "failed to get eth price",
            );
            expect(result.reports[0].attributes["errorDetails"]).toContain("eth price unavailable");
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle FailedToUpdatePools error", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.FailedToUpdatePools,
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    error: new Error("update failed"),
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
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
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxFailed error with timeout (low severity)", async () => {
            const timeoutError = new TimeoutError({ body: {}, url: "http://example.com" });
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxFailed,
                    spanAttributes: { "tx.hash": "0x123" },
                    spanEvents: {},
                    status: "failed",
                    error: timeoutError,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txSendFailed"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxFailed error without timeout (high severity)", async () => {
            const error = new Error("gas too low");
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxFailed,
                    spanAttributes: {},
                    spanEvents: {},
                    status: "failed",
                    error,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxFailed error without error details", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxFailed,
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.message).toBe("failed to submit the transaction");
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxReverted error with snapshot", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxReverted,
                    spanAttributes: { "block.number": "12345" },
                    spanEvents: {},
                    status: "reverted",
                    error: { snapshot: "Transaction reverted: INSUFFICIENT_LIQUIDITY" },
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "LINK/DAI",
                    owner: "0x789",
                    orderHash: "0x123",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["errorDetails"]).toBe(
                "Transaction reverted: INSUFFICIENT_LIQUIDITY",
            );
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxReverted error with known error (no high severity)", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxReverted,
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    error: { err: new Error("INSUFFICIENT_LIQUIDITY") }, // This is typically a known error
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // Should not set HIGH severity for known errors (depends on KnownErrors array)
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxReverted error with txNoneNodeError flag (high severity)", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxReverted,
                    spanAttributes: { txNoneNodeError: true },
                    spanEvents: {},
                    status: "reverted",
                    error: { err: new Error("unknown revert") },
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "UNI/WETH",
                    owner: "0xabc",
                    orderHash: "0x456",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].attributes["txReverted"]).toBe(true);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxMineFailed error with timeout", async () => {
            const timeoutError = new TimeoutError({ body: {}, url: "http://example.com" });

            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxMineFailed,
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    error: timeoutError,
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(result.reports[0].attributes["unsuccessfulClear"]).toBe(true);
            expect(result.reports[0].attributes["txMineFailed"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle TxMineFailed error without timeout", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxMineFailed,
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    error: new Error("rpc error"),
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should handle unexpected error and set reason", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: "unknown_reason",
                    spanAttributes: { "test.attr": "value" },
                    spanEvents: {},
                    status: "failed",
                    error: new Error("unexpected"),
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(result.reports[0].exception?.exception).toBeInstanceOf(Error);
            expect((result.reports[0].exception?.exception as any)?.message).toBe("unexpected");
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);

            const result1 = result.results[0];
            assert(result1.isErr());
            expect(result1.error.reason).toBe(ProcessOrderHaltReason.UnexpectedError);
        });

        it("should record events for failed settlement", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.err({
                    reason: "unknown_reason",
                    spanAttributes: {},
                    spanEvents: {
                        something: { startTime: 1234, duration: 456 },
                        another: { startTime: 5678, duration: 123 },
                    },
                    status: "failed",
                    error: new Error("unexpected"),
                    endTime: 789,
                }),
            );
            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];
            const addEventSpy = vi.spyOn(PreAssembledSpan.prototype, "addEvent");
            await finalizeRound.call(mockSolver, settlements);

            expect(addEventSpy).toHaveBeenCalledWith("something", { duration: 456 }, 1234);
            expect(addEventSpy).toHaveBeenCalledWith("another", { duration: 123 }, 5678);

            addEventSpy.mockRestore();
        });
    });

    describe("multiple settlements", () => {
        it("should process multiple settlements and return correct results", async () => {
            const mockSettle1 = vi.fn().mockResolvedValue(
                Result.ok({
                    gasCost: 1000000n,
                    status: ProcessOrderStatus.FoundOpportunity,
                    txUrl: "url1",
                    spanAttributes: { success: true },
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            const mockSettle2 = vi.fn().mockResolvedValue(
                Result.err({
                    reason: ProcessOrderHaltReason.TxFailed,
                    spanAttributes: { failed: true },
                    spanEvents: {},
                    status: "failed",
                    txUrl: "url2",
                    error: new Error("tx failed"),
                    endTime: 987,
                }),
            );

            settlements = [
                {
                    settle: mockSettle1,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
                {
                    settle: mockSettle2,
                    pair: "BTC/USDT",
                    owner: "0x456",
                    orderHash: "0xdef",
                    startTime: 456,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            // assert correct number of results and reports
            expect(result.results).toHaveLength(2);
            expect(result.reports).toHaveLength(2);

            // assert first result (success)
            const result1 = result.results[0];
            assert(result1.isOk());
            expect(result1.value.txUrl).toBe("url1");
            expect(result1.value.status).toBe(ProcessOrderStatus.FoundOpportunity);
            expect(result.reports[0].name).toBe("order_ETH/USDC");
            expect(result.reports[0].attributes["success"]).toBe(true);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);

            // assert second result (error)
            const result2 = result.results[1];
            assert(result2.isErr());
            expect(result2.error.txUrl).toBe("url2");
            expect(result2.error.reason).toBe(ProcessOrderHaltReason.TxFailed);
            expect(result.reports[1].name).toBe("order_BTC/USDT");
            expect(result.reports[1].attributes["failed"]).toBe(true);
            expect(result.reports[1].status?.code).toBe(SpanStatusCode.ERROR);
            expect(result.reports[1].startTime).toBe(456);
            expect(result.reports[1].endTime).toBe(987);

            // assert gas costs only added for successful settlement
            expect(mockSolver.state.gasCosts).toHaveLength(1);
            expect(mockSolver.state.gasCosts[0]).toBe(1000000n);
        });
    });

    describe("span management", () => {
        it("should create spans with correct names and set owner attribute", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes: {},
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].name).toBe("order_ETH/USDC");
            expect(result.reports[0].endTime).toBeTypeOf("number");
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should extend span attributes from settlement result", async () => {
            const spanAttributes = { "custom.attr": "test", "another.attr": 123 };
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes,
                    spanEvents: {},
                    endTime: 789,
                }),
            );

            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];

            const result: finalizeRoundType = await finalizeRound.call(mockSolver, settlements);

            expect(result.reports[0].attributes["custom.attr"]).toBe("test");
            expect(result.reports[0].attributes["another.attr"]).toBe(123);
            expect(result.reports[0].status?.code).toBe(SpanStatusCode.OK);
            expect(result.reports[0].startTime).toBe(123);
            expect(result.reports[0].endTime).toBe(789);
        });

        it("should export settlement report if logger is available", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes: {},
                    spanEvents: { something: 1234, another: 5678 },
                    endTime: 789,
                }),
            );
            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];
            (mockSolver as any).logger = {
                exportPreAssembledSpan: vi.fn(),
            } as any;
            const mockCtx = { fields: {} } as any;
            await finalizeRound.call(mockSolver, settlements, {
                span: {} as any,
                context: mockCtx,
            });

            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledTimes(1);
            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledWith(
                expect.anything(),
                mockCtx,
            );

            (mockSolver as any).logger = undefined; // reset logger
        });

        it("should NOT export settlement report if logger is NOT available", async () => {
            const mockSettle = vi.fn().mockResolvedValue(
                Result.ok({
                    status: ProcessOrderStatus.FoundOpportunity,
                    spanAttributes: {},
                    spanEvents: { something: 1234, another: 5678 },
                    endTime: 789,
                }),
            );
            settlements = [
                {
                    settle: mockSettle,
                    pair: "ETH/USDC",
                    owner: "0x123",
                    orderHash: "0xabc",
                    startTime: 123,
                },
            ];
            const loggerExportReport = vi.spyOn(
                RainSolverLogger.prototype,
                "exportPreAssembledSpan",
            );
            await finalizeRound.call(mockSolver, settlements);

            expect(loggerExportReport).not.toHaveBeenCalled();
            loggerExportReport.mockRestore();
        });
    });
});

describe("Test iterOrders", () => {
    let mockOrders: any[];

    beforeEach(() => {
        mockOrders = [{ id: "0xOrder1" }, { id: "0xOrder2" }, { id: "0xOrder3" }];
    });

    it("should iterate orders without shuffle", () => {
        const iteratedOrders: any[] = [];

        // collect all orders from the generator
        for (const order of iterOrders(mockOrders, false)) {
            iteratedOrders.push(order);
        }

        // should return orders in the same order as input
        expect(iteratedOrders).toHaveLength(3);
        expect(iteratedOrders[0].id).toBe("0xOrder1");
        expect(iteratedOrders[1].id).toBe("0xOrder2");
        expect(iteratedOrders[2].id).toBe("0xOrder3");
    });

    it("should iterate orders with shuffle", () => {
        const iteratedOrders: any[] = [];

        // mock Math.random to control randomness for predictable testing
        const mockMathRandom = vi.spyOn(Math, "random");
        mockMathRandom
            .mockReturnValueOnce(0.8) // pick index 2 (0.8 * 3 = 2.4 -> floor = 2)
            .mockReturnValueOnce(0.3) // pick index 0 (0.3 * 2 = 0.6 -> floor = 0)
            .mockReturnValueOnce(0.0); // pick index 0 (0.0 * 1 = 0.0 -> floor = 0)

        // collect all orders from the generator
        for (const order of iterOrders(mockOrders, true)) {
            iteratedOrders.push(order);
        }

        // should return all orders but potentially in different order
        expect(iteratedOrders).toHaveLength(3);

        // with our mocked random values, expected order should be:
        // 1st iteration: pick index 2 (Order3), swap with last (Order3), pop Order3
        // 2nd iteration: pick index 0 (Order1), swap with last (Order2), pop Order1
        // 3rd iteration: pick index 0 (Order2), pop Order2
        expect(iteratedOrders[0].id).toBe("0xOrder3");
        expect(iteratedOrders[1].id).toBe("0xOrder1");
        expect(iteratedOrders[2].id).toBe("0xOrder2");

        // verify Math.random was called the expected number of times
        expect(mockMathRandom).toHaveBeenCalledTimes(3);

        mockMathRandom.mockRestore();
    });
});

describe("Test processOrderInit", () => {
    type processOrderInitType = Awaited<ReturnType<typeof processOrderInit>>;
    let mockSolver: RainSolver;
    let mockOrderManager: OrderManager;
    let mockWalletManager: WalletManager;
    let mockState: SharedState;
    let mockAppOptions: AppOptions;
    let dispair: Dispair;
    let destination: `0x${string}`;
    const mockSigner = { account: { address: "0xSigner123" } };

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";

        // mock order manager
        mockOrderManager = {
            getNextRoundOrders: vi.fn(),
            ownerTokenVaultMap: new Map(),
        } as any;

        // mock wallet manager
        mockWalletManager = {
            getRandomSigner: vi.fn(),
        } as any;

        // mock state
        mockState = {
            client: {
                name: "viem-client",
                getBlockNumber: vi.fn().mockResolvedValue(123n),
            },
            contracts: {
                getAddressesForTrade: vi.fn().mockReturnValue({
                    dispair,
                    destination,
                }),
            },
            router: {
                sushi: { update: vi.fn().mockResolvedValue(undefined) },
            },
        } as any;

        // mock app options
        mockAppOptions = {} as any;

        // mock RainSolver
        mockSolver = {
            orderManager: mockOrderManager,
            walletManager: mockWalletManager,
            state: mockState,
            appOptions: mockAppOptions,
            processOrder: vi.fn(),
        } as any;
    });

    describe("successful execution", () => {
        it("should return settlements with correct structure for single order", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: {
                    id: "0xOrder123",
                    struct: { order: { owner: "0xOwner123" } },
                },
            };

            const mockSettleFn = vi.fn();
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            (mockSolver.processOrder as Mock).mockResolvedValue(mockSettleFn);

            const result: processOrderInitType = await processOrderInit.call(
                mockSolver,
                mockOrder,
                123n,
            );

            const settlement = result.settlement;
            expect(settlement.pair).toBe("ETH/USDC");
            expect(settlement.owner).toBe("0xowner123");
            expect(settlement.orderHash).toBe("0xOrder123");
            expect(settlement.startTime).toBeTypeOf("number");
            expect(settlement.settle).toBe(mockSettleFn);

            // Verify checkpoint report
            const checkpointReport = result.checkpointReport;
            expect(checkpointReport.name).toBe("checkpoint_ETH/USDC");
            expect(checkpointReport.attributes["details.pair"]).toBe("ETH/USDC");
            expect(checkpointReport.attributes["details.orderHash"]).toBe("0xOrder123");
            expect(checkpointReport.attributes["details.owner"]).toBe("0xowner123");
            expect(checkpointReport.attributes["details.sender"]).toBe("0xSigner123");
            expect(checkpointReport.endTime).toBeTypeOf("number");
        });
    });

    describe("method call verification", () => {
        it("should call getRandomSigner for each order", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            await processOrderInit.call(mockSolver, mockOrder, 123n);

            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledWith(true);
            expect(mockWalletManager.getRandomSigner).toHaveBeenCalledTimes(1);
        });

        it("should call processOrder with correct parameters structure", async () => {
            const orderDetails: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyToken: "0xETH",
                buyTokenSymbol: "ETH",
                buyTokenDecimals: 18,
                sellToken: "0xUSDC",
                sellTokenSymbol: "USDC",
                sellTokenDecimals: 6,
                takeOrder: { id: "0xOrder123", struct: { order: { owner: "0xOwner123" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            await processOrderInit.call(mockSolver, orderDetails, 123n);

            expect(mockSolver.processOrder).toHaveBeenCalledWith({
                orderDetails,
                signer: mockSigner,
                blockNumber: 123n,
            });
        });
    });

    describe("checkpoint reports verification", () => {
        it("should create checkpoint reports with correct attributes", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "WETH",
                sellTokenSymbol: "DAI",
                takeOrder: { id: "0xOrderABC", struct: { order: { owner: "0xOwnerXYZ" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue({
                account: { address: "0xSignerDEF" },
            });

            const result: processOrderInitType = await processOrderInit.call(
                mockSolver,
                mockOrder,
                123n,
            );

            const report = result.checkpointReport;
            expect(report.name).toBe("checkpoint_WETH/DAI");
            expect(report.attributes["details.pair"]).toBe("WETH/DAI");
            expect(report.attributes["details.orderHash"]).toBe("0xOrderABC");
            expect(report.attributes["details.orderbook"]).toBeTypeOf("string");
            expect(report.attributes["details.sender"]).toBe("0xSignerDEF");
            expect(report.attributes["details.owner"]).toBe("0xownerxyz");
        });

        it("should create one checkpoint report per order", async () => {
            const mockOrder: any = {
                orderbook: "0x1111111111111111111111111111111111111111",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            const result: processOrderInitType = await processOrderInit.call(
                mockSolver,
                mockOrder,
                123n,
            );

            expect(result.checkpointReport.attributes["details.orderHash"]).toBe("0xOrder1");
            expect(result.settlement.orderHash).toBe("0xOrder1");
        });

        it("should end all checkpoint reports", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);

            const result: processOrderInitType = await processOrderInit.call(
                mockSolver,
                mockOrder,
                123n,
            );

            expect(result.checkpointReport.endTime).toBeTypeOf("number");
            expect(result.checkpointReport.endTime).toBeGreaterThan(0);
        });

        it("should export checkpoint report if logger is available", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            (mockSolver as any).logger = {
                exportPreAssembledSpan: vi.fn(),
            } as any;
            const mockCtx = { fields: {} } as any;
            await processOrderInit.call(mockSolver, mockOrder, 123n, {
                span: {} as any,
                context: mockCtx,
            });

            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledTimes(1);
            expect(mockSolver.logger?.exportPreAssembledSpan).toHaveBeenCalledWith(
                expect.anything(),
                mockCtx,
            );

            (mockSolver as any).logger = undefined; // reset logger
        });

        it("should NOT export checkpoint report if logger is NOT available", async () => {
            const mockOrder: any = {
                orderbook: "0x3333333333333333333333333333333333333333",
                buyTokenSymbol: "ETH",
                sellTokenSymbol: "USDC",
                takeOrder: { id: "0xOrder1", struct: { order: { owner: "0xOwner1" } } },
            };
            (mockWalletManager.getRandomSigner as Mock).mockResolvedValue(mockSigner);
            const loggerExportReport = vi.spyOn(
                RainSolverLogger.prototype,
                "exportPreAssembledSpan",
            );
            await processOrderInit.call(mockSolver, mockOrder, 123n);

            expect(loggerExportReport).not.toHaveBeenCalled();
            loggerExportReport.mockRestore();
        });
    });
});

describe("Test prepareRouter", () => {
    it("should call with correct params", async () => {
        const nativeWrappedToken = {
            address: "0xnativewrappedToken",
        };
        const mockState = {
            client: { name: "client" },
            chainConfig: { id: 1, nativeWrappedToken },
            getMarketPrice: vi.fn().mockResolvedValue(null),
            router: { cache: new Map() },
        } as any;
        const mockSolver = { state: mockState } as any;
        const mockOrderDetails = {
            id: "0xid",
            sellTokenDecimals: 18,
            sellToken: "0xsellToken",
            sellTokenSymbol: "sTKN",
            buyTokenDecimals: 18,
            buyToken: "0xbuytoken",
            buyTokenSymbol: "bTKN",
        } as any;
        const fromToken = {
            chainId: 1,
            address: mockOrderDetails.sellToken,
            decimals: mockOrderDetails.sellTokenDecimals,
            symbol: mockOrderDetails.sellTokenSymbol,
        };
        const toToken = {
            chainId: 1,
            address: mockOrderDetails.buyToken,
            decimals: mockOrderDetails.buyTokenDecimals,
            symbol: mockOrderDetails.buyTokenSymbol,
        };

        await prepareRouter.call(mockSolver, mockOrderDetails, 123n);

        expect(mockState.getMarketPrice as Mock).toHaveBeenCalledTimes(3);
        expect(mockState.getMarketPrice as Mock).toHaveBeenNthCalledWith(
            1,
            fromToken,
            toToken,
            123n,
            false,
        );
        expect(mockState.getMarketPrice as Mock).toHaveBeenNthCalledWith(
            2,
            toToken,
            mockState.chainConfig.nativeWrappedToken,
            123n,
            false,
        );
        expect(mockState.getMarketPrice as Mock).toHaveBeenNthCalledWith(
            3,
            fromToken,
            mockState.chainConfig.nativeWrappedToken,
            123n,
            false,
        );
    });
});
