import { Order } from "../../../order";
import { findBestRouterTrade } from "./index";
import { Dispair, Result } from "../../../common";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { extendObjectWithHeader } from "../../../common";
import { SimulationResult, TradeType } from "../../types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// Mocks
// extendObjectWithHeader is wrapped with its real implementation so call
// assertions work while span attributes still get merged for assertions
vi.mock("../../../common", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../../common")>();
    return {
        ...original,
        extendObjectWithHeader: vi.fn(original.extendObjectWithHeader),
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

describe("Test findBestRouterTrade", () => {
    let mockRainSolver: any;
    let orderDetails: any;
    let signer: any;
    let ethPrice: string;
    let toToken: any;
    let fromToken: any;
    let blockNumber: bigint;
    let trySimulateTradeSpy: any;
    let simulatorWithArgsSpy: any;
    let dispair: Dispair;
    let destination: `0x${string}`;

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";
        mockRainSolver = {
            appOptions: {},
            state: {
                gasPrice: 100n,
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
                router: {
                    findLargestTradeSize: vi.fn(),
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        dispair,
                        destination,
                    }),
                },
            },
        };

        orderDetails = {
            takeOrder: { quote: { maxOutput: 1000n }, struct: { order: { type: Order.Type.V4 } } },
        };

        signer = { account: { address: "0xsigner" } };
        ethPrice = "2000";
        toToken = { address: "0xTo", decimals: 18, symbol: "TO" };
        fromToken = { address: "0xFrom", decimals: 18, symbol: "FROM" };
        blockNumber = 123n;

        simulatorWithArgsSpy = vi.spyOn(RouterTradeSimulator, "withArgs");
        trySimulateTradeSpy = vi.spyOn(RouterTradeSimulator.prototype, "trySimulateTrade");
    });

    it("should return success result if full trade size simulation succeeds", async () => {
        const mockSuccessResult = Result.ok({
            type: "balancer",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockSuccessResult);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ foundOpp: true });
        expect(result.value.estimatedProfit).toBe(100n);
        expect(result.value.oppBlockNumber).toBe(123);
        expect(result.value.type).toBe("balancer");
        expect(simulatorWithArgsSpy).toHaveBeenCalledWith({
            type: TradeType.Router,
            solver: mockRainSolver,
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 1000n,
            ethPrice,
            isPartial: false,
            blockNumber: 123n,
        });
    });

    it("should return error if no route found", async () => {
        const mockErrorResult = Result.err({
            type: TradeType.Router,
            reason: SimulationHaltReason.NoRoute,
            spanAttributes: { route: "no-way" },
            noneNodeError: "no route available",
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockErrorResult);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("no route available");
        expect(result.error.type).toBe("router");
        // the single sim's span attributes are merged directly without a header
        expect(result.error.spanAttributes).toEqual({ route: "no-way" });
    });

    it("should simulate the most profitable trade size when found", async () => {
        const mockSuccessResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockSuccessResult);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(500n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ foundOpp: true });
        expect(result.value.estimatedProfit).toBe(50n);
        expect(result.value.type).toBe("routeProcessor");
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledWith(
            orderDetails,
            toToken,
            fromToken,
            1000n,
            100n,
            undefined,
            false,
            undefined,
        );
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith({
            type: TradeType.Router,
            solver: mockRainSolver,
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 500n,
            ethPrice,
            isPartial: true,
            blockNumber: 123n,
        });
    });

    it("should simulate with isPartial false when the most profitable trade size is the full size", async () => {
        const mockSuccessResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 80n,
            oppBlockNumber: 123,
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockSuccessResult);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(1000n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isOk());
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ maximumInputFixed: 1000n, isPartial: false }),
        );
    });

    it("should fall back to full trade size when no profitable trade size is found", async () => {
        const mockErrorResult = Result.err({
            type: TradeType.Router,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockErrorResult);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(undefined);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("order ratio issue");
        expect(result.error.type).toBe("router");
        expect(result.error.reason).toBe(SimulationHaltReason.OrderRatioGreaterThanMarketPrice);
        // the single sim's span attributes are merged directly without a header
        expect(result.error.spanAttributes).toEqual({ error: "ratio too high" });
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ maximumInputFixed: 1000n, isPartial: false }),
        );
    });

    it("should return error when simulation of the found trade size fails", async () => {
        const mockErrorResult = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "no opportunity" },
            noneNodeError: "sim failed",
        });
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockErrorResult);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(500n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("sim failed");
        expect(result.error.type).toBe("routeProcessor");
        expect(result.error.spanAttributes).toEqual({ error: "no opportunity" });
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ maximumInputFixed: 500n, isPartial: true }),
        );
    });

    it("should backoff with halved trade sizes when the trade fails with MinimalOutputBalanceViolation", async () => {
        const mockViolationError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: {
                error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
            },
        });
        const mockFallbackSuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { foundOpp: true },
            estimatedProfit: 25n,
            oppBlockNumber: 123,
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockViolationError) // found size 1000n
            .mockResolvedValueOnce(mockViolationError) // fallback1 500n
            .mockResolvedValueOnce(mockFallbackSuccess); // fallback2 250n
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(1000n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ foundOpp: true });
        expect(result.value.estimatedProfit).toBe(25n);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(3);
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ maximumInputFixed: 500n, isPartial: true }),
        );
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({ maximumInputFixed: 250n, isPartial: true }),
        );
    });

    it("should return error with MinimalOutputBalanceViolation reason when all backoff steps fail", async () => {
        const mockViolationError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: {
                error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
            },
            noneNodeError: "min output violation",
        });

        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError); // found size + all fallbacks
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(1024000n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("min output violation");
        // 1 found size + 4 fallbacks
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(5);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ maximumInputFixed: 64000n, isPartial: true }),
        );
        expect(result.error.spanAttributes["error"]).toContain("MinimalOutputBalanceViolation");
        expect(result.error.spanAttributes["fallback1.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["fallback4.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["fallback5.error"]).toBeUndefined();
    });

    it("should stop backoff when a step fails with an error other than MinimalOutputBalanceViolation", async () => {
        const mockViolationError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: {
                error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
            },
        });
        const mockOtherError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "some other revert" },
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockViolationError) // found size
            .mockResolvedValueOnce(mockOtherError); // fallback1
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(1000n);

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        // 1 found size + 1 fallback, stopped early
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        expect(result.error.spanAttributes["fallback1.error"]).toBe("some other revert");
        expect(result.error.spanAttributes["fallback2.error"]).toBeUndefined();
    });

    it("should retry with the failing route dexes excluded when full trade dryrun fails", async () => {
        const sushiQuote = {
            route: {
                pcMap: new Map([["pool1", { liquidityProvider: "Hydrex" }]]),
                route: { legs: [{ uniqueId: "pool1" }] },
            },
        } as any;
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "dryrun failed" },
        });
        const mockRetrySuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });
        (simulatorWithArgsSpy as Mock)
            .mockReturnValueOnce({
                quote: sushiQuote,
                trySimulateTrade: vi.fn().mockResolvedValue(mockFullTradeError),
            })
            .mockReturnValueOnce({
                quote: sushiQuote,
                trySimulateTrade: vi.fn().mockResolvedValue(mockRetrySuccess),
            });

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ foundOpp: true });
        expect(result.value.estimatedProfit).toBe(50n);
        expect(simulatorWithArgsSpy).toHaveBeenCalledTimes(2);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith({
            type: TradeType.Router,
            solver: mockRainSolver,
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 1000n,
            ethPrice,
            isPartial: false,
            blockNumber: 123n,
            excludeDexes: new Set(["Hydrex"]),
        });
        // trade size is searched for both attempts, secondary with excluded dexes
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledTimes(2);
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenLastCalledWith(
            orderDetails,
            toToken,
            fromToken,
            1000n,
            100n,
            undefined,
            false,
            new Set(["Hydrex"]),
        );
    });

    it("should return error when retry attempt also fails", async () => {
        const sushiQuote = {
            route: {
                pcMap: new Map([["pool1", { liquidityProvider: "Hydrex" }]]),
                route: { legs: [{ uniqueId: "pool1" }] },
            },
        } as any;
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "dryrun failed" },
            noneNodeError: "full failed",
        });
        const mockRetryError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "retry dryrun failed" },
            noneNodeError: "retry failed",
        });
        (simulatorWithArgsSpy as Mock)
            .mockReturnValueOnce({
                quote: sushiQuote,
                trySimulateTrade: vi.fn().mockResolvedValue(mockFullTradeError),
            })
            .mockReturnValueOnce({
                quote: undefined,
                trySimulateTrade: vi.fn().mockResolvedValue(mockRetryError),
            });

        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("full failed");
        expect(result.error.type).toBe(TradeType.RouteProcessor);
        expect(result.error.spanAttributes).toEqual({
            error: "dryrun failed",
            "secondary.error": "retry dryrun failed",
        });
        expect(simulatorWithArgsSpy).toHaveBeenCalledTimes(2);
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "retry dryrun failed" },
            "secondary",
        );
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledTimes(2);
    });

    it("should return early if ethPrice is unknown", async () => {
        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            "",
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe("router");
        expect(result.error.spanAttributes.error).toBe(
            "no route to get price of input token to eth",
        );
    });

    it("should return error when trade addresses are not configured", async () => {
        (mockRainSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValue(undefined);
        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Router);
        expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
        expect(mockRainSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Router,
        );
    });
});
