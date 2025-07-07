import { Result } from "../../../common";
import { SimulationResult } from "../../types";
import { findBestRouteProcessorTrade } from "./index";
import { extendObjectWithHeader } from "../../../logger";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    trySimulateTrade,
    findLargestTradeSize,
    RouteProcessorSimulationHaltReason,
} from "./simulate";

// Mocks
vi.mock("./simulate", () => ({
    trySimulateTrade: vi.fn(),
    findLargestTradeSize: vi.fn(),
    RouteProcessorSimulationHaltReason: {
        NoRoute: "NoRoute",
        OrderRatioGreaterThanMarketPrice: "OrderRatioGreaterThanMarketPrice",
        NoOpportunity: "NoOpportunity",
    },
}));

vi.mock("../../../logger", () => ({
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

describe("Test findBestRouteProcessorTrade", () => {
    let mockRainSolver: any;
    let orderDetails: any;
    let signer: any;
    let ethPrice: string;
    let toToken: any;
    let fromToken: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockRainSolver = {
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
            },
        };

        orderDetails = {
            takeOrders: [{ quote: { maxOutput: 1000n } }, { quote: { maxOutput: 2000n } }],
        };

        signer = { account: { address: "0xsigner" } };
        ethPrice = "2000";
        toToken = { address: "0xTo", decimals: 18, symbol: "TO" };
        fromToken = { address: "0xFrom", decimals: 18, symbol: "FROM" };
    });

    it("should return success result if full trade size simulation succeeds", async () => {
        const mockSuccessResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        (trySimulateTrade as Mock).mockResolvedValue(mockSuccessResult);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(100n);
        expect(result.value.oppBlockNumber).toBe(123);
        expect(result.value.type).toBe("routeProcessor");
        expect(trySimulateTrade).toHaveBeenCalledWith({
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 3000n, // 1000 + 2000
            ethPrice,
            isPartial: false,
            blockNumber: 123n,
        });
    });

    it("should return error if no route found", async () => {
        const mockErrorResult = Result.err({
            reason: RouteProcessorSimulationHaltReason.NoRoute,
            spanAttributes: { route: "no-way" },
            noneNodeError: "no route available",
        });
        (trySimulateTrade as Mock).mockResolvedValue(mockErrorResult);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("no route available");
        expect(result.error.type).toBe("routeProcessor");
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { route: "no-way" },
            "full",
        );
    });

    it("should try partial trade if full trade fails with non-NoRoute reason", async () => {
        const mockFullTradeError = Result.err({
            reason: RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });

        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (findLargestTradeSize as Mock).mockReturnValue(1500n);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(50n);
        expect(result.value.type).toBe("routeProcessor");
        expect(findLargestTradeSize).toHaveBeenCalledWith(orderDetails, toToken, fromToken, 3000n);
        expect(trySimulateTrade).toHaveBeenCalledTimes(2);
        expect(trySimulateTrade).toHaveBeenLastCalledWith({
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 3000n, // still uses original maximumInput
            ethPrice,
            isPartial: true,
            blockNumber: 123n,
        });
    });

    it("should return error if partial trade size cannot be found", async () => {
        const mockFullTradeError = Result.err({
            reason: RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });

        (trySimulateTrade as Mock).mockResolvedValue(mockFullTradeError);
        (findLargestTradeSize as Mock).mockReturnValue(undefined);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("order ratio issue");
        expect(result.error.type).toBe("routeProcessor");
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "ratio too high" },
            "full",
        );
    });

    it("should return error if partial trade simulation also fails", async () => {
        const mockFullTradeError = Result.err({
            reason: RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeError = Result.err({
            reason: RouteProcessorSimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "no opportunity" },
            noneNodeError: "partial failed",
        });

        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeError);
        (findLargestTradeSize as Mock).mockReturnValue(1500n);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("order ratio issue"); // from full trade error
        expect(result.error.type).toBe("routeProcessor");
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
            reason: RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            spanAttributes: { error: "ratio too high" },
            noneNodeError: "order ratio issue",
        });
        const mockPartialTradeSuccess = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 75n,
            oppBlockNumber: 123,
        });

        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockFullTradeError)
            .mockResolvedValueOnce(mockPartialTradeSuccess);
        (findLargestTradeSize as Mock).mockReturnValue(1800n);

        const result: SimulationResult = await findBestRouteProcessorTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(75n);
        expect(result.value.oppBlockNumber).toBe(123);
        expect(result.value.type).toBe("routeProcessor");
        expect(findLargestTradeSize).toHaveBeenCalledWith(orderDetails, toToken, fromToken, 3000n);
        expect(trySimulateTrade).toHaveBeenCalledTimes(2);
        expect(trySimulateTrade).toHaveBeenLastCalledWith({
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 3000n,
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
});
