import { Result } from "../../../common";
import { SimulationResult } from "../../types";
import { findBestBalancerTrade } from "./index";
import { extendObjectWithHeader } from "../../../logger";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { trySimulateTrade, BalancerRouterSimulationHaltReason } from "./simulate";

vi.mock("./simulate", async (importOriginal) => ({
    ...(await importOriginal()),
    trySimulateTrade: vi.fn(),
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

describe("Test findBestBalancerTrade", () => {
    let mockRainSolver: any;
    let orderDetails: any;
    let signer: any;
    let ethPrice: string;
    let toToken: any;
    let fromToken: any;
    let blockNumber: bigint;

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
            takeOrder: { quote: { maxOutput: 1000n } },
        };

        signer = { account: { address: "0xsigner" } };
        ethPrice = "2000";
        toToken = { address: "0xTo", decimals: 18, symbol: "TO" };
        fromToken = { address: "0xFrom", decimals: 18, symbol: "FROM" };
        blockNumber = 123n;
    });

    it("should return success result if full trade size simulation succeeds", async () => {
        const mockSuccessResult = Result.ok({
            type: "balancer",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        (trySimulateTrade as Mock).mockResolvedValue(mockSuccessResult);

        const result: SimulationResult = await findBestBalancerTrade.call(
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
        expect(trySimulateTrade).toHaveBeenCalledWith({
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
            reason: BalancerRouterSimulationHaltReason.NoRoute,
            spanAttributes: { route: "no-way" },
            noneNodeError: "no route available",
        });
        (trySimulateTrade as Mock).mockResolvedValue(mockErrorResult);

        const result: SimulationResult = await findBestBalancerTrade.call(
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
        expect(result.error.type).toBe("balancer");
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { route: "no-way" },
            "full",
        );
    });

    it("should return early if ethPrice is unknown", async () => {
        const result: SimulationResult = await findBestBalancerTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            "",
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe("balancer");
        expect(result.error.spanAttributes.error).toBe(
            "no route to get price of input token to eth",
        );
    });
});
