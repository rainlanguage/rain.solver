import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { estimateProfit } from "./utils";
import { scaleFrom18 } from "../../../math";
import { errorSnapshot } from "../../../error";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { extendObjectWithHeader } from "../../../logger";
import { Result, ABI, RawTransaction } from "../../../common";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { SimulationResult, TradeType, FailedSimulation } from "../../types";
import { RainSolverRouterErrorType, RouterType } from "../../../router/types";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

/** Specifies the reason that router simulation failed */
export enum RouterSimulationHaltReason {
    NoOpportunity = 1,
    NoRoute = 2,
    OrderRatioGreaterThanMarketPrice = 3,
}

/** Arguments for simulating router trade */
export type SimulateRouterTradeArgs = {
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: Pair;
    /** The RainSolverSigner instance used for signing transactions */
    signer: RainSolverSigner;
    /** The current ETH price (in 18 decimals) */
    ethPrice: string;
    /** The token to be received in the swap */
    toToken: Token;
    /** The token to be sold in the swap */
    fromToken: Token;
    /** The maximum input amount (in 18 decimals) */
    maximumInputFixed: bigint;
    /** The current block number for context */
    blockNumber: bigint;
    /** Whether should set partial max input for take order */
    isPartial: boolean;
};

/**
 * Attempts to find a profitable opportunity (opp) for a given order by simulating a trade against rain router.
 * @param this - The RainSolver instance context
 * @param args - The arguments for simulating the trade
 */
