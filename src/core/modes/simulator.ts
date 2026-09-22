import { dryrun } from "./dryrun";
import { toUsdValue } from "../../math";
import { formatUnits } from "viem";
import { RawTransaction } from "../../common";
import { Attributes } from "@opentelemetry/api";
import { EstimateGasCostResult } from "../../signer";
import { DryrunGasCache } from "../../state/dryrunGasCache";
import { Result, extendObjectWithHeader } from "../../common";
import { FailedSimulation, SimulationResult, TradeType } from "../types";
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

/** The number of steps the gas price boost climbs from no boost to the configured multiplier */
export const GAS_BOOST_STEPS = 4n;

/** Specifies the reason that simulation failed */
export enum SimulationHaltReason {
    NoOpportunity,
    NoRoute,
    OrderRatioGreaterThanMarketPrice,
    FailedToGetTaskBytecode,
    UndefinedTradeDestinationAddress,
    MinimalOutputBalanceViolation,
    DustTradeSize,
    /** The trade does not qualify for a snap tx, the caller falls back to the normal simulation */
    SnapTxNotEligible,
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

        const { solver, signer } = this.tradeArgs;
        const gasTokenUsdPrice = solver.state.gasTokenUsdPrice;

        // the dryrun gas cache stands in for the init dryrun once it holds enough
        // samples for this order pair, it only applies to sushi route processor
        // trades, other trade types have their own gas profiles and dont take part,
        // and it is not used when gas coverage is 0, as then the init dryrun is the
        // only onchain validation of the trade
        const gasCache =
            solver.appOptions.dryrunGasCache &&
            solver.appOptions.gasCoveragePercentage !== "0" &&
            prepareParamsResult.value.type === TradeType.RouteProcessor
                ? solver.state.dryrunGasCache
                : undefined;
        const gasCacheKey = gasCache ? DryrunGasCache.key(this.tradeArgs.orderDetails) : "";
        const cachedGas = gasCache?.get(gasCacheKey);

