import { Result } from "../../../common";
import { findBestRouterTrade } from "./index";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { extendObjectWithHeader } from "../../../common";
import { SimulationResult, TradeType } from "../../types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// Mocks
vi.mock("../../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    extendObjectWithHeader: vi.fn(),
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

    beforeEach(() => {
        vi.clearAllMocks();

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
            },
        };

        orderDetails = {
            takeOrder: { quote: { maxOutput: 1000n } },
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
        expect(result.value.spanAttributes.foundOpp).toBe(true);
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
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { route: "no-way" },
            "full",
        );
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
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(50n);
        expect(result.value.type).toBe("routeProcessor");
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledWith(
            orderDetails,
            toToken,
            fromToken,
            1000n,
            100n,
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
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue(1500n);

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
        expect(result.value.spanAttributes.foundOpp).toBe(true);
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
});
