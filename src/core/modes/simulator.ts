import { dryrun } from "./dryrun";
import { formatUnits } from "viem";
import { toUsdValue } from "../../math";
import { Attributes } from "@opentelemetry/api";
import { Result, extendObjectWithHeader } from "../../common";
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
import {
    RaindexRouterTradePreparedParams,
    SimulateRaindexRouterTradeArgs,
} from "./raindex/simulation";

/** Specifies the reason that simulation failed */
export enum SimulationHaltReason {
    NoOpportunity,
    NoRoute,
    OrderRatioGreaterThanMarketPrice,
    FailedToGetTaskBytecode,
    UndefinedTradeDestinationAddress,
    MinimalOutputBalanceViolation,
}
export namespace SimulationHaltReason {
    /**
     * Returns true if the given input contains errors that justify a retry
     * Errors include:
     * - the sushi RouteProcessor contract "MinimalOutputBalanceViolation" error selector name
     * - Raindex task": "minimum sender output"
     * - Raindex task: "minimumSenderOutput"
     * @param text - The text to search in
     */
    export function needsRetry(text: unknown): boolean {
        return (
            typeof text === "string" &&
            (text.includes("MinimalOutputBalanceViolation") ||
                text.includes("minimum sender output") ||
                text.includes("minimumSenderOutput"))
        );
    }
}

export type SimulateTradeArgs =
    | SimulateRouterTradeArgs
    | SimulateIntraOrderbookTradeArgs
    | SimulateInterOrderbookTradeArgs
    | SimulateRaindexRouterTradeArgs;

