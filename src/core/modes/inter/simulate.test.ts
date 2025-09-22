import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { TradeType } from "../../types";
import { ABI, Result } from "../../../common";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { encodeAbiParameters, encodeFunctionData, formatUnits, parseUnits } from "viem";
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
            struct: { inputIOIndex: 1, outputIOIndex: 0 },
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

    beforeEach(() => {
        vi.clearAllMocks();
        mockSolver = {
            state: {
                gasPrice: 1000000000000000000n,
                gasLimitMultiplier: 1.5,
                chainConfig: {
                    isSpecialL2: true,
                },
                dispair: {
                    deployer: "0xdeployer",
                    interpreter: "0xinterpreter",
                    store: "0xstore",
                },
                router: {
                    getTradeParams: vi.fn(),
                },
            },
            appOptions: {
                arbAddress: "0xarbAddress",
                genericArbAddress: "0xgenericArbAddress",
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
                to: "0xgenericArbAddress",
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
                abi: ABI.Orderbook.Primary.Orderbook,
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
                simulator.tradeArgs.solver.state.dispair,
            );
            expect(encodeFunctionData).not.toHaveBeenCalled();
        });

        it("should return success", async () => {
            (getEnsureBountyTaskBytecode as Mock).mockResolvedValueOnce(Result.ok("0xdata"));
            (encodeFunctionData as Mock).mockReturnValue("0xencodedData");

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
                simulator.tradeArgs.solver.state.dispair,
            );
            expect(encodeFunctionData).toHaveBeenCalledTimes(1);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.Primary.Arb,
                functionName: "arb3",
                args: [
                    tradeArgs.orderDetails.orderbook as `0x${string}`,
                    preparedParams.takeOrdersConfigStruct,
                    {
                        evaluable: {
                            interpreter: simulator.tradeArgs.solver.state.dispair
                                .interpreter as `0x${string}`,
                            store: simulator.tradeArgs.solver.state.dispair.store as `0x${string}`,
                            bytecode: "0xdata",
                        },
                        signedContext: [],
                    },
                ],
            });
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
});
