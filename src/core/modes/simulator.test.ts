import { RainSolver } from "..";
import { dryrun } from "./dryrun";
import { ONE18 } from "../../math";
import { TradeType } from "../types";
import { Result } from "../../common";
import { RainSolverSigner } from "../../signer";
import { extendObjectWithHeader } from "../../logger";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    SimulateTradeArgs,
    TradeSimulatorBase,
    PreparedTradeParams,
    SimulationHaltReason,
} from "./simulator";

vi.mock("../../logger", () => ({
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
                (Number(mockSolver.appOptions.gasCoveragePercentage) * 100.25).toFixed(),
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
                (Number(mockSolver.appOptions.gasCoveragePercentage) * 100.25).toFixed(),
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
                (Number(mockSolver.appOptions.gasCoveragePercentage) * 100.25).toFixed(),
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
                (Number(mockSolver.appOptions.gasCoveragePercentage) * 100.25).toFixed(),
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
    });
});
