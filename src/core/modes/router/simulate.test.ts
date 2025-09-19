import { Router } from "sushi";
import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { ONE18 } from "../../../math";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { SimulationResult } from "../../types";
import { Result, toFloat } from "../../../common";
import { getEnsureBountyTaskBytecode } from "../../../task";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    trySimulateTrade,
    findLargestTradeSize,
    SimulateRouteProcessorTradeArgs,
    RouteProcessorSimulationHaltReason,
} from "./simulate";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xdata"),
    encodeAbiParameters: vi.fn().mockReturnValue("0xparams"),
}));

vi.mock("./utils", () => ({
    estimateProfit: vi.fn().mockReturnValue(123n),
}));

vi.mock("../../../router", async (importOriginal) => ({
    ...(await importOriginal()),
    visualizeRoute: vi.fn().mockReturnValue(["routeVisual"]),
}));

vi.mock("../../../task", async (importOriginal) => ({
    ...(await importOriginal()),
    getEnsureBountyTaskBytecode: vi.fn().mockResolvedValue(Result.ok("0xbytecode")),
}));

vi.mock("../dryrun", () => ({
    dryrun: vi.fn(),
}));

vi.mock("sushi", async (importOriginal) => ({
    ...(await importOriginal()),
    Router: {
        findBestRoute: vi.fn(),
        routeProcessor4Params: vi.fn().mockReturnValue({ routeCode: "0xroute" }),
    },
}));

function makeOrderDetails(ratio = 1n * ONE18): Pair {
    return {
        orderbook: "0xorderbook",
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        takeOrder: { struct: {}, quote: { ratio } },
    } as Pair;
}

describe("Test trySimulateTrade", () => {
    let solver: RainSolver;
    let args: SimulateRouteProcessorTradeArgs;

    beforeEach(() => {
        vi.clearAllMocks();
        solver = {
            state: {
                gasPrice: 1n,
                dataFetcher: {
                    getCurrentPoolCodeMap: vi.fn().mockReturnValue("mockPcMap"),
                },
                chainConfig: {
                    id: 1,
                    isSpecialL2: false,
                    routeProcessors: { "4": "0xprocessor" },
                },
                dispair: {
                    interpreter: "0xint",
                    store: "0xstore",
                },
                client: {},
            },
            appOptions: {
                arbAddress: "0xarb",
                gasCoveragePercentage: "0",
                maxRatio: false,
                route: undefined,
                gasLimitMultiplier: 120,
            },
        } as any;
        args = {
            orderDetails: makeOrderDetails(),
            signer: { account: { address: "0xsigner" } },
            ethPrice: "1",
            toToken: { address: "0xTo", decimals: 18, symbol: "TO" },
            fromToken: { address: "0xFrom", decimals: 18, symbol: "FROM" },
            maximumInputFixed: 10n * ONE18,
            blockNumber: 123n,
            isPartial: false,
        } as any;
    });

    it("should return NoRoute if Router.findBestRoute returns NoWay", async () => {
        (Router.findBestRoute as Mock).mockReturnValueOnce({ status: "NoWay" });

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouteProcessorSimulationHaltReason.NoRoute);
        expect(result.error.spanAttributes.route).toBe("no-way");
        expect(result.error.type).toBe("routeProcessor");
    });

    it("should return OrderRatioGreaterThanMarketPrice if price < order ratio", async () => {
        (Router.findBestRoute as Mock).mockReturnValueOnce({
            status: "OK",
            amountOutBI: 1n * ONE18,
            legs: [],
        });
        // Set order ratio higher than price
        args.orderDetails = makeOrderDetails(2n * ONE18);

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(
            RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        );
        expect(result.error.spanAttributes.error).toBe("Order's ratio greater than market price");
        expect(Array.isArray(result.error.spanAttributes.route)).toBe(true);
        expect(result.error.type).toBe("routeProcessor");
    });

    it("should return NoOpportunity if initial dryrun fails", async () => {
        (Router.findBestRoute as Mock).mockReturnValueOnce({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        (dryrun as Mock).mockResolvedValueOnce(
            Result.err({
                spanAttributes: { stage: 1 },
                reason: RouteProcessorSimulationHaltReason.NoOpportunity,
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouteProcessorSimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes.stage).toBe(1);
        expect(result.error.spanAttributes.oppBlockNumber).toBe(123);
        expect(result.error.type).toBe("routeProcessor");
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage 0", async () => {
        (Router.findBestRoute as Mock).mockReturnValue({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        (dryrun as Mock).mockResolvedValueOnce(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "0";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(123n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(200n);
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xarb");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("routeProcessor");

        // Assert encodeFunctionData was called correctly
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // ArbAbi
            functionName: "arb4",
            args: [
                "0xorderbook",
                {
                    data: "0xparams",
                    maximumIORatio: (toFloat(2000000000000000000n, 18) as any).value,
                    maximumInput: expect.any(String),
                    minimumInput: expect.any(String),
                    orders: [{}],
                },
                {
                    evaluable: {
                        bytecode: "0x",
                        interpreter: "0xint",
                        store: "0xstore",
                    },
                    signedContext: [],
                },
            ],
        });

        // Assert encodeAbiParameters was called correctly
        expect(encodeAbiParameters).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ type: "bytes" })]),
            ["0xroute"],
        );
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage not 0", async () => {
        (Router.findBestRoute as Mock).mockReturnValue({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        (dryrun as Mock)
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                    estimatedGasCost: 200n,
                    spanAttributes: { initial: "data" },
                }),
            )
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 150n, totalGasCost: 300n, gasPrice: 1n },
                    estimatedGasCost: 300n,
                    spanAttributes: { final: "data" },
                }),
            );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "100";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(123n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(300n);
        expect(result.value.spanAttributes.initial).toBe("data");
        expect(result.value.spanAttributes.final).toBe("data");
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xarb");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("routeProcessor");

        // verify called times
        expect(encodeFunctionData).toHaveBeenCalledTimes(3);
        expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
    });

    it("should handle isPartial flag correctly in takeOrdersConfigStruct", async () => {
        (Router.findBestRoute as Mock).mockReturnValue({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        (dryrun as Mock).mockResolvedValue(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        args.isPartial = true;

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.type).toBe("routeProcessor");

        // verify encodeAbiParameters was called with partial flag affecting maximumInput
        expect(encodeAbiParameters).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ type: "bytes" })]),
            ["0xroute"],
        );
    });

    it("should return NoOpportunity if final dryrun fails when gasCoveragePercentage is not 0", async () => {
        (Router.findBestRoute as Mock).mockReturnValue({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        (dryrun as Mock)
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                    estimatedGasCost: 200n,
                    spanAttributes: {},
                }),
            )
            .mockResolvedValueOnce(
                Result.err({
                    spanAttributes: { stage: 2 },
                    reason: RouteProcessorSimulationHaltReason.NoOpportunity,
                }),
            );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "100";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouteProcessorSimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes.stage).toBe(2);
        expect(result.error.type).toBe("routeProcessor");

        // verify encodeFunctionData was called twice (for both dryruns)
        expect(encodeFunctionData).toHaveBeenCalledTimes(2);
        expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
    });

    it("should return error when getEnsureBountyTaskBytecode fails", async () => {
        (Router.findBestRoute as Mock).mockReturnValue({
            status: "OK",
            amountOutBI: 20n * ONE18,
            legs: [],
        });
        args.orderDetails = makeOrderDetails(1n * ONE18);
        (getEnsureBountyTaskBytecode as Mock).mockResolvedValue(Result.err("error"));

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouteProcessorSimulationHaltReason.NoOpportunity);
        expect(result.error.type).toBe("routeProcessor");
    });
});

