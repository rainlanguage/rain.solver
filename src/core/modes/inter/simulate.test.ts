import { RainSolver } from "../..";
import { TradeType } from "../../types";
import * as common from "../../../common";
import { Order, Pair } from "../../../order";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { ABI, Dispair, Result } from "../../../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import {
    InterOrderbookTradeSimulator,
    SimulateInterOrderbookTradeArgs,
    InterOrderbookTradePreparedParams,
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
    encodeAbiParameters: vi.fn(),
    encodeFunctionData: vi.fn(),
}));

function makeOrderDetails(ratio: bigint = ONE18): Pair {
    return {
        orderbook: "0xorderbook",
        buyToken: "0xbuyToken" as `0x${string}`,
        sellToken: "0xsellToken" as `0x${string}`,
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        takeOrder: {
            id: "0xid",
            struct: { order: { type: Order.Type.V3 }, inputIOIndex: 1, outputIOIndex: 0 },
            quote: { ratio, maxOutput: 100n * ONE18 },
        },
    } as Pair;
}

describe("Test InterOrderbookTradeSimulator", () => {
    let mockSolver: RainSolver;
    let mockSigner: RainSolverSigner;
    let tradeArgs: SimulateInterOrderbookTradeArgs;
    let simulator: InterOrderbookTradeSimulator;
    let preparedParams: InterOrderbookTradePreparedParams;
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
            type: TradeType.InterOrderbook,
            solver: mockSolver,
            orderDetails: makeOrderDetails(),
            signer: mockSigner,
            inputToEthPrice: "1.2",
            outputToEthPrice: "1.3",
            blockNumber: 123n,
            counterpartyOrderDetails: makeOrderDetails(2n * ONE18),
            maximumInputFixed: 10n * ONE18,
        };
        preparedParams = {
            type: TradeType.InterOrderbook,
            rawtx: {
                from: "0xfrom",
                to: "0xto",
                data: "0xdata",
            },
            price: 3n,
            minimumExpected: 12n,
            takeOrdersConfigStruct: {} as any,
        };
        simulator = new InterOrderbookTradeSimulator(tradeArgs);
    });

    describe("Test prepareTradeParams method", async () => {
        it("should return success", async () => {
            (encodeFunctionData as Mock).mockReturnValue("0xencodedData");
            (encodeAbiParameters as Mock).mockReturnValue("0xencodedAbi");

            const result = await simulator.prepareTradeParams();
            assert(result.isOk());
            expect(result.value.type).toBe(TradeType.InterOrderbook);
            expect(result.value.rawtx).toEqual({
                to: "0xdestination",
                gasPrice: mockSolver.state.gasPrice,
            });
            expect(result.value.minimumExpected).toBe(0n);
            expect(simulator.spanAttributes["against"]).toBe(
                tradeArgs.counterpartyOrderDetails.takeOrder.id,
            );
            expect(simulator.spanAttributes["inputToEthPrice"]).toBe(tradeArgs.inputToEthPrice);
            expect(simulator.spanAttributes["outputToEthPrice"]).toBe(tradeArgs.outputToEthPrice);
            expect(simulator.spanAttributes["oppBlockNumber"]).toBe(Number(tradeArgs.blockNumber));
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
            expect(simulator.spanAttributes["maxInput"]).toBe(
                scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ).toString(),
            );
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V4.Primary.Orderbook,
                functionName: "takeOrders2",
                args: [
                    {
                        minimumInput: 1n,
                        maximumInput: expect.any(BigInt),
                        maximumIORatio: expect.any(BigInt),
                        orders: [tradeArgs.counterpartyOrderDetails.takeOrder.struct], // opposing orders
                        data: "0x",
                    },
                ],
            });
            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }, { type: "address" }, { type: "bytes" }],
                [
                    tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    expect.any(String),
                ],
            );
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.InterOrderbook,
            );
        });

        it("should return error for missing trade addresses", async () => {
            (encodeFunctionData as Mock).mockReturnValue("0xencodedData");
            (encodeAbiParameters as Mock).mockReturnValue("0xencodedAbi");
            (mockSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValueOnce(
                undefined,
            );

            const result = await simulator.prepareTradeParams();
            assert(result.isErr());
            expect(result.error.type).toBe(TradeType.InterOrderbook);
            expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["error"]).toContain(
                "Cannot trade as generic arb address is not configured for order",
            );
            expect(result.error.spanAttributes["against"]).toBe(
                tradeArgs.counterpartyOrderDetails.takeOrder.id,
            );
            expect(result.error.spanAttributes["inputToEthPrice"]).toBe(tradeArgs.inputToEthPrice);
            expect(result.error.spanAttributes["outputToEthPrice"]).toBe(
                tradeArgs.outputToEthPrice,
            );
            expect(result.error.spanAttributes["oppBlockNumber"]).toBe(
                Number(tradeArgs.blockNumber),
            );
            expect(result.error.spanAttributes["counterpartyOrderQuote"]).toBe(
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
            expect(result.error.spanAttributes["maxInput"]).toBe(
                scaleFrom18(
                    tradeArgs.maximumInputFixed,
                    tradeArgs.orderDetails.sellTokenDecimals,
                ).toString(),
            );
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.InterOrderbook,
            );
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V4.Primary.Orderbook,
                functionName: "takeOrders2",
                args: [
                    {
                        minimumInput: 1n,
                        maximumInput: expect.any(BigInt),
                        maximumIORatio: expect.any(BigInt),
                        orders: [tradeArgs.counterpartyOrderDetails.takeOrder.struct], // opposing orders
                        data: "0x",
                    },
                ],
            });
            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }, { type: "address" }, { type: "bytes" }],
                [
                    tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    expect.any(String),
                ],
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
            expect(result.error.type).toBe(TradeType.InterOrderbook);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(result.error.spanAttributes["error"]).toContain("some error");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["isNodeError"]).toBe(false);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.External,
                    inputToEthPrice: parseUnits(simulator.tradeArgs.inputToEthPrice, 18),
                    outputToEthPrice: parseUnits(simulator.tradeArgs.outputToEthPrice, 18),
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                },
                simulator.tradeArgs.solver.state.client,
                dispair,
            );
            expect(getCalldataSpy).not.toHaveBeenCalled();
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.InterOrderbook,
            );

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
                    inputToEthPrice: parseUnits(simulator.tradeArgs.inputToEthPrice, 18),
                    outputToEthPrice: parseUnits(simulator.tradeArgs.outputToEthPrice, 18),
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                },
                simulator.tradeArgs.solver.state.client,
                dispair,
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
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledTimes(1);
            expect(mockSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
                tradeArgs.orderDetails,
                TradeType.InterOrderbook,
            );

            getCalldataSpy.mockRestore();
        });
    });

    describe("Test estimateProfit method", () => {
        const ONE17 = 10n ** 17n;
        function makeOrderDetails(ratio: bigint) {
            return {
                takeOrder: {
                    quote: { ratio },
                },
            } as Pair;
        }
        function makeCounterpartyOrder(ratio: bigint, maxOutput: bigint): Pair {
            return {
                takeOrder: {
                    quote: {
                        ratio,
                        maxOutput,
                    },
                },
            } as Pair;
        }

        it("should calculate profit correctly for typical values", () => {
            const orderDetails = makeOrderDetails(2n * ONE18); // ratio = 2.0
            const inputToEthPrice = 1n * ONE18; // 1 ETH per input token
            const outputToEthPrice = 3n * ONE18; // 3 ETH per output token
            const counterpartyOrder = makeCounterpartyOrder(15n * ONE17, 5n * ONE18); // ratio = 1.5, maxOutput = 5
            const maxInput = 10n * ONE18; // 10 units
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 10
            // orderInput = (10 * 2) / 1 = 20
            // opposingMaxInput = (10 * 2) / 1 = 20
            // opposingMaxIORatio = 1^2 / 2 = 0.5
            // Since opposingMaxIORatio (0.5) < counterpartyOrder.ratio (1.5), counterparty conditions not met
            // counterpartyInput = 0, counterpartyOutput = 0
            // outputProfit = ((10 - 0) * 3) / 1 = 30
            // inputProfit = ((0 - 20) * 1) / 1 = -20
            // total = 30 + (-20) = 10
            const result = simulator.estimateProfit();
            expect(result).toBe(10n * ONE18);
        });

        it("should handle zero ratio in order (maxUint256 case)", () => {
            const orderDetails = makeOrderDetails(0n); // ratio = 0
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 2n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 5n * ONE18); // ratio = 1.0, maxOutput = 5
            const maxInput = 10n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 10
            // orderInput = (10 * 0) / 1 = 0
            // opposingMaxInput = maxUint256 (since ratio is 0)
            // opposingMaxIORatio = maxUint256 (since ratio is 0)
            // Since opposingMaxIORatio (maxUint256) >= counterpartyOrder.ratio (1.0), counterparty conditions met
            // maxOut = min(maxUint256, 5) = 5
            // counterpartyOutput = 5
            // counterpartyInput = (5 * 1) / 1 = 5
            // outputProfit = ((10 - 5) * 2) / 1 = 10
            // inputProfit = ((5 - 0) * 1) / 1 = 5
            // total = 10 + 5 = 5
            const result = simulator.estimateProfit();
            expect(result).toBe(15n * ONE18);
        });

        it("should handle counterparty trade when opposing max input is limiting factor", () => {
            const orderDetails = makeOrderDetails(1n * ONE18); // ratio = 1.0
            const inputToEthPrice = 2n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20
            const maxInput = 10n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 10
            // orderInput = (10 * 1) / 1 = 10
            // opposingMaxInput = (10 * 1) / 1 = 10
            // opposingMaxIORatio = 1^2 / 1 = 1
            // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (0.5), counterparty conditions met
            // maxOut = min(10, 20) = 10 (opposingMaxInput is limiting)
            // counterpartyOutput = 10
            // counterpartyInput = (10 * 0.5) / 1 = 5
            // outputProfit = ((10 - 5) * 1) / 1 = 5
            // inputProfit = ((10 - 10) * 2) / 1 = 0
            // total = 5 + 0 = 5
            const result = simulator.estimateProfit();
            expect(result).toBe(5n * ONE18);
        });

        it("should handle counterparty trade when counterparty max output is limiting factor", () => {
            const orderDetails = makeOrderDetails(1n * ONE18); // ratio = 1.0
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 3n * ONE18); // ratio = 0.5, maxOutput = 3
            const maxInput = 10n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 10
            // orderInput = (10 * 1) / 1 = 10
            // opposingMaxInput = (10 * 1) / 1 = 10
            // opposingMaxIORatio = 1^2 / 1 = 1
            // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (0.5), counterparty conditions met
            // maxOut = min(10, 3) = 3 (counterparty maxOutput is limiting)
            // counterpartyOutput = 3
            // counterpartyInput = (3 * 0.5) / 1 = 1.5
            // outputProfit = 10 - (1.5 * 1) / 1 = 8.5
            // inputProfit = 3 - (10 * 1) / 1 = -7
            // total = 8.5 + (-7) = 1.5
            const result = simulator.estimateProfit();
            expect(result).toBe(15n * ONE17); // 1.5 * ONE18
        });

        it("should handle case when opposing max IO ratio is less than counterparty ratio", () => {
            const orderDetails = makeOrderDetails(4n * ONE18); // ratio = 4.0
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
            const maxInput = 5n * ONE18;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 5
            // orderInput = (5 * 4) / 1 = 20
            // opposingMaxInput = (5 * 4) / 1 = 20
            // opposingMaxIORatio = 1^2 / 4 = 0.25
            // Since opposingMaxIORatio (0.25) < counterpartyOrder.ratio (1.0), counterparty conditions NOT met
            // counterpartyInput = 0, counterpartyOutput = 0
            // outputProfit = 5 - (0 * 1) / 1 = 5
            // inputProfit = 0 - (20 * 1) / 1 = -20
            // total = 5 + (-20) = -15
            const result = simulator.estimateProfit();
            expect(result).toBe(-15n * ONE18);
        });

        it("should handle edge case with zero max input", () => {
            const orderDetails = makeOrderDetails(1n * ONE18);
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 10n * ONE18);
            const maxInput = 0n;
            simulator.tradeArgs.orderDetails = orderDetails;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;
            simulator.tradeArgs.maximumInputFixed = maxInput;

            // orderOutput = 0
            // orderInput = (0 * 1) / 1 = 0
            // opposingMaxInput = (0 * 1) / 1 = 0
            // opposingMaxIORatio = 1^2 / 1 = 1
            // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (1.0), counterparty conditions met
            // maxOut = min(0, 10) = 0
            // counterpartyOutput = 0, counterpartyInput = 0
            // outputProfit = 0 - (0 * 1) / 1 = 0
            // inputProfit = 0 - (0 * 1) / 1 = 0
            // total = 0
            const result = simulator.estimateProfit();
            expect(result).toBe(0n);
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

    describe("Test getTakeOrdersConfigV3 method", () => {
        it("should return v3 config", () => {
            (encodeAbiParameters as Mock).mockReturnValue("0xdata");
            const result = simulator.getTakeOrdersConfigV3(
                simulator.tradeArgs.orderDetails as any,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            expect(result).toEqual({
                minimumInput: 1n,
                maximumInput: maxUint256,
                maximumIORatio: maxUint256,
                orders: [simulator.tradeArgs.orderDetails.takeOrder.struct],
                data: "0xdata",
            });
            expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }, { type: "address" }, { type: "bytes" }],
                [
                    simulator.tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    simulator.tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    "0x1234",
                ],
            );
        });
    });

    describe("Test getTakeOrdersConfigV4 method", () => {
        let minFloatSpy: any;
        let maxFloatSpy: any;
        let toFloatSpy: any;

        beforeEach(() => {
            if (minFloatSpy) {
                minFloatSpy.mockRestore();
                maxFloatSpy.mockRestore();
                toFloatSpy.mockRestore();
            }
            minFloatSpy = vi.spyOn(common, "minFloat");
            maxFloatSpy = vi.spyOn(common, "maxFloat");
            toFloatSpy = vi.spyOn(common, "toFloat");
        });

        it("should return v4 config", () => {
            (encodeAbiParameters as Mock).mockReturnValue("0xdata");
            (minFloatSpy as Mock).mockReturnValueOnce("0xmin");
            (maxFloatSpy as Mock).mockReturnValueOnce("0xmax1").mockReturnValueOnce("0xmax2");
            const result = simulator.getTakeOrdersConfigV4(
                simulator.tradeArgs.orderDetails as any,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            expect(result).toEqual({
                minimumInput: "0xmin",
                maximumInput: "0xmax1",
                maximumIORatio: "0xmax2",
                orders: [simulator.tradeArgs.orderDetails.takeOrder.struct],
                data: "0xdata",
            });
            expect(minFloatSpy).toHaveBeenCalledTimes(1);
            expect(minFloatSpy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails.sellTokenDecimals,
            );
            expect(maxFloatSpy).toHaveBeenCalledTimes(2);
            expect(maxFloatSpy).toHaveBeenNthCalledWith(
                1,
                simulator.tradeArgs.orderDetails.sellTokenDecimals,
            );
            expect(maxFloatSpy).toHaveBeenNthCalledWith(2, 18);
            expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }, { type: "address" }, { type: "bytes" }],
                [
                    simulator.tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    simulator.tradeArgs.counterpartyOrderDetails.orderbook as `0x${string}`,
                    "0x1234",
                ],
            );
        });
    });

    describe("Test getTakeOrdersConfig method", () => {
        it("should return v3 config", () => {
            const spy = vi.spyOn(simulator, "getTakeOrdersConfigV3");
            simulator.tradeArgs.orderDetails.takeOrder.struct.order.type = Order.Type.V3;
            simulator.getTakeOrdersConfig(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            spy.mockRestore();
        });

        it("should return v4 config", () => {
            const spy = vi.spyOn(simulator, "getTakeOrdersConfigV4");
            simulator.tradeArgs.orderDetails.takeOrder.struct.order.type = Order.Type.V4;
            simulator.getTakeOrdersConfig(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                "0x1234",
            );
            spy.mockRestore();
        });
    });

    describe("Test getEncodedCounterpartyTakeOrdersConfigV3 method", () => {
        it("should return v3 config", () => {
            (encodeFunctionData as Mock).mockReturnValue("0xdata");
            const result = simulator.getEncodedCounterpartyTakeOrdersConfigV3(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails as any,
                1234n,
            );
            expect(result).toEqual("0xdata");
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V4.Primary.Orderbook,
                functionName: "takeOrders2",
                args: [
                    {
                        minimumInput: 1n,
                        maximumInput: expect.any(BigInt),
                        maximumIORatio: expect.any(BigInt),
                        orders: [simulator.tradeArgs.counterpartyOrderDetails.takeOrder.struct],
                        data: "0x",
                    },
                ],
            });
        });
    });

    describe("Test getEncodedCounterpartyTakeOrdersConfigV4 method", () => {
        let minFloatSpy: any;
        let maxFloatSpy: any;
        let toFloatSpy: any;

        beforeEach(() => {
            if (minFloatSpy) {
                minFloatSpy.mockRestore();
                maxFloatSpy.mockRestore();
                toFloatSpy.mockRestore();
            }
            minFloatSpy = vi.spyOn(common, "minFloat");
            maxFloatSpy = vi.spyOn(common, "maxFloat");
            toFloatSpy = vi.spyOn(common, "toFloat");
        });

        it("should return v4 config", () => {
            (encodeFunctionData as Mock).mockReturnValue("0xdata");
            (toFloatSpy as Mock)
                .mockReturnValueOnce(Result.ok("0xfloat1"))
                .mockReturnValueOnce(Result.ok("0xfloat2"));
            (minFloatSpy as Mock).mockReturnValueOnce("0xmin");
            (maxFloatSpy as Mock).mockReturnValueOnce("0xmax1").mockReturnValueOnce("0xmax2");
            const result = simulator.getEncodedCounterpartyTakeOrdersConfigV4(
                simulator.tradeArgs.orderDetails as any,
                simulator.tradeArgs.counterpartyOrderDetails as any,
                1234n,
            );
            assert(result.isOk());
            expect(result.value).toEqual("0xdata");
            expect(maxFloatSpy).toHaveBeenCalledTimes(2);
            expect(maxFloatSpy).toHaveBeenNthCalledWith(
                1,
                simulator.tradeArgs.orderDetails.buyTokenDecimals,
            );
            expect(maxFloatSpy).toHaveBeenNthCalledWith(2, 18);
            expect(toFloatSpy).toHaveBeenCalledTimes(2);
            expect(minFloatSpy).toHaveBeenCalledTimes(1);
            expect(minFloatSpy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails.sellTokenDecimals,
            );
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V5.Primary.Orderbook,
                functionName: "takeOrders3",
                args: [
                    {
                        minimumInput: "0xmin",
                        maximumInput: "0xfloat1",
                        maximumIORatio: "0xfloat2",
                        orders: [simulator.tradeArgs.counterpartyOrderDetails.takeOrder.struct], // opposing orders
                        data: "0x",
                    },
                ],
            });
        });

        it("should return v4 config with ratio 0", () => {
            (encodeFunctionData as Mock).mockReturnValue("0xdata");
            (minFloatSpy as Mock).mockReturnValueOnce("0xmin");
            (maxFloatSpy as Mock).mockReturnValueOnce("0xmax1").mockReturnValueOnce("0xmax2");
            simulator.tradeArgs.orderDetails.takeOrder.quote!.ratio = 0n;
            const result = simulator.getEncodedCounterpartyTakeOrdersConfigV4(
                simulator.tradeArgs.orderDetails as any,
                simulator.tradeArgs.counterpartyOrderDetails as any,
                1234n,
            );
            assert(result.isOk());
            expect(result.value).toEqual("0xdata");
            expect(maxFloatSpy).toHaveBeenCalledTimes(2);
            expect(maxFloatSpy).toHaveBeenNthCalledWith(
                1,
                simulator.tradeArgs.orderDetails.buyTokenDecimals,
            );
            expect(maxFloatSpy).toHaveBeenNthCalledWith(2, 18);
            expect(toFloatSpy).not.toHaveBeenCalled();
            expect(minFloatSpy).toHaveBeenCalledTimes(1);
            expect(minFloatSpy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails.sellTokenDecimals,
            );
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.V5.Primary.Orderbook,
                functionName: "takeOrders3",
                args: [
                    {
                        minimumInput: "0xmin",
                        maximumInput: "0xmax1",
                        maximumIORatio: "0xmax2",
                        orders: [simulator.tradeArgs.counterpartyOrderDetails.takeOrder.struct], // opposing orders
                        data: "0x",
                    },
                ],
            });
        });

        it("should return error when toFloat fails", () => {
            (encodeFunctionData as Mock).mockReturnValue("0xdata");
            (toFloatSpy as Mock).mockReturnValueOnce(
                Result.err({ msg: "err", readableMsg: "some msg" }),
            );
            (maxFloatSpy as Mock).mockReturnValueOnce("0xmax1").mockReturnValueOnce("0xmax2");
            const result = simulator.getEncodedCounterpartyTakeOrdersConfigV4(
                simulator.tradeArgs.orderDetails as any,
                simulator.tradeArgs.counterpartyOrderDetails as any,
                1234n,
            );
            assert(result.isErr());
            expect(result.error).toEqual({ msg: "err", readableMsg: "some msg" });
            expect(maxFloatSpy).toHaveBeenCalledTimes(2);
            expect(maxFloatSpy).toHaveBeenNthCalledWith(
                1,
                simulator.tradeArgs.orderDetails.buyTokenDecimals,
            );
            expect(maxFloatSpy).toHaveBeenNthCalledWith(2, 18);
            expect(toFloatSpy).toHaveBeenCalledTimes(1);
            expect(minFloatSpy).not.toHaveBeenCalled();
            expect(encodeFunctionData).not.toHaveBeenCalled();
        });
    });

    describe("Test getCounterpartyTakeOrdersConfig method", () => {
        it("should return v3 config", () => {
            const spy = vi.spyOn(simulator, "getEncodedCounterpartyTakeOrdersConfigV3");
            simulator.tradeArgs.counterpartyOrderDetails.takeOrder.struct.order.type =
                Order.Type.V3;
            const result = simulator.getCounterpartyTakeOrdersConfig(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                123n,
            );
            assert(result.isOk());
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                123n,
            );
            spy.mockRestore();
        });

        it("should return v4 config", () => {
            const spy = vi.spyOn(simulator, "getEncodedCounterpartyTakeOrdersConfigV4");
            simulator.tradeArgs.counterpartyOrderDetails.takeOrder.struct.order.type =
                Order.Type.V4;
            const result = simulator.getCounterpartyTakeOrdersConfig(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                123n,
            );
            assert(result.isOk());
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(
                simulator.tradeArgs.orderDetails,
                simulator.tradeArgs.counterpartyOrderDetails,
                123n,
            );
            spy.mockRestore();
        });
    });
});
