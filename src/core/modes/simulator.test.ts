import { RainSolver } from "..";
import { dryrun } from "./dryrun";
import { ONE18 } from "../../math";
import { TradeType } from "../types";
import { Result } from "../../common";
import { RainSolverSigner } from "../../signer";
import { extendObjectWithHeader } from "../../common";
import { formatUnits } from "viem";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    SimulateTradeArgs,
    TradeSimulatorBase,
    PreparedTradeParams,
    SimulationHaltReason,
} from "./simulator";

vi.mock("../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    extendObjectWithHeader: vi.fn(),
}));

vi.mock("./dryrun", () => ({
    dryrun: vi.fn(),
}));

// mock class extending TradeSimulatorBase for testing
class MockTradeSimulator extends TradeSimulatorBase {
    prepareTradeParams = vi.fn();
    setTransactionData = vi.fn();
    estimateProfit = vi.fn();
}

describe("Test TradeSimulatorBase", () => {
    let mockSolver: RainSolver;
    let mockSigner: RainSolverSigner;
    let tradeArgs: SimulateTradeArgs;
    let mockSimulator: MockTradeSimulator;
    let preparedParams: PreparedTradeParams;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSolver = {
            state: {
                gasPrice: 1000000000000000000n,
                gasLimitMultiplier: 1.5,
                chainConfig: {
                    isSpecialL2: true,
                },
            },
            appOptions: {
                gasLimitMultiplier: 1.5,
                gasCoveragePercentage: "100",
                headroom: 3.5,
            },
        } as any as RainSolver;
        mockSigner = { name: "signer" } as RainSolverSigner;
        tradeArgs = {
            type: TradeType.Router,
            solver: mockSolver,
            orderDetails: {} as any,
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
            minimumExpected: 0n,
            takeOrdersConfigStruct: {} as any,
        };
        mockSimulator = new MockTradeSimulator(tradeArgs);
    });

    describe("Test construction args", () => {
        it("should set the tradeArgs and solver properties correctly", () => {
            expect(mockSimulator.tradeArgs).toBe(tradeArgs);
            expect(mockSimulator.tradeArgs.solver).toBe(mockSolver);
            expect(mockSimulator.startTime).toBeGreaterThan(0);
            expect(mockSimulator.spanAttributes).toEqual({});
        });
    });

    describe("Test simulateTrade method", async () => {
        it("should return error if prepareTradeParams fails", async () => {
            const prepareError = { type: TradeType.Router, spanAttributes: { key: "value" } };
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.err(prepareError),
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error).toBe(prepareError);
            expect(result.error.type).toBe(prepareError.type);
            expect(result.error.spanAttributes["key"]).toBe("value");
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(dryrun).not.toHaveBeenCalled();
            expect(mockSimulator.setTransactionData).not.toHaveBeenCalled();
            expect(extendObjectWithHeader).not.toHaveBeenCalled();
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return error if initial setTransactionData fails", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            const setTransactionDataError = {
                type: preparedParams.type,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
                spanAttributes: { keyTx: "valueTx" },
            };
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(
                Result.err(setTransactionDataError),
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error).toBe(setTransactionDataError);
            expect(result.error.type).toBe(preparedParams.type);
            expect(result.error.reason).toBe(setTransactionDataError.reason);
            expect(result.error.spanAttributes["keyTx"]).toBe("valueTx");
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(dryrun).not.toHaveBeenCalled();
            expect(extendObjectWithHeader).not.toHaveBeenCalled();
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return error if initial dryrun fails", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            const dryrunError = {
                type: preparedParams.type,
                spanAttributes: { key: "value" },
            };
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(Result.ok(void 0));
            (dryrun as Mock).mockResolvedValueOnce(Result.err(dryrunError));

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
            expect(result.error.type).toBe(preparedParams.type);
            expect(result.error.spanAttributes["key"]).toBe("value");
            expect(result.error.spanAttributes["stage"]).toBe(1);
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(dryrun).toHaveBeenCalledTimes(1);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).not.toHaveBeenCalled();
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return success if init dryrun succeeds when gasCoveragePercentage is 0", async () => {
            mockSolver.appOptions.gasCoveragePercentage = "0";
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock).mockResolvedValueOnce(Result.ok(dryrunResult));
            const profitEstimate = 1234n;
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(profitEstimate);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.estimatedProfit).toBe(profitEstimate);
            expect(result.value.estimatedGasCost).toBe(dryrunResult.estimatedGasCost);
            expect(result.value.type).toBe(preparedParams.type);
            expect(result.value.oppBlockNumber).toBe(Number(tradeArgs.blockNumber));
            expect(result.value.rawtx).toBe(preparedParams.rawtx);
            expect(result.value.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.value.spanAttributes["foundOpp"]).toBe(true);
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(dryrun).toHaveBeenCalledTimes(1);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).toHaveBeenCalledTimes(1);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult.estimation.gas.toString(),
                    totalCost: dryrunResult.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.initial",
            );
            expect(mockSimulator.estimateProfit).toHaveBeenCalledTimes(1);
            expect(mockSimulator.estimateProfit).toHaveBeenCalledWith(preparedParams.price);
        });

        it("should return error if second setTransactionData fails when gasCoveragePercentage is NOT 0", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock).mockResolvedValueOnce(Result.ok(dryrunResult));
            // second call to setTransactionData fails
            const setTransactionDataError = {
                type: preparedParams.type,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
                spanAttributes: { keyTx: "valueTx" },
            };
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(
                Result.err(setTransactionDataError),
            );
            const headroom = BigInt(
                (
                    Number(mockSolver.appOptions.gasCoveragePercentage) *
                    mockSolver.appOptions.headroom
                ).toFixed(),
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error).toBe(setTransactionDataError);
            expect(result.error.type).toBe(preparedParams.type);
            expect(result.error.reason).toBe(setTransactionDataError.reason);
            expect(result.error.spanAttributes["keyTx"]).toBe("valueTx");
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(2);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: (dryrunResult.estimatedGasCost * headroom) / 10000n,
            });
            expect(dryrun).toHaveBeenCalledTimes(1);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).toHaveBeenCalledTimes(1);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult.estimation.gas.toString(),
                    totalCost: dryrunResult.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.initial",
            );
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return error if second dryrun fails when gasCoveragePercentage is NOT 0", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock).mockResolvedValueOnce(Result.ok(dryrunResult));
            const dryrunError = {
                type: preparedParams.type,
                spanAttributes: { key: "value" },
            };
            (dryrun as Mock).mockResolvedValueOnce(Result.err(dryrunError));
            const headroom = BigInt(
                (
                    Number(mockSolver.appOptions.gasCoveragePercentage) *
                    mockSolver.appOptions.headroom
                ).toFixed(),
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
            expect(result.error.type).toBe(preparedParams.type);
            expect(result.error.spanAttributes["key"]).toBe("value");
            expect(result.error.spanAttributes["stage"]).toBe(2);
            expect(result.error.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(2);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: (dryrunResult.estimatedGasCost * headroom) / 10000n,
            });
            expect(dryrun).toHaveBeenCalledTimes(2);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).toHaveBeenCalledTimes(1);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult.estimation.gas.toString(),
                    totalCost: dryrunResult.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.initial",
            );
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return error if last setTransactionData fails when gasCoveragePercentage is NOT 0", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            const dryrunResult2 = {
                estimation: {
                    gas: 22000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 22000n * 1000000000000000000n,
                },
                estimatedGasCost: 22000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult2));
            const headroom = BigInt(
                (
                    Number(mockSolver.appOptions.gasCoveragePercentage) *
                    mockSolver.appOptions.headroom
                ).toFixed(),
            );
            // last call to setTransactionData fails
            const setTransactionDataError = {
                type: preparedParams.type,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
                spanAttributes: { keyTx: "valueTx" },
            };
            (mockSimulator.setTransactionData as Mock).mockResolvedValueOnce(
                Result.err(setTransactionDataError),
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isErr());
            expect(result.error).toBe(setTransactionDataError);
            expect(result.error.type).toBe(preparedParams.type);
            expect(result.error.reason).toBe(setTransactionDataError.reason);
            expect(result.error.spanAttributes["keyTx"]).toBe("valueTx");
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(3);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: (dryrunResult.estimatedGasCost * headroom) / 10000n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected:
                    (dryrunResult2.estimatedGasCost *
                        BigInt(mockSolver.appOptions.gasCoveragePercentage)) /
                    100n,
                noTask: true,
            });
            expect(dryrun).toHaveBeenCalledTimes(2);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).toHaveBeenCalledTimes(2);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult.estimation.gas.toString(),
                    totalCost: dryrunResult.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.initial",
            );
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult2.estimation.gas.toString(),
                    totalCost: dryrunResult2.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult2.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult2.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult2.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.final",
            );
            expect(mockSimulator.estimateProfit).not.toHaveBeenCalled();
        });

        it("should return success if all pass when gasCoveragePercentage is NOT 0", async () => {
            const preparedResult = Result.ok(preparedParams);
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(preparedResult);
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            const dryrunResult2 = {
                estimation: {
                    gas: 22000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 22000n * 1000000000000000000n,
                },
                estimatedGasCost: 22000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult2));
            const headroom = BigInt(
                (
                    Number(mockSolver.appOptions.gasCoveragePercentage) *
                    mockSolver.appOptions.headroom
                ).toFixed(),
            );
            const profitEstimate = 1234n;
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(profitEstimate);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.estimatedProfit).toBe(profitEstimate);
            expect(result.value.estimatedGasCost).toBe(dryrunResult2.estimatedGasCost);
            expect(result.value.type).toBe(preparedParams.type);
            expect(result.value.oppBlockNumber).toBe(Number(tradeArgs.blockNumber));
            expect(result.value.rawtx).toBe(preparedParams.rawtx);
            expect(result.value.spanAttributes["duration"]).toBeGreaterThan(0);
            expect(result.value.spanAttributes["foundOpp"]).toBe(true);
            expect(mockSimulator.prepareTradeParams).toHaveBeenCalledTimes(1);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledTimes(3);
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: 0n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected: (dryrunResult.estimatedGasCost * headroom) / 10000n,
            });
            expect(mockSimulator.setTransactionData).toHaveBeenCalledWith({
                ...preparedParams,
                minimumExpected:
                    (dryrunResult2.estimatedGasCost *
                        BigInt(mockSolver.appOptions.gasCoveragePercentage)) /
                    100n,
                noTask: true,
            });
            expect(dryrun).toHaveBeenCalledTimes(2);
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(dryrun).toHaveBeenCalledWith(
                tradeArgs.signer,
                preparedParams.rawtx,
                mockSolver.state.gasPrice,
                mockSolver.appOptions.gasLimitMultiplier,
            );
            expect(extendObjectWithHeader).toHaveBeenCalledTimes(2);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult.estimation.gas.toString(),
                    totalCost: dryrunResult.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.initial",
            );
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                {
                    gasLimit: dryrunResult2.estimation.gas.toString(),
                    totalCost: dryrunResult2.estimation.totalGasCost.toString(),
                    gasPrice: dryrunResult2.estimation.gasPrice.toString(),
                    ...(mockSimulator.tradeArgs.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: dryrunResult2.estimation.l1Cost.toString(),
                              l1GasPrice: dryrunResult2.estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.final",
            );
            expect(mockSimulator.estimateProfit).toHaveBeenCalledTimes(1);
            expect(mockSimulator.estimateProfit).toHaveBeenCalledWith(preparedParams.price);
        });

        it("should boost tx gas price when estimated profit exceeds the min bounty threshold", async () => {
            (mockSolver.appOptions as any).gasBoostProfitThreshold = 10;
            (mockSolver.appOptions as any).gasBoostMultiplier = 2.5;
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            const minimumExpected =
                (dryrunResult.estimatedGasCost *
                    BigInt(mockSolver.appOptions.gasCoveragePercentage)) /
                100n;
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(minimumExpected * 10n + 1n);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(2500n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBe(true);
        });

        it("should not boost tx gas price when estimated profit is at or below the min bounty threshold", async () => {
            (mockSolver.appOptions as any).gasBoostProfitThreshold = 10;
            (mockSolver.appOptions as any).gasBoostMultiplier = 2;
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            const minimumExpected =
                (dryrunResult.estimatedGasCost *
                    BigInt(mockSolver.appOptions.gasCoveragePercentage)) /
                100n;
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(minimumExpected * 10n);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(1000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBeUndefined();
        });

        it("should record USD values in span attributes when gas token USD price is set", async () => {
            (mockSolver.state as any).gasTokenUsdPrice = "2";
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(123n);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            const minimumExpected =
                (dryrunResult.estimatedGasCost *
                    BigInt(mockSolver.appOptions.gasCoveragePercentage)) /
                100n;
            // price is 2 dollars per gas token, so usd values are 2x the eth values
            expect(result.value.spanAttributes["gasEst.final.minBountyExpectedUsd"]).toBe(
                formatUnits(minimumExpected * 2n, 18),
            );
            const headroom = BigInt(
                (
                    Number(mockSolver.appOptions.gasCoveragePercentage) *
                    mockSolver.appOptions.headroom
                ).toFixed(),
            );
            const initialMinimumExpected = (dryrunResult.estimatedGasCost * headroom) / 10000n;
            expect(result.value.spanAttributes["gasEst.initial.minBountyExpectedUsd"]).toBe(
                formatUnits(initialMinimumExpected * 2n, 18),
            );
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                expect.objectContaining({
                    totalCostUsd: formatUnits(dryrunResult.estimatedGasCost * 2n, 18),
                }),
                "gasEst.initial",
            );
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                mockSimulator.spanAttributes,
                expect.objectContaining({
                    totalCostUsd: formatUnits(dryrunResult.estimatedGasCost * 2n, 18),
                }),
                "gasEst.final",
            );
        });

        it("should not boost tx gas price when multiplier is unset even if criteria is met", async () => {
            // criteria threshold is set but multiplier is not, so boost stays inactive
            (mockSolver.appOptions as any).gasBoostProfitThreshold = 10;
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(
                dryrunResult.estimatedGasCost * 1000n,
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(1000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBeUndefined();
        });

        it("should not boost tx gas price when profit usd value is at or below the usd threshold", async () => {
            (mockSolver.appOptions as any).gasBoostMultiplier = 2;
            (mockSolver.appOptions as any).gasBoostUsdThreshold = 100n * ONE18;
            (mockSolver.state as any).gasTokenUsdPrice = "2000";
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            // 0.05 gas token profit at 2000 dollars each equals exactly
            // 100 dollars which is not above the threshold
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(ONE18 / 20n);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(1000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBeUndefined();
        });

        it("should boost tx gas price when estimated profit usd value exceeds the usd threshold", async () => {
            // only the usd threshold criteria is configured, at 100 dollars
            (mockSolver.appOptions as any).gasBoostMultiplier = 2;
            (mockSolver.appOptions as any).gasBoostUsdThreshold = 100n * ONE18;
            (mockSolver.state as any).gasTokenUsdPrice = "2000";
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            // 0.1 gas token profit at 2000 dollars each equals 200 dollars, above the threshold
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(ONE18 / 10n);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(2000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBe(true);
        });

        it("should not boost tx gas price by usd threshold when gas token usd price is unknown", async () => {
            (mockSolver.appOptions as any).gasBoostMultiplier = 2;
            (mockSolver.appOptions as any).gasBoostUsdThreshold = 100n * ONE18;
            // gasTokenUsdPrice is not set on state
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(1000000n * ONE18);

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(1000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBeUndefined();
        });

        it("should not boost tx gas price when gas boost config fields are unset", async () => {
            // gasBoostProfitThreshold and gasBoostMultiplier are not set on appOptions
            preparedParams.rawtx.gasPrice = 1000n;
            (mockSimulator.prepareTradeParams as Mock).mockResolvedValueOnce(
                Result.ok(preparedParams),
            );
            (mockSimulator.setTransactionData as Mock)
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0))
                .mockResolvedValueOnce(Result.ok(void 0));
            const dryrunResult = {
                estimation: {
                    gas: 21000n,
                    gasPrice: 1000000000000000000n,
                    l1GasPrice: 50000000000n,
                    l1Cost: 15000n * 50000000000n,
                    totalGasCost: 21000n * 1000000000000000000n,
                },
                estimatedGasCost: 21000n * 1000000000000000000n + 15000n * 50000000000n,
                spanAttributes: {},
            };
            (dryrun as Mock)
                .mockResolvedValueOnce(Result.ok(dryrunResult))
                .mockResolvedValueOnce(Result.ok(dryrunResult));
            // huge profit, but boost is inactive without the config fields
            (mockSimulator.estimateProfit as Mock).mockReturnValueOnce(
                dryrunResult.estimatedGasCost * 1000n,
            );

            const result = await mockSimulator.trySimulateTrade();
            assert(result.isOk());
            expect(result.value.rawtx.gasPrice).toBe(1000n);
            expect(result.value.spanAttributes["gasPriceBoosted"]).toBeUndefined();
        });
    });
});

describe("Test SimulationHaltReason namespace", () => {
    it("should detect MinimalOutputBalanceViolation in the given text", () => {
        expect(
            SimulationHaltReason.needsRetry(
                'execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)"',
            ),
        ).toBe(true);
        expect(SimulationHaltReason.needsRetry('execution reverted: minimumSenderOutput"')).toBe(
            true,
        );
        expect(SimulationHaltReason.needsRetry('execution reverted: minimum sender output"')).toBe(
            true,
        );
        expect(SimulationHaltReason.needsRetry("some other error")).toBe(false);
        expect(SimulationHaltReason.needsRetry(undefined)).toBe(false);
        expect(SimulationHaltReason.needsRetry(123)).toBe(false);
    });
});