        let estimation: EstimateGasCostResult;
        let estimatedGasCost: bigint;
        let setTransactionDataResult: Result<void, FailedSimulation>;
        if (cachedGas) {
            // skip the init dryrun and build the initial gas cost from the
            // cached average the same way the dryrun would from an estimation
            const gasLimit = (cachedGas.gas * BigInt(solver.appOptions.gasLimitMultiplier)) / 100n;
            estimatedGasCost = gasLimit * solver.state.gasPrice + cachedGas.l1Cost;
            extendObjectWithHeader(
                this.spanAttributes,
                {
                    cached: true,
                    gasLimit: gasLimit.toString(),
                    totalCost: estimatedGasCost.toString(),
                    gasPrice: solver.state.gasPrice.toString(),
                    ...(gasTokenUsdPrice
                        ? {
                              totalCostUsd: formatUnits(
                                  toUsdValue(estimatedGasCost, gasTokenUsdPrice),
                                  18,
                              ),
                          }
                        : {}),
                    ...(solver.state.chainConfig.isSpecialL2
                        ? { l1Cost: cachedGas.l1Cost.toString() }
                        : {}),
                },
                "gasEst.initial",
            );
        } else {
            // set initial tx data with 0 min expected to get initial dryrun gas cost
            setTransactionDataResult = await this.setTransactionData({
                ...prepareParamsResult.value,
                minimumExpected: 0n,
            });
            if (setTransactionDataResult.isErr()) {
                return Result.err(setTransactionDataResult.error);
            }

            // initial dryrun with 0 minimum sender output to get initial
            // pass and tx gas cost to calc minimum sender output
            const initDryrunResult = await dryrun(
                signer,
                prepareParamsResult.value.rawtx,
                solver.state.gasPrice,
                solver.appOptions.gasLimitMultiplier,
            );
            if (initDryrunResult.isErr()) {
                this.spanAttributes["stage"] = 1;
                this.spanAttributes["duration"] = performance.now() - this.startTime;
                Object.assign(initDryrunResult.error.spanAttributes, this.spanAttributes);
                initDryrunResult.error.reason = SimulationHaltReason.NoOpportunity;
                (initDryrunResult.error as FailedSimulation).type = prepareParamsResult.value.type;
                return Result.err(initDryrunResult.error as FailedSimulation);
            }

            ({ estimation, estimatedGasCost } = initDryrunResult.value);
            gasCache?.recordInit(gasCacheKey, estimation.gas, estimation.l1Cost);
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
                    ...(solver.state.chainConfig.isSpecialL2
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
            if (solver.appOptions.gasCoveragePercentage === "0") {
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
            // carry the gas cost the trade was checked against, so the caller
            // can tell a trade that is too small to ever pay the gas
            (finalDryrunResult.error as FailedSimulation).estimatedGasCost = estimatedGasCost;
            return Result.err(finalDryrunResult.error as FailedSimulation);
        }

        ({ estimation, estimatedGasCost } = finalDryrunResult.value);
        gasCache?.recordFinal(gasCacheKey, estimation.gas, estimation.l1Cost);
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

        const estimatedProfit = this.estimateProfit(prepareParamsResult.value.price)!;
        this.maybeBoostGasPrice(prepareParamsResult.value.rawtx, estimatedProfit, estimatedGasCost);

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

    /**
     * Tries to build the trade tx for submission without any dryrun, a snap tx, the
     * gas limit comes from the dryrun gas cache of the order pair instead, so the tx
     * is ready right after the trade params are prepared, the trade must be a sushi
     * route processor trade (the only ones with a gas cache) with a cached gas, the
     * estimated profit must cover the min expected bounty of the cached gas cost with
     * headroom, and its usd value must exceed the snapTxThresholdUsd config, the tx
     * carries no ensure bounty task, the same as the final tx of the dryrun path, as
     * the min expected bounty check above stands in for the dryrun, fails with the
     * SnapTxNotEligible reason when any of the checks fails, so the caller can fall
     * back to the normal simulation
     */
    async trySnapTrade(): Promise<SimulationResult> {
        const { solver } = this.tradeArgs;
        const { gasTokenUsdPrice, gasPrice } = solver.state;
        let type: TradeType = this.tradeArgs.type;
        const notEligible = (reason: string): SimulationResult => {
            this.spanAttributes["snapTxSkipped"] = reason;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err({
                type,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.SnapTxNotEligible,
            });
        };

        // the cheap checks come before preparing the trade params, so a not
        // eligible trade costs no route work, the gas cache only exists for
        // sushi route processor trades with gas coverage
        if (!solver.appOptions.dryrunGasCache || solver.appOptions.gasCoveragePercentage === "0") {
            return notEligible("dryrun gas cache is disabled or gas coverage is 0");
        }
        const cachedGas = solver.state.dryrunGasCache.get(
            DryrunGasCache.key(this.tradeArgs.orderDetails),
        );
        if (!cachedGas) {
            return notEligible("no cached dryrun gas for the order pair");
        }
        if (!gasTokenUsdPrice) {
            return notEligible("unknown gas token usd price");
        }

        const prepareParamsResult = await this.prepareTradeParams();
        if (prepareParamsResult.isErr()) {
            return Result.err(prepareParamsResult.error);
        }
        type = prepareParamsResult.value.type;
        if (type !== TradeType.RouteProcessor) {
            return notEligible("not a sushi route processor trade");
        }

        // the gas cost from the cached gas, the same way the cached init dryrun stage does
        const gasLimit = (cachedGas.gas * BigInt(solver.appOptions.gasLimitMultiplier)) / 100n;
        const estimatedGasCost = gasLimit * gasPrice + cachedGas.l1Cost;
        const headroom = BigInt(
            (
                Number(solver.appOptions.gasCoveragePercentage) * solver.appOptions.headroom
            ).toFixed(),
        );
        const minimumExpected = (estimatedGasCost * headroom) / 10000n;
        const estimatedProfit = this.estimateProfit(prepareParamsResult.value.price)!;
        const estimatedProfitUsd = toUsdValue(estimatedProfit, gasTokenUsdPrice);
        extendObjectWithHeader(
            this.spanAttributes,
            {
                cached: true,
                gasLimit: gasLimit.toString(),
                totalCost: estimatedGasCost.toString(),
                gasPrice: gasPrice.toString(),
                totalCostUsd: formatUnits(toUsdValue(estimatedGasCost, gasTokenUsdPrice), 18),
                minBountyExpected: minimumExpected.toString(),
                minBountyExpectedUsd: formatUnits(
                    toUsdValue(minimumExpected, gasTokenUsdPrice),
                    18,
                ),
                ...(solver.state.chainConfig.isSpecialL2
                    ? { l1Cost: cachedGas.l1Cost.toString() }
                    : {}),
            },
            "gasEst.snap",
        );
        this.spanAttributes["snapEstimatedProfit"] = formatUnits(estimatedProfit, 18);
        this.spanAttributes["snapEstimatedProfitUsd"] = formatUnits(estimatedProfitUsd, 18);

        // the two checks, the bounty must cover the min expected (gas cost with
        // coverage and headroom) and its usd value must exceed the configured threshold
        if (estimatedProfit < minimumExpected) {
            return notEligible("estimated profit below the min expected bounty");
        }
        if (estimatedProfitUsd <= solver.appOptions.snapTxThresholdUsd) {
            return notEligible("estimated profit usd below snapTxThresholdUsd");
        }

        // build the tx with the ensure bounty task and the cached gas limit
        // build the tx with the cached gas limit and no ensure bounty task, the min
        // expected bounty check above already validated the profitability offchain
        const setTransactionDataResult = await this.setTransactionData({
            ...prepareParamsResult.value,
            minimumExpected,
            noTask: true,
        });
        if (setTransactionDataResult.isErr()) {
            return Result.err(setTransactionDataResult.error);
        }
        prepareParamsResult.value.rawtx.gas = gasLimit;
        this.maybeBoostGasPrice(prepareParamsResult.value.rawtx, estimatedProfit, estimatedGasCost);

        this.spanAttributes["snapTx"] = true;
        this.spanAttributes["foundOpp"] = true;
        this.spanAttributes["duration"] = performance.now() - this.startTime;
        return Result.ok({
            estimatedGasCost,
            type,
            spanAttributes: this.spanAttributes,
            rawtx: prepareParamsResult.value.rawtx,
            oppBlockNumber: Number(this.tradeArgs.blockNumber),
            estimatedProfit,
        });
    }

    /**
     * Boosts the tx gas price if the trade is highly profitable, that is when the
     * estimated profit USD value exceeds the configured USD threshold, this increases
     * the chance of the tx to land onchain faster as the trade can afford it, the
     * boost steps up from no boost to the configured multiplier in a few steps and
     * settles on the last step whose boosted gas cost still fits in the estimated
     * profit, so the boost never makes the trade unprofitable, this has no effect if
     * the config fields are not set or the gas token USD price is unknown
     * @param rawtx - The trade tx to boost the gas price of
     * @param estimatedProfit - The estimated profit of the trade
     * @param estimatedGasCost - The estimated gas cost of the trade at the current gas price
     */
    maybeBoostGasPrice(rawtx: RawTransaction, estimatedProfit: bigint, estimatedGasCost: bigint) {
        const { gasBoostMultiplier, gasBoostUsdThreshold } = this.tradeArgs.solver.appOptions;
        const gasTokenUsdPrice = this.tradeArgs.solver.state.gasTokenUsdPrice;
        const exceedsUsdThreshold =
            gasBoostUsdThreshold !== undefined &&
            !!gasTokenUsdPrice &&
            toUsdValue(estimatedProfit, gasTokenUsdPrice) > gasBoostUsdThreshold;
        if (
            gasBoostMultiplier === undefined ||
            typeof rawtx.gasPrice !== "bigint" ||
            !exceedsUsdThreshold
        ) {
            return;
        }

        // the multipliers are scaled by 100 to apply them with 2 decimal points precision,
        // step from no boost (100) up to the configured multiplier and stop at the first
        // step whose boosted gas cost surpasses the estimated profit, the last step before
        // it is the one applied, no step fitting means no boost at all
        const base = 100n;
        const target = BigInt(Math.round(gasBoostMultiplier * 100));
        let applied = base;
        for (let i = 1n; i <= GAS_BOOST_STEPS; i++) {
            const multiplier = base + ((target - base) * i) / GAS_BOOST_STEPS;
            if ((estimatedGasCost * multiplier) / 100n > estimatedProfit) break;
            applied = multiplier;
        }
        if (applied > base) {
            rawtx.gasPrice = (rawtx.gasPrice * applied) / 100n;
            this.spanAttributes["gasPriceBoosted"] = true;
            this.spanAttributes["gasBoostMultiplierApplied"] = Number(applied) / 100;
        }
    }
}