export async function trySimulateTrade(
    this: RainSolver,
    args: SimulateRouterTradeArgs,
): Promise<SimulationResult> {
    const startTime = performance.now();
    const {
        orderDetails,
        signer,
        ethPrice,
        toToken,
        fromToken,
        maximumInputFixed,
        blockNumber,
        isPartial,
    } = args;
    const gasPrice = this.state.gasPrice;
    const spanAttributes: Attributes = {};

    const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
    spanAttributes["amountIn"] = formatUnits(maximumInputFixed, 18);

    const tradeParamsResult = await this.state.router.getTradeParams({
        state: this.state,
        orderDetails,
        fromToken,
        toToken,
        maximumInput,
        signer,
        blockNumber,
        isPartial,
    });
    if (tradeParamsResult.isErr()) {
        const result = {
            type: TradeType.Router,
            spanAttributes,
            reason: RouterSimulationHaltReason.NoOpportunity,
        };
        if (tradeParamsResult.error.typ === RainSolverRouterErrorType.NoRouteFound) {
            spanAttributes["route"] = "no way for sushi and balancer";
            result.reason = RouterSimulationHaltReason.NoRoute;
        } else {
            spanAttributes["error"] = tradeParamsResult.error.message;
        }
        spanAttributes["duration"] = performance.now() - startTime;
        return Result.err(result);
    }
    const { type: routeType, quote, routeVisual, takeOrdersConfigStruct } = tradeParamsResult.value;

    // determine trade type based on router type
    let type = TradeType.RouteProcessor;
    let arbAddress = this.appOptions.arbAddress;
    if (routeType === RouterType.Sushi) {
        type = TradeType.RouteProcessor;
    } else if (routeType === RouterType.Balancer) {
        type = TradeType.Balancer;
        arbAddress = this.appOptions.balancerArbAddress!;
    } else {
        type = TradeType.Router;
    }

    spanAttributes["amountOut"] = formatUnits(quote.amountOut, toToken.decimals);
    spanAttributes["marketPrice"] = formatUnits(quote.price, 18);
    spanAttributes["route"] = routeVisual;

    // exit early if market price is lower than order quote ratio
    if (quote.price < orderDetails.takeOrder.quote!.ratio) {
        spanAttributes["error"] = "Order's ratio greater than market price";
        const result = {
            type,
            spanAttributes,
            reason: RouterSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        };
        spanAttributes["duration"] = performance.now() - startTime;
        return Result.err(result);
    }

    spanAttributes["oppBlockNumber"] = Number(blockNumber);

    // try to get task bytecode for ensure bounty task
    const taskBytecodeResult = await getEnsureBountyTaskBytecode(
        {
            type: EnsureBountyTaskType.External,
            inputToEthPrice: parseUnits(ethPrice, 18),
            outputToEthPrice: 0n,
            minimumExpected: 0n,
            sender: signer.account.address,
        },
        this.state.client,
        this.state.dispair,
    );
    if (taskBytecodeResult.isErr()) {
        const errMsg = await errorSnapshot("", taskBytecodeResult.error);
        spanAttributes["isNodeError"] =
            taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
        spanAttributes["error"] = errMsg;
        const result = {
            type,
            spanAttributes,
            reason: RouterSimulationHaltReason.NoOpportunity,
        };
        spanAttributes["duration"] = performance.now() - startTime;
        return Result.err(result);
    }
    const task = {
        evaluable: {
            interpreter: this.state.dispair.interpreter as `0x${string}`,
            store: this.state.dispair.store as `0x${string}`,
            bytecode:
                this.appOptions.gasCoveragePercentage === "0" ? "0x" : taskBytecodeResult.value,
        },
        signedContext: [],
    };
    const rawtx: RawTransaction = {
        data: encodeFunctionData({
            abi: ABI.Orderbook.Primary.Arb,
            functionName: "arb3",
            args: [orderDetails.orderbook as `0x${string}`, takeOrdersConfigStruct, task],
        }),
        to: arbAddress as `0x${string}`,
        gasPrice,
    };

    // initial dryrun with 0 minimum sender output to get initial
    // pass and tx gas cost to calc minimum sender output
    const initDryrunResult = await dryrun(
        signer,
        rawtx,
        gasPrice,
        this.appOptions.gasLimitMultiplier,
    );
    if (initDryrunResult.isErr()) {
        spanAttributes["stage"] = 1;
        spanAttributes["duration"] = performance.now() - startTime;
        Object.assign(initDryrunResult.error.spanAttributes, spanAttributes);
        initDryrunResult.error.reason = RouterSimulationHaltReason.NoOpportunity;
        (initDryrunResult.error as FailedSimulation).type = type;
        return Result.err(initDryrunResult.error as FailedSimulation);
    }

    let { estimation, estimatedGasCost } = initDryrunResult.value;
    delete rawtx.gas; // delete gas to let signer estimate gas again with updated tx data
    // include dryrun initial gas estimation in logs
    Object.assign(spanAttributes, initDryrunResult.value.spanAttributes);
    extendObjectWithHeader(
        spanAttributes,
        {
            gasLimit: estimation.gas.toString(),
            totalCost: estimation.totalGasCost.toString(),
            gasPrice: estimation.gasPrice.toString(),
            ...(this.state.chainConfig.isSpecialL2
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
    if (this.appOptions.gasCoveragePercentage !== "0") {
        const headroom = BigInt((Number(this.appOptions.gasCoveragePercentage) * 1.01).toFixed());
        spanAttributes["gasEst.initial.minBountyExpected"] = (
            (estimatedGasCost * headroom) /
            100n
        ).toString();

        // try to get task bytecode for ensure bounty task
        let taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(ethPrice, 18),
                outputToEthPrice: 0n,
                minimumExpected: (estimatedGasCost * headroom) / 100n,
                sender: signer.account.address,
            },
            this.state.client,
            this.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            spanAttributes["isNodeError"] =
                taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
            spanAttributes["error"] = errMsg;
            const result = {
                type,
                spanAttributes,
                reason: RouterSimulationHaltReason.NoOpportunity,
            };
            spanAttributes["duration"] = performance.now() - startTime;
            return Result.err(result);
        }

        task.evaluable.bytecode = taskBytecodeResult.value;
        rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Arb,
            functionName: "arb3",
            args: [orderDetails.orderbook as `0x${string}`, takeOrdersConfigStruct, task],
        });

        const finalDryrunResult = await dryrun(
            signer,
            rawtx,
            gasPrice,
            this.appOptions.gasLimitMultiplier,
        );
        if (finalDryrunResult.isErr()) {
            spanAttributes["stage"] = 2;
            spanAttributes["duration"] = performance.now() - startTime;
            Object.assign(finalDryrunResult.error.spanAttributes, spanAttributes);
            finalDryrunResult.error.reason = RouterSimulationHaltReason.NoOpportunity;
            (finalDryrunResult.error as FailedSimulation).type = type;
            return Result.err(finalDryrunResult.error as FailedSimulation);
        }

        ({ estimation, estimatedGasCost } = finalDryrunResult.value);
        // include dryrun final gas estimation in otel logs
        Object.assign(spanAttributes, finalDryrunResult.value.spanAttributes);
        extendObjectWithHeader(
            spanAttributes,
            {
                gasLimit: estimation.gas.toString(),
                totalCost: estimation.totalGasCost.toString(),
                gasPrice: estimation.gasPrice.toString(),
                ...(this.state.chainConfig.isSpecialL2
                    ? {
                          l1Cost: estimation.l1Cost.toString(),
                          l1GasPrice: estimation.l1GasPrice.toString(),
                      }
                    : {}),
            },
            "gasEst.final",
        );

        // try to get task bytecode for ensure bounty task
        taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(ethPrice, 18),
                outputToEthPrice: 0n,
                minimumExpected:
                    (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) / 100n,
                sender: signer.account.address,
            },
            this.state.client,
            this.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            spanAttributes["isNodeError"] =
                taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
            spanAttributes["error"] = errMsg;
            const result = {
                type,
                spanAttributes,
                reason: RouterSimulationHaltReason.NoOpportunity,
            };
            spanAttributes["duration"] = performance.now() - startTime;
            return Result.err(result);
        }

        task.evaluable.bytecode = taskBytecodeResult.value;
        rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Arb,
            functionName: "arb3",
            args: [orderDetails.orderbook as `0x${string}`, takeOrdersConfigStruct, task],
        });
        spanAttributes["gasEst.final.minBountyExpected"] = (
            (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) /
            100n
        ).toString();
    }

    // if reached here, it means there was a success and found opp
    spanAttributes["foundOpp"] = true;
    const result = {
        type,
        spanAttributes,
        rawtx,
        estimatedGasCost,
        oppBlockNumber: Number(blockNumber),
        estimatedProfit: estimateProfit(
            orderDetails,
            parseUnits(ethPrice, 18),
            quote.price,
            maximumInputFixed,
        )!,
    };
    spanAttributes["duration"] = performance.now() - startTime;
    return Result.ok(result);
}