describe("Test findLargestTradeSize", () => {
    let solver: RainSolver;
    let fromToken: Token;
    let toToken: Token;
    let maximumInputFixed: bigint;

    beforeEach(() => {
        vi.clearAllMocks();
        solver = {
            state: {
                gasPrice: 1n,
                dataFetcher: {
                    getCurrentPoolCodeMap: vi.fn().mockReturnValue("mockPcMap"),
                },
                chainConfig: {
                    id: 1,
                },
            },
            appOptions: {
                route: undefined,
            },
        } as any;
        fromToken = { address: "0xFrom", decimals: 18 } as any;
        toToken = { address: "0xTo", decimals: 18 } as any;
        maximumInputFixed = 10n * ONE18;
    });

    it("should return undefined if no valid trade size found (all NoWay)", () => {
        (Router.findBestRoute as Mock).mockReturnValue({ status: "NoWay" });

        const result = findLargestTradeSize.call(
            solver,
            makeOrderDetails(1n * ONE18),
            toToken,
            fromToken,
            maximumInputFixed,
        );

        expect(result).toBeUndefined();
    });

    it("should return the largest valid trade size when some routes are valid", () => {
        (Router.findBestRoute as Mock).mockImplementation(() => {
            return { status: "OK", amountOutBI: 4n * ONE18 };
        });

        const orderDetails = makeOrderDetails(1n * ONE18);

        const result = findLargestTradeSize.call(
            solver,
            orderDetails,
            toToken,
            fromToken,
            maximumInputFixed,
        );

        expect(typeof result).toBe("bigint");
        expect(result).toBe(3999999761581420898n);
    });

    it("should return undefined if all OK routes have price < ratio", () => {
        (Router.findBestRoute as Mock).mockImplementation(() => ({
            status: "OK",
            amountOutBI: 1n, // price = 1
        }));
        const orderDetails = makeOrderDetails(2n * ONE18); // ratio = 2

        const result = findLargestTradeSize.call(
            solver,
            orderDetails,
            toToken,
            fromToken,
            maximumInputFixed,
        );

        expect(result).toBeUndefined();
    });

    it("should handle fromToken decimals other than 18", () => {
        fromToken = { address: "0xFrom", decimals: 6 } as any;
        (Router.findBestRoute as Mock).mockReturnValue({ status: "OK", amountOutBI: 2n * ONE18 });
        const orderDetails = makeOrderDetails(1n * ONE18);

        const result = findLargestTradeSize.call(
            solver,
            orderDetails,
            toToken,
            fromToken,
            maximumInputFixed,
        );

        expect(typeof result).toBe("bigint");
        expect(result).toBeGreaterThan(0n);
    });
});