export type PreparedTradeParams =
    | RouterTradePreparedParams
    | IntraOrderbookTradePrepareedParams
    | InterOrderbookTradePreparedParams
    | RaindexRouterTradePreparedParams;

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
    tradeArgs: SimulateTradeArgs;
    readonly spanAttributes: Attributes = {};

    constructor(tradeArgs: SimulateTradeArgs) {
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
            this.tradeArgs.solver.state.gasPrice,
            this.tradeArgs.solver.appOptions.gasLimitMultiplier,
        );
        if (initDryrunResult.isErr()) {
            this.spanAttributes["stage"] = 1;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            Object.assign(initDryrunResult.error.spanAttributes, this.spanAttributes);
            initDryrunResult.error.reason = SimulationHaltReason.NoOpportunity;
            (initDryrunResult.error as FailedSimulation).type = prepareParamsResult.value.type;
            return Result.err(initDryrunResult.error as FailedSimulation);
        }

        const gasTokenUsdPrice = this.tradeArgs.solver.state.gasTokenUsdPrice;
        let { estimation, estimatedGasCost } = initDryrunResult.value;
        // include dryrun initial gas estimation in logs
        Object.assign(this.spanAttributes, initDryrunResult.value.spanAttributes);
        extendObjectWithHeader(
            this.spanAttributes,
            {
                gasLimit: estimation.gas.toString(),
                totalCost: estimation.totalGasCost.toString(),
                gasPrice: estimation.gasPrice.toString(),
                ...(gasTokenUsdPrice
                    ? {
                          totalCostUsd: formatUnits(
                              toUsdValue(estimatedGasCost, gasTokenUsdPrice),
                              18,
                          ),
                      }
                    : {}),
                ...(this.tradeArgs.solver.state.chainConfig.isSpecialL2
                    ? {
                          l1Cost: estimation.l1Cost.toString(),
                          l1GasPrice: estimation.l1GasPrice.toString(),
                      }
                    : {}),
            },
            "gasEst.initial",
        );

        // exit early if gas coverage is 0, as we wont need to determine the
        // profitability of the transaction in this case
        if (this.tradeArgs.solver.appOptions.gasCoveragePercentage === "0") {
            this.spanAttributes["foundOpp"] = true;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.ok({
                estimatedGasCost,
                type: prepareParamsResult.value.type,
                spanAttributes: this.spanAttributes,
                rawtx: prepareParamsResult.value.rawtx,
                oppBlockNumber: Number(this.tradeArgs.blockNumber),
                estimatedProfit: this.estimateProfit(prepareParamsResult.value.price)!,
            });
        }

        // repeat the process again with headroom to get more accurate gas cost
        // and determine the profitability of the transaction

        // delete gas to let signer estimate gas again with updated tx data
        delete prepareParamsResult.value.rawtx.gas;

        // examine the success of the trade with 1.5% headroom
        const headroom = BigInt(
            (
                Number(this.tradeArgs.solver.appOptions.gasCoveragePercentage) *
                this.tradeArgs.solver.appOptions.headroom
            ).toFixed(),
        );
        let minimumExpected = (estimatedGasCost * headroom) / 10000n;
        this.spanAttributes["gasEst.initial.minBountyExpected"] = minimumExpected.toString();
        if (gasTokenUsdPrice) {
            this.spanAttributes["gasEst.initial.minBountyExpectedUsd"] = formatUnits(
                toUsdValue(minimumExpected, gasTokenUsdPrice),
                18,
            );
        }

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
            this.tradeArgs.solver.state.gasPrice,
            this.tradeArgs.solver.appOptions.gasLimitMultiplier,
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
                ...(gasTokenUsdPrice
                    ? {
                          totalCostUsd: formatUnits(
                              toUsdValue(estimatedGasCost, gasTokenUsdPrice),
                              18,
                          ),
                      }
                    : {}),
                ...(this.tradeArgs.solver.state.chainConfig.isSpecialL2
                    ? {
                          l1Cost: estimation.l1Cost.toString(),
                          l1GasPrice: estimation.l1GasPrice.toString(),
                      }
                    : {}),
            },
            "gasEst.final",
        );

        // update the tx data again, this time with an empty task, as the
        // profitability of the trade was already validated by the dryrun
        // above with headroom, so the actual submitting tx doesnt need to
        // carry the ensure bounty task anymore
        minimumExpected =
            (estimatedGasCost * BigInt(this.tradeArgs.solver.appOptions.gasCoveragePercentage)) /
            100n;
        setTransactionDataResult = await this.setTransactionData({
            ...prepareParamsResult.value,
            minimumExpected,
            noTask: true,
        });
        if (setTransactionDataResult.isErr()) {
            return Result.err(setTransactionDataResult.error);
        }

        this.spanAttributes["gasEst.final.minBountyExpected"] = minimumExpected.toString();
        if (gasTokenUsdPrice) {
            this.spanAttributes["gasEst.final.minBountyExpectedUsd"] = formatUnits(
                toUsdValue(minimumExpected, gasTokenUsdPrice),
                18,
            );
        }

        // boost the tx gas price if the trade is highly profitable, that is when the
        // estimated profit exceeds the min expected bounty by the configured threshold
        // or when the estimated profit USD value exceeds the configured USD threshold,
        // this increases the chance of the tx to land onchain faster as the trade can
        // afford it, this has no effect if the config fields are not set
        const estimatedProfit = this.estimateProfit(prepareParamsResult.value.price)!;
        const { gasBoostProfitThreshold, gasBoostMultiplier, gasBoostUsdThreshold } =
            this.tradeArgs.solver.appOptions;
        const exceedsBountyThreshold =
            gasBoostProfitThreshold !== undefined &&
            estimatedProfit > minimumExpected * BigInt(gasBoostProfitThreshold);
        const exceedsUsdThreshold =
            gasBoostUsdThreshold !== undefined &&
            !!gasTokenUsdPrice &&
            toUsdValue(estimatedProfit, gasTokenUsdPrice) > gasBoostUsdThreshold;
        if (
            gasBoostMultiplier !== undefined &&
            typeof prepareParamsResult.value.rawtx.gasPrice === "bigint" &&
            (exceedsBountyThreshold || exceedsUsdThreshold)
        ) {
            // scale the multiplier by 100 to apply it with 2 decimal points precision
            prepareParamsResult.value.rawtx.gasPrice =
                (prepareParamsResult.value.rawtx.gasPrice *
                    BigInt(Math.round(gasBoostMultiplier * 100))) /
                100n;
            this.spanAttributes["gasPriceBoosted"] = true;
        }

        this.spanAttributes["foundOpp"] = true;
        this.spanAttributes["duration"] = performance.now() - this.startTime;
        return Result.ok({
            estimatedGasCost,
            type: prepareParamsResult.value.type,
            spanAttributes: this.spanAttributes,
            rawtx: prepareParamsResult.value.rawtx,
            oppBlockNumber: Number(this.tradeArgs.blockNumber),
            estimatedProfit,
        });
    }
}
