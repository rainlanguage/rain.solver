import { Order } from "../../../order";
import { findBestRouterTrade } from "./index";
import { TradeSizeStatus } from "../../../router";
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
            appOptions: { routerPartialFallback: true },
            state: {
                gasPrice: 100n,
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
                router: {
                    findLargestTradeSize: vi
                        .fn()
                        .mockReturnValue({ status: TradeSizeStatus.NoWay }),
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
            takeOrder: {
                quote: { maxOutput: 1000n },
                struct: { order: { type: Order.Type.V4, owner: "0xOwner" } },
            },
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
        expect(result.error.spanAttributes).toEqual({
            "full.route": "no-way",
            "partial.error": "found no route for any trade size",
        });
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { route: "no-way" },
            "full",
        );
    });

    it("should try partial trade with the biggest routed size on PriceMismatch result", async () => {
        const mockFullTradeError = Result.err({
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 25n,
            oppBlockNumber: 123,
        });

        const mockSizeQuote = { route: { pcMap: new Map() }, price: 1n, amountOut: 1n };
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.PriceMismatch,
            size: 400n,
            quote: mockSizeQuote,
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

        // the price mismatch size is still simulated as partial trade size,
        // with the size search winning probe quote plugged in, while the
        // full size sim runs without a precomputed quote
        assert(result.isOk());
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                maximumInputFixed: 400n,
                isPartial: true,
                sushiQuote: mockSizeQuote,
            }),
        );
        expect((simulatorWithArgsSpy as Mock).mock.calls[0][0].sushiQuote).toBeUndefined();
    });

    it("should try partial trade if full trade fails with non-NoRoute reason", async () => {
        const mockFullTradeError = Result.err({
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 500n,
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
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
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

    it("should try partial trade if full trade fails with NoRoute reason", async () => {
        const mockFullTradeError = Result.err({
            reason: SimulationHaltReason.NoRoute,
            spanAttributes: { error: "no route" },
            noneNodeError: "no route for pair trade size",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 500n,
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
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
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

    it("should return error if partial trade size cannot be found", async () => {
        const mockFullTradeError = Result.err({
            type: TradeType.Router,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });

        (trySimulateTradeSpy as Mock).mockResolvedValue(mockFullTradeError);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.NoWay,
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
        expect(result.error.noneNodeError).toBe("order ratio issue");
        expect(result.error.type).toBe("router");
        expect(result.error.spanAttributes).toEqual({
            "full.error": "ratio too high",
            "partial.error": "found no route for any trade size",
        });
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "ratio too high" },
            "full",
        );
    });

    it("should return error if partial trade simulation also fails", async () => {
        const mockFullTradeError = Result.err({
            type: TradeType.Balancer,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "no opportunity" },
            noneNodeError: "partial failed",
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeError);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 1500n,
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
        expect(result.error.noneNodeError).toBe("order ratio issue"); // from full trade error
        expect(result.error.type).toBe("balancer");
        expect(result.error.spanAttributes).toEqual({
            "full.error": "ratio too high",
            "partial.error": "no opportunity",
        });
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "ratio too high" },
            "full",
        );
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "no opportunity" },
            "partial",
        );
    });

    it("should return success result if partial trade simulation succeeds", async () => {
        const mockFullTradeError = Result.err({
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 75n,
            oppBlockNumber: 123,
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 500n,
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
        expect(result.value.estimatedProfit).toBe(75n);
        expect(result.value.oppBlockNumber).toBe(123);
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
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
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
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "ratio too high" },
            "full",
        );
    });

    it("should backoff with halved trade sizes when partial trade fails with MinimalOutputBalanceViolation", async () => {
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
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
            .mockResolvedValueOnce(mockFullTradeError) // full size
            .mockResolvedValueOnce(mockViolationError) // partial size 1000n
            .mockResolvedValueOnce(mockViolationError) // partialFallback1 500n
            .mockResolvedValueOnce(mockFallbackSuccess); // partialFallback2 250n
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 1000n,
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
        expect(result.value.estimatedProfit).toBe(25n);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(4);
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({ maximumInputFixed: 500n, isPartial: true }),
        );
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({ maximumInputFixed: 250n, isPartial: true }),
        );
        // fallback sims never get a precomputed quote, their halved
        // sizes differ from the size the search probed
        expect((simulatorWithArgsSpy as Mock).mock.calls[2][0].sushiQuote).toBeUndefined();
        expect((simulatorWithArgsSpy as Mock).mock.calls[3][0].sushiQuote).toBeUndefined();
    });

    it("should return error with MinimalOutputBalanceViolation reason when all backoff steps fail", async () => {
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockViolationError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: {
                error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
            },
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError) // full size
            .mockResolvedValue(mockViolationError); // partial + all fallbacks
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 1024000n,
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
        expect(result.error.noneNodeError).toBe("order ratio issue");
        // 1 full + 1 partial + 4 fallbacks
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(6);
        expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ maximumInputFixed: 64000n, isPartial: true }),
        );
        expect(result.error.spanAttributes["full.error"]).toBe("ratio too high");
        expect(result.error.spanAttributes["partial.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["partialFallback1.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["partialFallback4.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["partialFallback5.error"]).toBeUndefined();
    });

    it("should stop backoff when a step fails with an error other than MinimalOutputBalanceViolation", async () => {
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
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
            .mockResolvedValueOnce(mockFullTradeError) // full size
            .mockResolvedValueOnce(mockViolationError) // partial size
            .mockResolvedValueOnce(mockOtherError); // partialFallback1
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 1000n,
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
        // 1 full + 1 partial + 1 fallback, stopped early
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(3);
        expect(result.error.spanAttributes["partialFallback1.error"]).toBe("some other revert");
        expect(result.error.spanAttributes["partialFallback2.error"]).toBeUndefined();
    });

    it("should skip backoff when routerPartialFallback is disabled in config", async () => {
        mockRainSolver.appOptions.routerPartialFallback = false;
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockViolationError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: {
                error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
            },
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError) // full size
            .mockResolvedValue(mockViolationError); // partial size
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size: 1000n,
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
        // only 1 full + 1 partial, no fallback attempts despite the violation error
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes["partial.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["partialFallback1.error"]).toBeUndefined();
    });

    it("should run backoff on any partial failure for max owner with strict check enabled", async () => {
        mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
        mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" }, // NOT a needsRetry error
        });
        const mockFallbackSuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { foundOpp: true },
            estimatedProfit: 25n,
            oppBlockNumber: 123,
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError) // full size
            .mockResolvedValueOnce(mockPartialError) // partial size
            .mockResolvedValueOnce(mockFallbackSuccess); // partialFallback1
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.PriceMismatch,
            size: 1000n,
            quote: { route: { pcMap: new Map() } },
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

        // the non retry partial failure still triggers the backoff
        // since the owner has a max profile and strict check is on
        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(25n);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(3);
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({ maximumInputFixed: 500n, isPartial: true }),
        );
    });

    it("should not run backoff on non retry failure for max owner when strict check is disabled", async () => {
        mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = false;
        mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" }, // NOT a needsRetry error
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValue(mockPartialError);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.PriceMismatch,
            size: 1000n,
            quote: { route: { pcMap: new Map() } },
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
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2); // no fallback attempts
        expect(result.error.spanAttributes["partialFallback1.error"]).toBeUndefined();
    });

    it("should not run backoff on non retry failure for non max owner with strict check enabled", async () => {
        mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
        mockRainSolver.appOptions.ownerProfile = { "0xowner": 100 }; // not max profile
        const mockFullTradeError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" }, // NOT a needsRetry error
        });

        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValue(mockPartialError);
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.PriceMismatch,
            size: 1000n,
            quote: { route: { pcMap: new Map() } },
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
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2); // no fallback attempts
        expect(result.error.spanAttributes["partialFallback1.error"]).toBeUndefined();
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
        expect(mockRainSolver.state.router.findLargestTradeSize).not.toHaveBeenCalled();
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
            "full.error": "dryrun failed",
            "secondary.full.error": "retry dryrun failed",
        });
        expect(simulatorWithArgsSpy).toHaveBeenCalledTimes(2);
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "dryrun failed" },
            "full",
        );
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "retry dryrun failed" },
            "full",
        );
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            "secondary",
        );
        expect(mockRainSolver.state.router.findLargestTradeSize).not.toHaveBeenCalled();
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
