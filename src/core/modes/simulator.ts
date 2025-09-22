import { RainSolver } from "..";
import { dryrun } from "./dryrun";
import { Result } from "../../common";
import { Attributes } from "@opentelemetry/api";
import { extendObjectWithHeader } from "../../logger";
import { FailedSimulation, SimulationResult } from "../types";
import { RouterTradePreparedParams, SimulateRouterTradeArgs } from "./router/simulate";
import {
    SimulateIntraOrderbookTradeArgs,
    IntraOrderbookTradePrepareedParams,
} from "./intra/simulation";
import {
    SimulateInterOrderbookTradeArgs,
    InterOrderbookTradePreparedParams,
} from "./inter/simulate";

/** Specifies the reason that simulation failed */
export enum SimulationHaltReason {
    NoOpportunity = 1,
    NoRoute = 2,
    OrderRatioGreaterThanMarketPrice = 3,
    FailedToGetTaskBytecode = 4,
}

export type SimulateTradeArgs =
    | SimulateRouterTradeArgs
    | SimulateIntraOrderbookTradeArgs
    | SimulateInterOrderbookTradeArgs;

export type PreparedTradeParams =
    | RouterTradePreparedParams
    | IntraOrderbookTradePrepareedParams
    | InterOrderbookTradePreparedParams;

/**
 * Base class for simulating trades against different platforms.
 * Child classes must implement methods to prepare trade parameters,
 * set transaction data, and estimate profit for specific trade types.
 * The returned transaction object from the implemented methods then
 * is used to perform a dryrun to estimate gas costs and check for
 * profitability and build up the final transaction object.
 */
export abstract class TradeSimulatorBase {
    startTime: number;
    solver: RainSolver;
    tradeArgs: SimulateTradeArgs;
    readonly spanAttributes: Attributes = {};

    constructor(solver: RainSolver, tradeArgs: SimulateTradeArgs) {
        this.solver = solver;
        this.tradeArgs = tradeArgs;
        this.startTime = performance.now();
    }

    /**
     * Prepares the trade parameters required for simulating and building the transaction object.
     * The child class must implement this method to handle specific trade types.
     */
    protected abstract prepareTradeParams(): Promise<Result<PreparedTradeParams, FailedSimulation>>;

    /**
     * Sets the transaction data for the trade tx object with the updated minimum expected task.
     * The child class must implement this method to handle specific trade types.
     * @param params - The prepared trade parameters
     */
    protected abstract setTransactionData(
        params: PreparedTradeParams,
    ): Promise<Result<void, FailedSimulation>>;

    /**
     * Estimates the profit for the trade.
     * The child class must implement this method to handle specific trade types.
     * @param marketPrice - The current market price (in 18 decimals)
     */
    protected abstract estimateProfit(marketPrice?: bigint): bigint;

