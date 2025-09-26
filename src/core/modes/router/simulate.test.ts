import { RainSolver } from "../..";
import { TradeType } from "../../types";
import { Order, Pair } from "../../../order";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { ABI, Dispair, Result } from "../../../common";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { RainSolverRouterError, RainSolverRouterErrorType, RouterType } from "../../../router";
import {
    RouterTradeSimulator,
    SimulateRouterTradeArgs,
    RouterTradePreparedParams,
} from "./simulate";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskError,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

vi.mock("../../../task", async (importOriginal) => ({
    ...(await importOriginal()),
    getEnsureBountyTaskBytecode: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn(),
}));

function makeOrderDetails(ratio = ONE18): Pair {
    return {
        orderbook: "0xorderbook",
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        takeOrder: { struct: { order: { type: Order.Type.V3 } }, quote: { ratio } },
    } as Pair;
}

describe("Test RouterTradeSimulator", () => {
    let mockSolver: RainSolver;
    let mockSigner: RainSolverSigner;
    let tradeArgs: SimulateRouterTradeArgs;
    let simulator: RouterTradeSimulator;
    let preparedParams: RouterTradePreparedParams;
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
        mockSolver = {
            state: {
                gasPrice: 1000000000000000000n,
                gasLimitMultiplier: 1.5,
                chainConfig: {
                    isSpecialL2: true,
                },
                router: {
                    getTradeParams: vi.fn(),
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        dispair,
                        destination,
                    }),
                },
            },
            appOptions: {
                gasLimitMultiplier: 1.5,
                gasCoveragePercentage: "100",
            },
            client: {},
        } as any as RainSolver;
        mockSigner = { account: { address: "0xsigner" } } as any as RainSolverSigner;
        tradeArgs = {
            type: TradeType.Router,
            solver: mockSolver,
            orderDetails: makeOrderDetails(),
            signer: mockSigner,
            ethPrice: "1.2",
            toToken: { address: "0xTo", decimals: 18, symbol: "TO" } as any,
            fromToken: { address: "0xFrom", decimals: 18, symbol: "FROM" } as any,
            maximumInputFixed: 2n * ONE18,
            blockNumber: 123n,
            isPartial: false,
        };
        preparedParams = {
            type: TradeType.RouteProcessor,
            rawtx: {
                from: "0xfrom",
                to: "0xto",
                data: "0xdata",
            },
            price: 3n,
            minimumExpected: 12n,
            takeOrdersConfigStruct: {} as any,
        };
        simulator = new RouterTradeSimulator(tradeArgs);
    });

    describe("Test prepareTradeParams method", async () => {
        it("should return error if getTradeParams fails", async () => {
            const error = new RainSolverRouterError(
                "some error",
                RainSolverRouterErrorType.FetchFailed,
            );
            (mockSolver.state.router.getTradeParams as Mock).mockResolvedValueOnce(
                Result.err(error),
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Router);
            expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
            expect(result.error.spanAttributes["error"]).toBe("some error");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["amountIn"]).toBe(
                formatUnits(tradeArgs.maximumInputFixed, 18),
            );
            expect(result.error.spanAttributes["oppBlockNumber"]).toBe(
                Number(tradeArgs.blockNumber),
            );
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledWith({
                state: mockSolver.state,
                orderDetails: tradeArgs.orderDetails,
                fromToken: tradeArgs.fromToken,
                toToken: tradeArgs.toToken,
                maximumInput: scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ),
                signer: tradeArgs.signer,
                blockNumber: tradeArgs.blockNumber,
                isPartial: tradeArgs.isPartial,
            });
            expect(mockSolver.state.contracts.getAddressesForTrade).not.toHaveBeenCalled();
        });

        it("should return error if getTradeParams fails with no route", async () => {
            const error = new RainSolverRouterError(
                "some error",
                RainSolverRouterErrorType.NoRouteFound,
            );
            (mockSolver.state.router.getTradeParams as Mock).mockResolvedValueOnce(
                Result.err(error),
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Router);
            expect(result.error.reason).toBe(SimulationHaltReason.NoRoute);
            expect(result.error.spanAttributes["route"]).toBe("no way for sushi and balancer");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["amountIn"]).toBe(
                formatUnits(tradeArgs.maximumInputFixed, 18),
            );
            expect(result.error.spanAttributes["oppBlockNumber"]).toBe(
                Number(tradeArgs.blockNumber),
            );
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledWith({
                state: mockSolver.state,
                orderDetails: tradeArgs.orderDetails,
                fromToken: tradeArgs.fromToken,
                toToken: tradeArgs.toToken,
                maximumInput: scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ),
                signer: tradeArgs.signer,
                blockNumber: tradeArgs.blockNumber,
                isPartial: tradeArgs.isPartial,
            });
            expect(mockSolver.state.contracts.getAddressesForTrade).not.toHaveBeenCalled();
        });

        it("should return error if market price is lower than order's ratio", async () => {
            const params = {
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: "Success",
                    price: ONE18 / 2n,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: ONE18 / 2n,
                },
                routeVisual: ["some route"],
                takeOrdersConfigStruct: {} as any,
            };
            (mockSolver.state.router.getTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(params),
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.RouteProcessor);
            expect(result.error.reason).toBe(SimulationHaltReason.OrderRatioGreaterThanMarketPrice);
            expect(result.error.spanAttributes["route"]).toEqual(["some route"]);
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["amountIn"]).toBe(
                formatUnits(tradeArgs.maximumInputFixed, 18),
            );
            expect(result.error.spanAttributes["oppBlockNumber"]).toBe(
                Number(tradeArgs.blockNumber),
            );
            expect(simulator.spanAttributes["amountOut"]).toBe(
                formatUnits(params.quote.amountOut, tradeArgs.toToken.decimals),
            );
            expect(simulator.spanAttributes["marketPrice"]).toBe(
                formatUnits(params.quote.price, 18),
            );
            expect(simulator.spanAttributes["route"]).toBe(params.routeVisual);
            expect(simulator.spanAttributes["error"]).toBe(
                "Order's ratio greater than market price",
            );
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledWith({
                state: mockSolver.state,
                orderDetails: tradeArgs.orderDetails,
                fromToken: tradeArgs.fromToken,
                toToken: tradeArgs.toToken,
                maximumInput: scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ),
                signer: tradeArgs.signer,
                blockNumber: tradeArgs.blockNumber,
                isPartial: tradeArgs.isPartial,
            });
            expect(mockSolver.state.contracts.getAddressesForTrade).not.toHaveBeenCalled();
        });

        it("should return success", async () => {
            const params = {
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer,
                    status: "Success",
                    price: 1234n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 1234n * ONE18,
                },
                routeVisual: ["some route"],
                takeOrdersConfigStruct: {} as any,
            };
            (mockSolver.state.router.getTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(params),
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isOk());
            expect(result.value.type).toBe(TradeType.Balancer);
            expect(result.value.rawtx).toEqual({
                to: "0xdestination",
                gasPrice: mockSolver.state.gasPrice,
            });
            expect(result.value.price).toBe(params.quote.price);
            expect(result.value.minimumExpected).toBe(0n);
            expect(result.value.takeOrdersConfigStruct).toBe(params.takeOrdersConfigStruct);
            expect(simulator.spanAttributes["route"]).toEqual(["some route"]);
            expect(simulator.spanAttributes["amountIn"]).toBe(
                formatUnits(tradeArgs.maximumInputFixed, 18),
            );
            expect(simulator.spanAttributes["oppBlockNumber"]).toBe(Number(tradeArgs.blockNumber));
            expect(simulator.spanAttributes["amountOut"]).toBe(
                formatUnits(params.quote.amountOut, tradeArgs.toToken.decimals),
            );
            expect(simulator.spanAttributes["marketPrice"]).toBe(
                formatUnits(params.quote.price, 18),
            );
            expect(simulator.spanAttributes["route"]).toBe(params.routeVisual);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledWith({
                state: mockSolver.state,
                orderDetails: tradeArgs.orderDetails,
                fromToken: tradeArgs.fromToken,
                toToken: tradeArgs.toToken,
                maximumInput: scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ),
                signer: tradeArgs.signer,
                blockNumber: tradeArgs.blockNumber,
                isPartial: tradeArgs.isPartial,
            });
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.Balancer,
            );
        });

        it("should return error when trade addresses are not configured", async () => {
            const params = {
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer,
                    status: "Success",
                    price: 1234n * ONE18,
                    route: {
                        route: {},
                        pcMap: new Map(),
                    },
                    amountOut: 1234n * ONE18,
                },
                routeVisual: ["some route"],
                takeOrdersConfigStruct: {} as any,
            };
            (mockSolver.state.router.getTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(params),
            );
            (mockSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValueOnce(
                undefined,
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Balancer);
            expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
            expect(result.error.spanAttributes["route"]).toEqual(["some route"]);
            expect(result.error.spanAttributes["amountIn"]).toBe(
                formatUnits(tradeArgs.maximumInputFixed, 18),
            );
            expect(result.error.spanAttributes["oppBlockNumber"]).toBe(
                Number(tradeArgs.blockNumber),
            );
            expect(result.error.spanAttributes["amountOut"]).toBe(
                formatUnits(params.quote.amountOut, tradeArgs.toToken.decimals),
            );
            expect(result.error.spanAttributes["marketPrice"]).toBe(
                formatUnits(params.quote.price, 18),
            );
            expect(result.error.spanAttributes["route"]).toBe(params.routeVisual);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.router.getTradeParams).toHaveBeenCalledWith({
                state: mockSolver.state,
                orderDetails: tradeArgs.orderDetails,
                fromToken: tradeArgs.fromToken,
                toToken: tradeArgs.toToken,
                maximumInput: scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ),
                signer: tradeArgs.signer,
                blockNumber: tradeArgs.blockNumber,
                isPartial: tradeArgs.isPartial,
            });
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.Balancer,
            );
        });
    });

    describe("Test setTransactionData method", async () => {
        it("should return error if getEnsureBountyTaskBytecode fails", async () => {
            const error = new EnsureBountyTaskError(
                "some error",
                EnsureBountyTaskErrorType.ComposeError,
            );
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.err(error));
            const getCalldataSpy = vi.spyOn(simulator, "getCalldata");

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.RouteProcessor);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(result.error.spanAttributes["error"]).toContain("some error");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["isNodeError"]).toBe(false);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.External,
                    inputToEthPrice: parseUnits(simulator.tradeArgs.ethPrice, 18),
                    outputToEthPrice: 0n,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                },
                simulator.tradeArgs.solver.state.client,
                dispair,
            );
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.RouteProcessor,
            );
            expect(encodeFunctionData).not.toHaveBeenCalled();
            expect(getCalldataSpy).not.toHaveBeenCalled();

            getCalldataSpy.mockRestore();
        });

        it("should return success", async () => {
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.ok("0xdata"));
            (encodeFunctionData as Mock).mockReturnValue("0xencodedData");
            const getCalldataSpy = vi.spyOn(simulator, "getCalldata");
            getCalldataSpy.mockReturnValue("0xencodedData");

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isOk());
            expect(preparedParams.rawtx.data).toBe("0xencodedData");
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.External,
                    inputToEthPrice: parseUnits(simulator.tradeArgs.ethPrice, 18),
                    outputToEthPrice: 0n,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                },
                simulator.tradeArgs.solver.state.client,
                dispair,
            );
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.RouteProcessor,
            );
            expect(getCalldataSpy).toHaveBeenCalledTimes(1);
            expect(getCalldataSpy).toHaveBeenCalledWith(preparedParams.takeOrdersConfigStruct, {
                evaluable: {
                    interpreter: dispair.interpreter as `0x${string}`,
                    store: dispair.store as `0x${string}`,
                    bytecode: "0xdata",
                },
                signedContext: [],
            });

            getCalldataSpy.mockRestore();
        });
    });

    describe("Test estimateProfit method", () => {
        it("should estimate profit correctly for typical values", () => {
            const orderDetails = {
                takeOrder: { quote: { ratio: 2n * ONE18 } }, // ratio = 2.0
            } as any;
            const ethPrice = 3n * ONE18; // 3 ETH
            const marketPrice = 4n * ONE18; // 4.0
            const maxInput = 10n * ONE18; // 10 units
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.ethPrice = formatUnits(ethPrice, 18);
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // marketAmountOut = (10 * 4) / 1 = 40
            // orderInput = (10 * 2) / 1 = 20
            // estimatedProfit = 40 - 20 = 20
            // final = (20 * 3) / 1 = 60
            const result = simulator.estimateProfit(marketPrice);
            expect(result).toBe(60n * ONE18);
        });

        it("should return 0 if marketPrice equals order ratio", () => {
            const orderDetails = {
                takeOrder: { quote: { ratio: 5n * ONE18 } },
            } as any;
            const ethPrice = 1n * ONE18;
            const marketPrice = 5n * ONE18;
            const maxInput = 2n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.ethPrice = formatUnits(ethPrice, 18);
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // marketAmountOut = (2 * 5) / 1 = 10
            // orderInput = (2 * 5) / 1 = 10
            // estimatedProfit = 0
            // final = 0
            const result = simulator.estimateProfit(marketPrice);
            expect(result).toBe(0n);
        });

        it("should return negative profit if order ratio > marketPrice", () => {
            const orderDetails = {
                takeOrder: { quote: { ratio: 8n * ONE18 } },
            } as any;
            const ethPrice = 2n * ONE18;
            const marketPrice = 5n * ONE18;
            const maxInput = 1n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.ethPrice = formatUnits(ethPrice, 18);
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // marketAmountOut = 5
            // orderInput = 8
            // estimatedProfit = -3
            // final = -6
            const result = simulator.estimateProfit(marketPrice);
            expect(result).toBe(-6n * ONE18);
        });
    });

    describe("Test getCalldata method", () => {
        it("should return for pair v3", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            const takeOrderConfig = { key: "value" } as any;
            const task = { task: "task-value" } as any;
            const result = simulator.getCalldata(takeOrderConfig, task);
            expect(result).toBe("0xcalldata");
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V4.Primary.Arb,
                functionName: "arb3",
                args: [simulator.tradeArgs.orderDetails.orderbook, takeOrderConfig, task],
            });
        });

        it("should return for pair v4", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            simulator.tradeArgs.orderDetails.takeOrder.struct.order.type = Order.Type.V4;
            const takeOrderConfig = { key: "value" } as any;
            const task = { task: "task-value" } as any;
            const result = simulator.getCalldata(takeOrderConfig, task);
            expect(result).toBe("0xcalldata");
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V5.Primary.Arb,
                functionName: "arb4",
                args: [simulator.tradeArgs.orderDetails.orderbook, takeOrderConfig, task],
            });
        });
    });
});
