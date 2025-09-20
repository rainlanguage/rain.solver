import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { ONE18 } from "../../../math";
import { Result } from "../../../common";
import { Pair } from "../../../order";
import { SimulationResult } from "../../types";
import { encodeFunctionData, maxUint256 } from "viem";
import { getEnsureBountyTaskBytecode } from "../../../task";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { trySimulateTrade, SimulateRouterTradeArgs, RouterSimulationHaltReason } from "./simulate";
import {
    RouterType,
    RouteStatus,
    RainSolverRouterError,
    RainSolverRouterErrorType,
} from "../../../router/types";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xdata"),
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
    let args: SimulateRouterTradeArgs;

    beforeEach(() => {
        vi.clearAllMocks();
        solver = {
            state: {
                gasPrice: 1n,
                router: {
                    getTradeParams: vi.fn(),
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
                balancerArbAddress: "0xbalancerArb",
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

    it("should return NoRoute if getTradeParams returns NoRouteFound", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.err(new RainSolverRouterError("", RainSolverRouterErrorType.NoRouteFound)),
        );

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouterSimulationHaltReason.NoRoute);
        expect(result.error.spanAttributes.route).toBe("no way for sushi and balancer");
        expect(result.error.type).toBe("router");
    });

    it("should return OrderRatioGreaterThanMarketPrice if price < order ratio", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: ONE18 / 10n,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );

        // Set order ratio higher than price
        args.orderDetails = makeOrderDetails(2n * ONE18);

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(
            RouterSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        );
        expect(result.error.spanAttributes.error).toBe("Order's ratio greater than market price");
        expect(Array.isArray(result.error.spanAttributes.route)).toBe(true);
        expect(result.error.type).toBe("routeProcessor");
    });

    it("should return NoOpportunity if initial dryrun fails", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );
        (dryrun as Mock).mockResolvedValueOnce(
            Result.err({
                spanAttributes: { stage: 1 },
                reason: RouterSimulationHaltReason.NoOpportunity,
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouterSimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes.stage).toBe(1);
        expect(result.error.spanAttributes.oppBlockNumber).toBe(123);
        expect(result.error.type).toBe("balancer");
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage 0", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {
                    data: "0xparams",
                    maximumIORatio: 2000000000000000000n,
                    maximumInput: maxUint256,
                    minimumInput: 1n,
                    orders: [{}],
                },
            }),
        );
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
            functionName: "arb3",
            args: [
                "0xorderbook",
                {
                    data: "0xparams",
                    maximumIORatio: 2000000000000000000n,
                    maximumInput: maxUint256,
                    minimumInput: 1n,
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
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage not 0", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );
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
        expect(result.value.rawtx).toHaveProperty("to", "0xbalancerArb");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("balancer");

        // verify called times
        expect(encodeFunctionData).toHaveBeenCalledTimes(3);
    });

    it("should handle isPartial flag correctly in takeOrdersConfigStruct", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );
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
    });

    it("should return NoOpportunity if final dryrun fails when gasCoveragePercentage is not 0", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );
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
                    reason: RouterSimulationHaltReason.NoOpportunity,
                }),
            );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "100";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouterSimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes.stage).toBe(2);
        expect(result.error.type).toBe("routeProcessor");

        // verify encodeFunctionData was called twice (for both dryruns)
        expect(encodeFunctionData).toHaveBeenCalledTimes(2);
    });

    it("should return error when getEnsureBountyTaskBytecode fails", async () => {
        (solver.state.router.getTradeParams as Mock).mockResolvedValue(
            Result.ok({
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer,
                    status: RouteStatus.Success,
                    price: 2n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 20n * ONE18,
                },
                routeVisual: ["route visual"],
                takeOrdersConfigStruct: {},
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        (getEnsureBountyTaskBytecode as Mock).mockResolvedValue(Result.err("error"));

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error).toHaveProperty("reason");
        expect(result.error.reason).toBe(RouterSimulationHaltReason.NoOpportunity);
        expect(result.error.type).toBe("balancer");
    });
});