    /**
     * Attempts to find a profitable opportunity (opp) for a given
     * order by simulating a trade against target platform liquidity.
     */
    async trySimulateTrade(): Promise<SimulationResult> {
        const prepareParamsResult = await this.prepareTradeParams();
        if (prepareParamsResult.isErr()) {
            return Result.err(prepareParamsResult.error);
        }

        // set initial tx data with 0 min expected to get initial dryrun gas cost
        let setTransactionDataResult = await this.setTransactionData({
            ...prepareParamsResult.value,
            minimumExpected: 0n,
        });
        if (setTransactionDataResult.isErr()) {
            return Result.err(setTransactionDataResult.error);
        }

        // initial dryrun with 0 minimum sender output to get initial
        // pass and tx gas cost to calc minimum sender output
        const initDryrunResult = await dryrun(
            this.tradeArgs.signer,
            prepareParamsResult.value.rawtx,
            this.solver.state.gasPrice,
            this.solver.appOptions.gasLimitMultiplier,
        );
        if (initDryrunResult.isErr()) {
            this.spanAttributes["stage"] = 1;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            Object.assign(initDryrunResult.error.spanAttributes, this.spanAttributes);
            initDryrunResult.error.reason = SimulationHaltReason.NoOpportunity;
            (initDryrunResult.error as FailedSimulation).type = prepareParamsResult.value.type;
            return Result.err(initDryrunResult.error as FailedSimulation);
        }

        let { estimation, estimatedGasCost } = initDryrunResult.value;
        // include dryrun initial gas estimation in logs
        Object.assign(this.spanAttributes, initDryrunResult.value.spanAttributes);
        extendObjectWithHeader(
            this.spanAttributes,
            {
                gasLimit: estimation.gas.toString(),
                totalCost: estimation.totalGasCost.toString(),
                gasPrice: estimation.gasPrice.toString(),
                ...(this.solver.state.chainConfig.isSpecialL2
                    ? {
                          l1Cost: estimation.l1Cost.toString(),
                          l1GasPrice: estimation.l1GasPrice.toString(),
                      }
                    : {}),
            },
            "gasEst.initial",
        );

        // repeat the same process with headroom if gas
        // coverage is not 0, 0 gas coverage means 0 minimum
        // sender output which is already called above
        if (this.solver.appOptions.gasCoveragePercentage !== "0") {
            delete prepareParamsResult.value.rawtx.gas; // delete gas to let signer estimate gas again with updated tx data
            const headroom = BigInt(
                (Number(this.solver.appOptions.gasCoveragePercentage) * 1.01).toFixed(),
            );
            let minimumExpected = (estimatedGasCost * headroom) / 100n;
            this.spanAttributes["gasEst.initial.minBountyExpected"] = minimumExpected.toString();

            // update the tx data with the new min sender output
            setTransactionDataResult = await this.setTransactionData({
                ...prepareParamsResult.value,
                minimumExpected,
            });
            if (setTransactionDataResult.isErr()) {
                return Result.err(setTransactionDataResult.error);
            }

            const finalDryrunResult = await dryrun(
                this.tradeArgs.signer,
                prepareParamsResult.value.rawtx,
                this.solver.state.gasPrice,
                this.solver.appOptions.gasLimitMultiplier,
            );
            if (finalDryrunResult.isErr()) {
                this.spanAttributes["stage"] = 2;
                this.spanAttributes["duration"] = performance.now() - this.startTime;
                Object.assign(finalDryrunResult.error.spanAttributes, this.spanAttributes);
                finalDryrunResult.error.reason = SimulationHaltReason.NoOpportunity;
                (finalDryrunResult.error as FailedSimulation).type = prepareParamsResult.value.type;
                return Result.err(finalDryrunResult.error as FailedSimulation);
            }

            ({ estimation, estimatedGasCost } = finalDryrunResult.value);
            // include dryrun final gas estimation in otel logs
            Object.assign(this.spanAttributes, finalDryrunResult.value.spanAttributes);
            extendObjectWithHeader(
                this.spanAttributes,
                {
                    gasLimit: estimation.gas.toString(),
                    totalCost: estimation.totalGasCost.toString(),
                    gasPrice: estimation.gasPrice.toString(),
                    ...(this.solver.state.chainConfig.isSpecialL2
                        ? {
                              l1Cost: estimation.l1Cost.toString(),
                              l1GasPrice: estimation.l1GasPrice.toString(),
                          }
                        : {}),
                },
                "gasEst.final",
            );

            // update the tx data again with the new min sender output
            minimumExpected =
                (estimatedGasCost * BigInt(this.solver.appOptions.gasCoveragePercentage)) / 100n;
            setTransactionDataResult = await this.setTransactionData({
                ...prepareParamsResult.value,
                minimumExpected,
            });
            if (setTransactionDataResult.isErr()) {
                return Result.err(setTransactionDataResult.error);
            }

            this.spanAttributes["gasEst.final.minBountyExpected"] = minimumExpected.toString();
        }

        // if reached here, it means there was a success and found opp
        this.spanAttributes["foundOpp"] = true;
        const result = {
            type: prepareParamsResult.value.type,
            spanAttributes: this.spanAttributes,
            rawtx: prepareParamsResult.value.rawtx,
            estimatedGasCost,
            oppBlockNumber: Number(this.tradeArgs.blockNumber),
            estimatedProfit: this.estimateProfit(prepareParamsResult.value.price)!,
        };
        this.spanAttributes["duration"] = performance.now() - this.startTime;
        return Result.ok(result);
    }
}
