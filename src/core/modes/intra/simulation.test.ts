import { RainSolver } from "../..";
import { ONE18 } from "../../../math";
import { TradeType } from "../../types";
import { ABI, Result } from "../../../common";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { Pair, TakeOrderDetails } from "../../../order";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    IntraOrderbookTradeSimulator,
    IntraOrderbookTradePrepareedParams,
    SimulateIntraOrderbookTradeArgs,
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
}));

function makeOrderDetails(ratio = ONE18): Pair {
    return {
        orderbook: "0xorderbook",
        buyToken: "0xbuyToken" as `0x${string}`,
        sellToken: "0xsellToken" as `0x${string}`,
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        takeOrder: { struct: { inputIOIndex: 1, outputIOIndex: 0 }, quote: { ratio } },
    } as Pair;
}

describe("Test IntraOrderbookTradeSimulator", () => {
    let mockSolver: RainSolver;
    let mockSigner: RainSolverSigner;
    let tradeArgs: SimulateIntraOrderbookTradeArgs;
    let simulator: IntraOrderbookTradeSimulator;
    let preparedParams: IntraOrderbookTradePrepareedParams;

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
            },
            appOptions: {
                arbAddress: "0xarbAddress",
                balancerArbAddress: "0xbalancerArbAddress",
                gasLimitMultiplier: 1.5,
                gasCoveragePercentage: "100",
            },
            client: {},
        } as any as RainSolver;
        mockSigner = { account: { address: "0xsigner" } } as any as RainSolverSigner;
        tradeArgs = {
            type: TradeType.IntraOrderbook,
            solver: mockSolver,
            orderDetails: makeOrderDetails(),
            signer: mockSigner,
            inputToEthPrice: "1.2",
            outputToEthPrice: "1.3",
            blockNumber: 123n,
            counterpartyOrderDetails: {
                id: "0xid",
                quote: { maxOutput: 10n * ONE18, ratio: 2n * ONE18 },
                struct: {
                    inputIOIndex: 0,
                    outputIOIndex: 1,
                } as any,
            },
            inputBalance: 2n,
            outputBalance: 1n,
        };
        preparedParams = {
            type: TradeType.IntraOrderbook,
            rawtx: {
                from: "0xfrom",
                to: "0xto",
                data: "0xdata",
            },
            minimumExpected: 12n,
        };
        simulator = new IntraOrderbookTradeSimulator(tradeArgs);
    });

    describe("Test prepareTradeParams method", async () => {
        it("should return success", async () => {
            const result = await simulator.prepareTradeParams();
            assert(result.isOk());
            expect(result.value.type).toBe(TradeType.IntraOrderbook);
            expect(result.value.rawtx).toEqual({
                to: "0xorderbook",
                gasPrice: mockSolver.state.gasPrice,
            });
            expect(result.value.minimumExpected).toBe(0n);
            expect(simulator.spanAttributes["against"]).toBe(tradeArgs.counterpartyOrderDetails.id);
            expect(simulator.spanAttributes["inputToEthPrice"]).toBe(tradeArgs.inputToEthPrice);
            expect(simulator.spanAttributes["outputToEthPrice"]).toBe(tradeArgs.outputToEthPrice);
            expect(simulator.spanAttributes["oppBlockNumber"]).toBe(Number(tradeArgs.blockNumber));
            expect(simulator.spanAttributes["counterpartyOrderQuote"]).toBe(
                JSON.stringify({
                    maxOutput: formatUnits(tradeArgs.counterpartyOrderDetails.quote!.maxOutput, 18),
                    ratio: formatUnits(tradeArgs.counterpartyOrderDetails.quote!.ratio, 18),
                }),
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
            expect(result.error.type).toBe(TradeType.IntraOrderbook);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(result.error.spanAttributes["error"]).toContain("some error");
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.error.spanAttributes["isNodeError"]).toBe(false);
            expect(result.error.reason).toBe(SimulationHaltReason.FailedToGetTaskBytecode);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledTimes(1);
            expect(getEnsureBountyTaskBytecode).toHaveBeenCalledWith(
                {
                    type: EnsureBountyTaskType.Internal,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                    botAddress: tradeArgs.signer.account.address,
                    inputToken: tradeArgs.orderDetails.buyToken,
                    outputToken: tradeArgs.orderDetails.sellToken,
                    orgInputBalance: tradeArgs.inputBalance,
                    orgOutputBalance: tradeArgs.outputBalance,
                    inputToEthPrice: parseUnits(tradeArgs.inputToEthPrice, 18),
                    outputToEthPrice: parseUnits(tradeArgs.outputToEthPrice, 18),
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
                    type: EnsureBountyTaskType.Internal,
                    minimumExpected: preparedParams.minimumExpected,
                    sender: simulator.tradeArgs.signer.account.address,
                    botAddress: tradeArgs.signer.account.address,
                    inputToken: tradeArgs.orderDetails.buyToken,
                    outputToken: tradeArgs.orderDetails.sellToken,
                    orgInputBalance: tradeArgs.inputBalance,
                    orgOutputBalance: tradeArgs.outputBalance,
                    inputToEthPrice: parseUnits(tradeArgs.inputToEthPrice, 18),
                    outputToEthPrice: parseUnits(tradeArgs.outputToEthPrice, 18),
                },
                simulator.tradeArgs.solver.state.client,
                simulator.tradeArgs.solver.state.dispair,
            );
            expect(encodeFunctionData).toHaveBeenCalledTimes(4);
            expect(encodeFunctionData).toHaveBeenCalledWith({
                abi: ABI.Orderbook.Primary.Orderbook,
                functionName: "multicall",
                args: [["0xencodedData", "0xencodedData", "0xencodedData"]],
            });
        });
    });

    describe("Test estimateProfit method", () => {
        const ONE17 = 10n ** 17n;
        function makeOrderPairObject(ratio: bigint, maxOutput: bigint): Pair {
            return {
                takeOrder: {
                    quote: {
                        ratio,
                        maxOutput,
                    },
                },
            } as Pair;
        }
        function makeCounterpartyOrder(ratio: bigint, maxOutput: bigint): TakeOrderDetails {
            return {
                quote: {
                    ratio,
                    maxOutput,
                },
            } as TakeOrderDetails;
        }
        it("should calculate profit correctly when both orders can be filled completely", () => {
            const orderPairObject = makeOrderPairObject(2n * ONE18, 10n * ONE18); // ratio = 2.0, maxOutput = 10
            const inputToEthPrice = 1n * ONE18; // 1 ETH per input token
            const outputToEthPrice = 3n * ONE18; // 3 ETH per output token
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (10 * 2) / 1 = 20
            // opposingMaxInput = (20 * 0.5) / 1 = 10
            // orderOutput = min(10, 10) = 10
            // orderInput = (10 * 2) / 1 = 20
            // opposingOutput = min(20, 20) = 20
            // opposingInput = (20 * 0.5) / 1 = 10
            // outputProfit = max(0, 10 - 10) = 0, in ETH = 0
            // inputProfit = max(0, 20 - 20) = 0, in ETH = 0
            // total = 0 + 0 = 0
            const result = simulator.estimateProfit();
            expect(result).toBe(0n);
        });

        it("should calculate profit when order output is limited by opposing max input", () => {
            const orderPairObject = makeOrderPairObject(1n * ONE18, 15n * ONE18); // ratio = 1.0, maxOutput = 15
            const inputToEthPrice = 2n * ONE18;
            const outputToEthPrice = 3n * ONE18; // Changed from 1n to 3n
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio 0.5
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (15 * 1) / 1 = 15
            // opposingMaxInput = (20 * 0.5) / 1 = 10
            // orderOutput = min(15, 10) = 10
            // orderInput = (10 * 1) / 1 = 10
            // opposingOutput = min(15, 20) = 15
            // opposingInput = (15 * 0.5) / 1 = 7.5
            // outputProfit = max(0, 10 - 7.5) = 2.5, in ETH = 2.5 * 3 = 7.5
            // inputProfit = max(0, 15 - 10) = 5, in ETH = 5 * 2 = 10
            // total = 7.5 + 10 = 17.5
            const result = simulator.estimateProfit();
            expect(result).toBe(175n * ONE17); // 17.5 * ONE18
        });

        it("should calculate profit when opposing output is limited by order max input", () => {
            const orderPairObject = makeOrderPairObject(15n * ONE17, 8n * ONE18); // ratio 1.5, maxOutput = 8
            const inputToEthPrice = 2n * ONE18; // Changed from 1n to 2n
            const outputToEthPrice = 4n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio 0.5
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (8 * 1.5) / 1 = 12
            // opposingMaxInput = (20 * 0.5) / 1 = 10
            // orderOutput = min(8, 10) = 8
            // orderInput = (8 * 1.5) / 1 = 12
            // opposingOutput = min(12, 20) = 12
            // opposingInput = (12 * 0.5) / 1 = 6
            // outputProfit = max(0, 8 - 6) = 2, in ETH = 2 * 4 = 8
            // inputProfit = max(0, 12 - 12) = 0
            // total = 8 + 0 = 8
            const result = simulator.estimateProfit();
            expect(result).toBe(8n * ONE18);
        });

        it("should calculate profit when opposing output is limited by counterparty max output", () => {
            const orderPairObject = makeOrderPairObject(1n * ONE18, 8n * ONE18); // ratio = 1.0, maxOutput = 8
            const inputToEthPrice = 2n * ONE18;
            const outputToEthPrice = 3n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 5n * ONE18); // ratio = 0.5, maxOutput = 5
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (8 * 1) / 1 = 8
            // opposingMaxInput = (5 * 0.5) / 1 = 2.5
            // orderOutput = min(8, 2.5) = 2.5
            // orderInput = (2.5 * 1) / 1 = 2.5
            // opposingOutput = min(8, 5) = 5
            // opposingInput = (5 * 0.5) / 1 = 2.5
            // outputProfit = max(0, 2.5 - 2.5) = 0
            // inputProfit = max(0, 5 - 2.5) = 2.5, in ETH = 2.5 * 2 = 5
            // total = 0 + 5 = 5
            const result = simulator.estimateProfit();
            expect(result).toBe(5n * ONE18);
        });

        it("should handle counterparty order with zero ratio", () => {
            const orderPairObject = makeOrderPairObject(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 2n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(0n, 15n * ONE18); // ratio = 0, maxOutput = 15
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // When counterparty ratio is 0:
            // orderOutput = 10 (orderPairObject maxOutput)
            // orderInput = (10 * 1) / 1 = 10
            // opposingOutput = 15 (counterparty maxOutput)
            // opposingInput = (15 * 0) / 1 = 0
            // outputProfit = max(0, 10 - 0) = 10, in ETH = 10 * 2 = 20
            // inputProfit = max(0, 15 - 10) = 5, in ETH = 5 * 1 = 5
            // total = 20 + 5 = 25
            const result = simulator.estimateProfit();
            expect(result).toBe(25n * ONE18);
        });

        it("should handle order pair object with zero ratio", () => {
            const orderPairObject = makeOrderPairObject(0n, 12n * ONE18); // ratio = 0, maxOutput = 12
            const inputToEthPrice = 3n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 8n * ONE18); // ratio = 1.0, maxOutput = 8
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (12 * 0) / 1 = 0
            // opposingMaxInput = (8 * 1) / 1 = 8
            // orderOutput = min(12, 8) = 8
            // orderInput = (8 * 0) / 1 = 0
            // opposingOutput = min(0, 8) = 0
            // opposingInput = (0 * 1) / 1 = 0
            // outputProfit = max(0, 8 - 0) = 8, in ETH = 8 * 1 = 8
            // inputProfit = max(0, 0 - 0) = 0
            // total = 8 + 0 = 8
            const result = simulator.estimateProfit();
            expect(result).toBe(8n * ONE18);
        });

        it("should handle both orders with zero ratio", () => {
            const orderPairObject = makeOrderPairObject(0n, 6n * ONE18); // ratio = 0, maxOutput = 6
            const inputToEthPrice = 2n * ONE18;
            const outputToEthPrice = 3n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(0n, 4n * ONE18); // ratio = 0, maxOutput = 4
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // When both ratios are 0:
            // orderOutput = 6 (orderPairObject maxOutput)
            // orderInput = (6 * 0) / 1 = 0
            // opposingOutput = 4 (counterparty maxOutput)
            // opposingInput = (4 * 0) / 1 = 0
            // outputProfit = max(0, 6 - 0) = 6, in ETH = 6 * 3 = 18
            // inputProfit = max(0, 4 - 0) = 4, in ETH = 4 * 2 = 8
            // total = 18 + 8 = 26
            const result = simulator.estimateProfit();
            expect(result).toBe(26n * ONE18);
        });

        it("should handle edge case with zero max outputs", () => {
            const orderPairObject = makeOrderPairObject(1n * ONE18, 0n); // maxOutput = 0
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 1n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 0n); // maxOutput = 0
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (0 * 1) / 1 = 0
            // opposingMaxInput = (0 * 1) / 1 = 0
            // orderOutput = min(0, 0) = 0
            // orderInput = (0 * 1) / 1 = 0
            // opposingOutput = min(0, 0) = 0
            // opposingInput = (0 * 1) / 1 = 0
            // outputProfit = max(0, 0 - 0) = 0
            // inputProfit = max(0, 0 - 0) = 0
            // total = 0
            const result = simulator.estimateProfit();
            expect(result).toBe(0n);
        });

        it("should calculate profit when there is clear arbitrage opportunity", () => {
            const orderPairObject = makeOrderPairObject(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20
            const inputToEthPrice = 2n * ONE18; // Changed from 1n to 2n
            const outputToEthPrice = 3n * ONE18; // Changed from 1n to 3n
            const counterpartyOrder = makeCounterpartyOrder(15n * ONE17, 8n * ONE18); // ratio 1.5, maxOutput 8
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (20 * 0.5) / 1 = 10
            // opposingMaxInput = (8 * 1.5) / 1 = 12
            // orderOutput = min(20, 12) = 12
            // orderInput = (12 * 0.5) / 1 = 6
            // opposingOutput = min(10, 8) = 8
            // opposingInput = (8 * 1.5) / 1 = 12
            // outputProfit = max(0, 12 - 12) = 0
            // inputProfit = max(0, 8 - 6) = 2, in ETH = 2 * 2 = 4
            // total = 0 + 4 = 4
            const result = simulator.estimateProfit();
            expect(result).toBe(4n * ONE18);
        });

        it("should handle asymmetric price ratios with profit", () => {
            const orderPairObject = makeOrderPairObject(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
            const inputToEthPrice = 1n * ONE18;
            const outputToEthPrice = 2n * ONE18;
            const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 15n * ONE18); // ratio = 0.5, maxOutput = 15
            simulator.tradeArgs.orderDetails = orderPairObject;
            simulator.tradeArgs.inputToEthPrice = formatUnits(inputToEthPrice, 18);
            simulator.tradeArgs.outputToEthPrice = formatUnits(outputToEthPrice, 18);
            simulator.tradeArgs.counterpartyOrderDetails = counterpartyOrder;

            // orderMaxInput = (10 * 1) / 1 = 10
            // opposingMaxInput = (15 * 0.5) / 1 = 7.5
            // orderOutput = min(10, 7.5) = 7.5
            // orderInput = (7.5 * 1) / 1 = 7.5
            // opposingOutput = min(10, 15) = 10
            // opposingInput = (10 * 0.5) / 1 = 5
            // outputProfit = max(0, 7.5 - 5) = 2.5, in ETH = 2.5 * 2 = 5
            // inputProfit = max(0, 10 - 7.5) = 2.5, in ETH = 2.5 * 1 = 2.5
            // total = 5 + 2.5 = 7.5
            const result = simulator.estimateProfit();
            expect(result).toBe(75n * ONE17); // 7.5 * ONE18
        });
    });
});
