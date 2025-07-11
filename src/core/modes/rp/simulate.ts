import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { Token } from "sushi/currency";
import { ChainId, Router } from "sushi";
import { estimateProfit } from "./utils";
import { BundledOrders } from "../../../order";
import { Attributes } from "@opentelemetry/api";
import { Result, ArbAbi } from "../../../common";
import { extendObjectWithHeader } from "../../../logger";
import { ONE18, scale18, scale18To } from "../../../math";
import { RPoolFilter, visualizeRoute } from "../../../router";
import { RainSolverSigner, RawTransaction } from "../../../signer";
import { getBountyEnsureRainlang, parseRainlang } from "../../../task";
import { TakeOrdersConfigType, SimulationResult, TradeType, FailedSimulation } from "../../types";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";

/** Specifies the reason that route processor simulation failed */
export enum RouteProcessorSimulationHaltReason {
    NoOpportunity = 1,
    NoRoute = 2,
    OrderRatioGreaterThanMarketPrice = 3,
}

/** Arguments for simulating route processor trade */
export type SimulateRouteProcessorTradeArgs = {
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: BundledOrders;
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
 * Attempts to find a profitable opportunity (opp) for a given order by simulating a trade against route processor.
 * @param this - The RainSolver instance context
 * @param args - The arguments for simulating the trade
 */
export async function trySimulateTrade(
    this: RainSolver,
    args: SimulateRouteProcessorTradeArgs,
): Promise<SimulationResult> {
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

    const maximumInput = scale18To(maximumInputFixed, orderDetails.sellTokenDecimals);
    spanAttributes["amountIn"] = formatUnits(maximumInputFixed, 18);

    // get route details from sushi dataFetcher
    const pcMap = this.state.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const route = Router.findBestRoute(
        pcMap,
        this.state.chainConfig.id as ChainId,
        fromToken,
        maximumInput,
        toToken,
        Number(gasPrice),
        undefined,
        RPoolFilter,
        undefined,
        this.appOptions.route,
    );

    // exit early if no route found
    if (route.status == "NoWay") {
        spanAttributes["route"] = "no-way";
        const result = {
            type: TradeType.RouteProcessor,
            spanAttributes,
            reason: RouteProcessorSimulationHaltReason.NoRoute,
        };
        return Result.err(result);
    }

    spanAttributes["amountOut"] = formatUnits(route.amountOutBI, toToken.decimals);
    const rateFixed = scale18(route.amountOutBI, orderDetails.buyTokenDecimals);
    const price = (rateFixed * ONE18) / maximumInputFixed;
    spanAttributes["marketPrice"] = formatUnits(price, 18);

    const routeVisual: string[] = [];
    try {
        visualizeRoute(fromToken, toToken, route.legs).forEach((v) => {
            routeVisual.push(v);
        });
    } catch {
        /**/
    }
    spanAttributes["route"] = routeVisual;

    // exit early if market price is lower than order quote ratio
    if (price < orderDetails.takeOrders[0].quote!.ratio) {
        spanAttributes["error"] = "Order's ratio greater than market price";
        const result = {
            type: TradeType.RouteProcessor,
            spanAttributes,
            reason: RouteProcessorSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        };
        return Result.err(result);
    }

    spanAttributes["oppBlockNumber"] = Number(blockNumber);
    const rpParams = Router.routeProcessor4Params(
        pcMap,
        route,
        fromToken,
        toToken,
        this.appOptions.arbAddress as `0x${string}`,
        this.state.chainConfig.routeProcessors["4"],
    );

    const orders = orderDetails.takeOrders.map((v) => v.takeOrder);
    const takeOrdersConfigStruct: TakeOrdersConfigType = {
        minimumInput: 1n,
        maximumInput: isPartial ? maximumInput : maxUint256,
        maximumIORatio: this.appOptions.maxRatio ? maxUint256 : price,
        orders,
        data: encodeAbiParameters([{ type: "bytes" }], [rpParams.routeCode]),
    };
    const task = {
        evaluable: {
            interpreter: this.state.dispair.interpreter as `0x${string}`,
            store: this.state.dispair.store as `0x${string}`,
            bytecode: (this.appOptions.gasCoveragePercentage === "0"
                ? "0x"
                : await parseRainlang(
                      await getBountyEnsureRainlang(
                          parseUnits(ethPrice, 18),
                          0n,
                          0n,
                          signer.account.address,
                      ),
                      this.state.client,
                      this.state.dispair,
                  )) as `0x${string}`,
        },
        signedContext: [],
    };
    const rawtx: RawTransaction = {
        data: encodeFunctionData({
            abi: ArbAbi,
            functionName: "arb3",
            args: [orderDetails.orderbook as `0x${string}`, takeOrdersConfigStruct, task],
        }),
        to: this.appOptions.arbAddress as `0x${string}`,
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
        Object.assign(initDryrunResult.error.spanAttributes, spanAttributes);
        initDryrunResult.error.reason = RouteProcessorSimulationHaltReason.NoOpportunity;
        (initDryrunResult.error as FailedSimulation).type = TradeType.RouteProcessor;
        return Result.err(initDryrunResult.error as FailedSimulation);
    }

    let { estimation, estimatedGasCost } = initDryrunResult.value;
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
        const headroom = BigInt((Number(this.appOptions.gasCoveragePercentage) * 1.03).toFixed());
        spanAttributes["gasEst.initial.minBountyExpected"] = (
            (estimatedGasCost * headroom) /
            100n
        ).toString();
        task.evaluable.bytecode = (await parseRainlang(
            await getBountyEnsureRainlang(
                parseUnits(ethPrice, 18),
                0n,
                (estimatedGasCost * headroom) / 100n,
                signer.account.address,
            ),
            this.state.client,
            this.state.dispair,
        )) as `0x${string}`;
        rawtx.data = encodeFunctionData({
            abi: ArbAbi,
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
            Object.assign(finalDryrunResult.error.spanAttributes, spanAttributes);
            finalDryrunResult.error.reason = RouteProcessorSimulationHaltReason.NoOpportunity;
            (finalDryrunResult.error as FailedSimulation).type = TradeType.RouteProcessor;
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

        task.evaluable.bytecode = (await parseRainlang(
            await getBountyEnsureRainlang(
                parseUnits(ethPrice, 18),
                0n,
                (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) / 100n,
                signer.account.address,
            ),
            this.state.client,
            this.state.dispair,
        )) as `0x${string}`;
        rawtx.data = encodeFunctionData({
            abi: ArbAbi,
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
        type: TradeType.RouteProcessor,
        spanAttributes,
        rawtx,
        estimatedGasCost,
        oppBlockNumber: Number(blockNumber),
        estimatedProfit: estimateProfit(
            orderDetails,
            parseUnits(ethPrice, 18),
            price,
            maximumInputFixed,
        )!,
    };
    return Result.ok(result);
}

/**
 * Calculates the largest possible partial trade size for rp clear, returns undefined if
 * it cannot be determined due to the fact that order's ratio being higher than market
 * price
 * @param this - The RainSolver instance
 * @param orderDetails - The order details
 * @param toToken - The token to trade to
 * @param fromToken - The token to trade from
 * @param maximumInputFixed - The maximum input amount (in 18 decimals)
 */
export function findLargestTradeSize(
    this: RainSolver,
    orderDetails: BundledOrders,
    toToken: Token,
    fromToken: Token,
    maximumInputFixed: bigint,
): bigint | undefined {
    const result: bigint[] = [];
    const gasPrice = Number(this.state.gasPrice);
    const ratio = orderDetails.takeOrders[0].quote!.ratio;
    const pcMap = this.state.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
    const initAmount = scale18To(maximumInputFixed, fromToken.decimals) / 2n;
    let maximumInput = initAmount;
    for (let i = 1n; i < 26n; i++) {
        const maxInput18 = scale18(maximumInput, fromToken.decimals);
        const route = Router.findBestRoute(
            pcMap,
            this.state.chainConfig.id as ChainId,
            fromToken,
            maximumInput,
            toToken,
            gasPrice,
            undefined,
            RPoolFilter,
            undefined,
            this.appOptions.route,
        );

        if (route.status == "NoWay") {
            maximumInput = maximumInput - initAmount / 2n ** i;
        } else {
            const amountOut = scale18(route.amountOutBI, toToken.decimals);
            const price = (amountOut * ONE18) / maxInput18;

            if (price < ratio) {
                maximumInput = maximumInput - initAmount / 2n ** i;
            } else {
                result.unshift(maxInput18);
                maximumInput = maximumInput + initAmount / 2n ** i;
            }
        }
    }

    if (result.length) {
        return result[0];
    } else {
        return undefined;
    }
}
