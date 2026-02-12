import { RainSolver } from "../..";
import { TradeType } from "../../types";
import { Order, PairV4 } from "../../../order";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { ABI, Dispair, maxFloat, minFloat, Result } from "../../../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { encodeAbiParameters, encodeFunctionData, formatUnits, parseUnits } from "viem";
import {
    RaindexRouterTradeSimulator,
    SimulateRaindexRouterTradeArgs,
    RaindexRouterTradePreparedParams,
} from "./simulation";
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
    encodeAbiParameters: vi.fn().mockReturnValue("0xexchangeData"),
}));

function makeOrderDetails(id = "0xhash"): PairV4 {
    return {
        orderbook: "0xorderbook",
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        buyTokenSymbol: "BUY",
        sellTokenSymbol: "SELL",
        takeOrder: {
            id,
            struct: {
                order: { type: Order.Type.V4, owner: "0xowner" },
                orderbook: { id: "0xorderbook" },
            },
            quote: {
                maxOutput: parseUnits("100", 18),
                ratio: parseUnits("1", 18),
            },
        },
    } as any;
}

describe("Test RaindexRouterTradeSimulator", () => {
    let mockSolver: RainSolver;
    let mockSigner: RainSolverSigner;
    let tradeArgs: SimulateRaindexRouterTradeArgs;
    let simulator: RaindexRouterTradeSimulator;
    let preparedParams: RaindexRouterTradePreparedParams;
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
                chainConfig: {
                    id: 1,
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        dispair,
                        destination,
                    }),
                },
                client: {},
            },
            appOptions: {
                gasCoveragePercentage: "100",
            },
        } as any as RainSolver;
        mockSigner = { account: { address: "0xsigner" } } as any as RainSolverSigner;
        tradeArgs = {
            type: TradeType.Raindex,
            solver: mockSolver,
            orderDetails: makeOrderDetails("0xhash1"),
            counterpartyOrderDetails: makeOrderDetails("0xhash2"),
            signer: mockSigner,
            maximumInputFixed: parseUnits("50", 18),
            blockNumber: 123n,
            counterpartyInputToEthPrice: parseUnits("2", 18),
            counterpartyOutputToEthPrice: parseUnits("3", 18),
            quote: {
                amountOut: 100n,
                price: parseUnits("1.5", 18),
                route: {
                    pcMap: new Map(),
                    route: { legs: [] },
                },
            } as any,
            profit: parseUnits("10", 18),
            rpParams: {
                routeCode: "0xroutecode",
            } as any,
            routeVisual: ["TokenA", "TokenB", "TokenC"],
        };
        preparedParams = {
            type: TradeType.Raindex,
            rawtx: {
                to: destination,
                gasPrice: mockSolver.state.gasPrice,
            },
            takeOrders: [
                {
                    minimumIO: minFloat(18),
                    maximumIO: maxFloat(18),
                    maximumIORatio: maxFloat(18),
                    orders: [tradeArgs.orderDetails.takeOrder.struct],
                    data: "0x",
                    IOIsInput: false,
                },
                {
                    minimumIO: minFloat(18),
                    maximumIO: maxFloat(18),
                    maximumIORatio: maxFloat(18),
                    orders: [tradeArgs.counterpartyOrderDetails.takeOrder.struct],
                    data: "0x",
                    IOIsInput: false,
                },
            ],
            exchangeData: "0xexchangedata",
            minimumExpected: 0n,
        };
        simulator = new RaindexRouterTradeSimulator(tradeArgs);
    });

    describe("Test withArgs static method", () => {
        it("should create instance with provided args", () => {
            const instance = RaindexRouterTradeSimulator.withArgs(tradeArgs);
            expect(instance).toBeInstanceOf(RaindexRouterTradeSimulator);
            expect(instance.tradeArgs).toBe(tradeArgs);
        });
    });

    describe("Test prepareTradeParams method", () => {
        it("should set span attributes correctly", async () => {
            const result = await simulator.prepareTradeParams();
            assert(result.isOk());

            expect(simulator.spanAttributes["against"]).toBe("0xhash2");
            expect(simulator.spanAttributes["counterpartyInputToEthPrice"]).toBe(
                formatUnits(tradeArgs.counterpartyInputToEthPrice, 18),
            );
            expect(simulator.spanAttributes["counterpartyOutputToEthPrice"]).toBe(
                formatUnits(tradeArgs.counterpartyOutputToEthPrice, 18),
            );
            expect(simulator.spanAttributes["route"]).toEqual(tradeArgs.routeVisual);
            expect(simulator.spanAttributes["routeQuote"]).toBe(
                formatUnits(tradeArgs.quote.price, 18),
            );
            expect(simulator.spanAttributes["oppBlockNumber"]).toBe(Number(tradeArgs.blockNumber));
            expect(simulator.spanAttributes["counterpartyPair"]).toBe("BUY/SELL");
            expect(simulator.spanAttributes["counterpartyOrderQuote"]).toBe(
                JSON.stringify({
                    maxOutput: formatUnits(
                        tradeArgs.counterpartyOrderDetails.takeOrder.quote!.maxOutput,
                        18,
                    ),
                    ratio: formatUnits(
                        tradeArgs.counterpartyOrderDetails.takeOrder.quote!.ratio,
                        18,
                    ),
                }),
            );
            expect(simulator.spanAttributes["maxInput"]).toBe(parseUnits("50", 18).toString());
        });

        it("should return error when trade addresses are not configured", async () => {
            (mockSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValueOnce(
                undefined,
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Raindex);
            expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
            expect(result.error.spanAttributes["error"]).toContain(
                "Cannot trade as generic arb address is not configured",
            );
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.Raindex,
            );
        });

        it("should return success with correct parameters", async () => {
            const result = await simulator.prepareTradeParams();
            assert(result.isOk());

            expect(result.value.type).toBe(TradeType.Raindex);
            expect(result.value.rawtx).toEqual({
                to: destination,
                gasPrice: mockSolver.state.gasPrice,
            });
            expect(result.value.minimumExpected).toBe(0n);
            expect(result.value.takeOrders).toHaveLength(2);
            expect(result.value.takeOrders[0].orders).toEqual([
                tradeArgs.orderDetails.takeOrder.struct,
            ]);
            expect(result.value.takeOrders[1].orders).toEqual([
                tradeArgs.counterpartyOrderDetails.takeOrder.struct,
            ]);
            expect(result.value.exchangeData).toBe("0xexchangeData");
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.Raindex,
            );
        });

        it("should encode exchange data with correct route leg", async () => {
            const result = await simulator.prepareTradeParams();
            assert(result.isOk());

            // Exchange data should be encoded with single route leg
            expect(result.value.exchangeData).toBe("0xexchangeData");
            expect(encodeAbiParameters).toHaveBeenCalledWith(
                ABI.Orderbook.V6.Primary.RouteLeg,
                expect.any(Array),
            );
        });

        it("should create takeOrders with correct min/max float values", async () => {
            const result = await simulator.prepareTradeParams();
            assert(result.isOk());

            const takeOrders = result.value.takeOrders;
            expect(takeOrders).toHaveLength(2);

            // First order (main order)
            expect(takeOrders[0].IOIsInput).toBe(false);
            expect(takeOrders[0].data).toBe("0x");

            // Second order (counterparty)
            expect(takeOrders[1].IOIsInput).toBe(false);
            expect(takeOrders[1].data).toBe("0x");
        });
    });

    describe("Test setTransactionData method", () => {
        it("should return error if getEnsureBountyTaskBytecode fails with parse error", async () => {
            const error = new EnsureBountyTaskError(
                "parse error",
                EnsureBountyTaskErrorType.ParseError,
            );
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.err(error));
            const getCalldataSpy = vi.spyOn(simulator, "getCalldata");

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Raindex);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(result.error.spanAttributes["error"]).toContain("parse error");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["isNodeError"]).toBe(true);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.External,
                    inputToEthPrice: tradeArgs.counterpartyInputToEthPrice,
                    outputToEthPrice: tradeArgs.counterpartyOutputToEthPrice,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: tradeArgs.signer.account.address,
                },
                tradeArgs.solver.state.client,
                dispair,
            );
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.Raindex,
            );
            expect(getCalldataSpy).not.toHaveBeenCalled();

            getCalldataSpy.mockRestore();
        });

        it("should return error if getEnsureBountyTaskBytecode fails with compose error", async () => {
            const error = new EnsureBountyTaskError(
                "compose error",
                EnsureBountyTaskErrorType.ComposeError,
            );
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.err(error));

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.Raindex);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(result.error.spanAttributes["isNodeError"]).toBe(false);
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
        });

        it("should return success with bytecode when gasCoveragePercentage is not zero", async () => {
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.ok("0xtaskdata"));
            const getCalldataSpy = vi.spyOn(simulator, "getCalldata");
            getCalldataSpy.mockReturnValue("0xencodedCalldata");

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isOk());
            expect(preparedParams.rawtx.data).toBe("0xencodedCalldata");
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.External,
                    inputToEthPrice: tradeArgs.counterpartyInputToEthPrice,
                    outputToEthPrice: tradeArgs.counterpartyOutputToEthPrice,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: tradeArgs.signer.account.address,
                },
                tradeArgs.solver.state.client,
                dispair,
            );
            expect(getCalldataSpy).toHaveBeenCalledTimes(1);
            expect(getCalldataSpy).toHaveBeenCalledWith(
                preparedParams.takeOrders,
                preparedParams.exchangeData,
                {
                    evaluable: {
                        interpreter: dispair.interpreter as `0x${string}`,
                        store: dispair.store as `0x${string}`,
                        bytecode: "0xtaskdata",
                    },
                    signedContext: [],
                },
            );

            getCalldataSpy.mockRestore();
        });

        it("should use empty bytecode when gasCoveragePercentage is zero", async () => {
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.ok("0xtaskdata"));
            tradeArgs.solver.appOptions.gasCoveragePercentage = "0";
            const getCalldataSpy = vi.spyOn(simulator, "getCalldata");
            getCalldataSpy.mockReturnValue("0xencodedCalldata");

            const result = await simulator.setTransactionData(preparedParams);
            assert(result.isOk());
            expect(getCalldataSpy).toHaveBeenCalledWith(
                preparedParams.takeOrders,
                preparedParams.exchangeData,
                {
                    evaluable: {
                        interpreter: dispair.interpreter as `0x${string}`,
                        store: dispair.store as `0x${string}`,
                        bytecode: "0x",
                    },
                    signedContext: [],
                },
            );

            getCalldataSpy.mockRestore();
        });
    });

    describe("Test estimateProfit method", () => {
        it("should return the profit from tradeArgs", () => {
            const result = simulator.estimateProfit();
            expect(result).toBe(tradeArgs.profit);
        });
    });

    describe("Test getCalldata method", () => {
        it("should encode arb4 function call with correct parameters", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            const takeOrders = [{ key: "order1" }, { key: "order2" }] as any;
            const exchangeData = "0xexchangedata" as `0x${string}`;
            const task = { task: "task-value" } as any;

            const result = simulator.getCalldata(takeOrders, exchangeData, task);

            expect(result).toBe("0xcalldata");
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V6.Primary.Arb,
                functionName: "arb4",
                args: [tradeArgs.orderDetails.orderbook, takeOrders, exchangeData, task],
            });
        });

        it("should use correct orderbook address", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            tradeArgs.orderDetails.orderbook = "0xcustomorderbook";
            simulator.tradeArgs = tradeArgs;
            const takeOrders = [] as any;
            const exchangeData = "0x" as `0x${string}`;
            const task = {} as any;

            simulator.getCalldata(takeOrders, exchangeData, task);

            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V6.Primary.Arb,
                functionName: "arb4",
                args: ["0xcustomorderbook", takeOrders, exchangeData, task],
            });
        });

        it("should handle empty takeOrders array", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            const takeOrders = [] as any;
            const exchangeData = "0xexchangedata" as `0x${string}`;
            const task = { task: "task-value" } as any;

            const result = simulator.getCalldata(takeOrders, exchangeData, task);

            expect(result).toBe("0xcalldata");
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V6.Primary.Arb,
                functionName: "arb4",
                args: [tradeArgs.orderDetails.orderbook, takeOrders, exchangeData, task],
            });
        });

        it("should handle complex task structure", () => {
            (encodeFunctionData as Mock).mockReturnValueOnce("0xcalldata");
            const takeOrders = [{ key: "order" }] as any;
            const exchangeData = "0xdata" as `0x${string}`;
            const task = {
                evaluable: {
                    interpreter: "0xinterpreter",
                    store: "0xstore",
                    bytecode: "0xbytecode",
                },
                signedContext: [{ signer: "0xsigner", context: [] }],
            } as any;

            const result = simulator.getCalldata(takeOrders, exchangeData, task);

            expect(result).toBe("0xcalldata");
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V6.Primary.Arb,
                functionName: "arb4",
                args: [tradeArgs.orderDetails.orderbook, takeOrders, exchangeData, task],
            });
        });
    });
});
