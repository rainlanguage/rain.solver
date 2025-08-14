import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
// import { ChainId, Router } from "sushi";
import { Attributes } from "@opentelemetry/api";
import { Result, ABI } from "../../../common";
import { extendObjectWithHeader } from "../../../logger";
import { ONE18, scaleTo18, scaleFrom18 } from "../../../math";
// import { RPoolFilter, visualizeRoute } from "../../../router";
import { RainSolverSigner, RawTransaction } from "../../../signer";
import { getBountyEnsureRainlang, parseRainlang } from "../../../task";
import { TakeOrdersConfigType, SimulationResult, TradeType, FailedSimulation } from "../../types";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import { getBalancerMarketPrice, getBestBalancerRoute } from "../../../router/balancer";
import { AddressProvider } from "@balancer/sdk";

/** Specifies the reason that route processor simulation failed */
export enum BalancerRouterSimulationHaltReason {
    NoOpportunity = 1,
    NoRoute = 2,
    OrderRatioGreaterThanMarketPrice = 3,
}

/** Arguments for simulating route processor trade */
export type SimulateRouteProcessorTradeArgs = {
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
    const { orderDetails, signer, ethPrice, toToken, fromToken, maximumInputFixed, blockNumber } =
        args;
    const gasPrice = this.state.gasPrice;
    const spanAttributes: Attributes = {};

    const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
    spanAttributes["amountIn"] = formatUnits(maximumInputFixed, 18);

    const route = await getBestBalancerRoute.call(this.state, {
        tokenIn: fromToken,
        tokenOut: toToken,
        swapAmount: maximumInput,
    });
    // const route = Result.ok<BalancerRouterPath[], Error>([
    //     {
    //         steps: [
    //             {
    //                 pool: "0x88c044fb203b58b12252be7242926b1eeb113b4a",
    //                 tokenOut: "0x4200000000000000000000000000000000000006",
    //                 isBuffer: false,
    //             },
    //         ],
    //         tokenIn: fromToken.address as `0x${string}`,
    //         exactAmountIn: maximumInput,
    //         minAmountOut: 0n,
    //     },
    // ]);
    if (route.isErr()) {
        spanAttributes["error"] = route.error.message;
        return Result.err({
            type: TradeType.Balancer,
            spanAttributes,
            reason: BalancerRouterSimulationHaltReason.NoRoute,
        });
    }

    const amountOut = await getBalancerMarketPrice.call(this.state, route.value, signer);
    if (amountOut.isErr()) {
        spanAttributes["error"] = amountOut.error.message;
        return Result.err({
            type: TradeType.Balancer,
            spanAttributes,
            reason: BalancerRouterSimulationHaltReason.NoRoute,
        });
    }
    const rateFixed = scaleTo18(amountOut.value, orderDetails.buyTokenDecimals);
    const price = (rateFixed * ONE18) / maximumInputFixed;

    spanAttributes["amountOut"] = formatUnits(amountOut.value, toToken.decimals);
    spanAttributes["marketPrice"] = formatUnits(price, 18);

    // const routeVisual: string[] = [];
    // try {
    //     visualizeRoute(fromToken, toToken, route.legs).forEach((v) => {
    //         routeVisual.push(v);
    //     });
    // } catch {
    //     /**/
    // }
    // spanAttributes["route"] = routeVisual;

    // exit early if market price is lower than order quote ratio
    if (price < orderDetails.takeOrder.quote!.ratio) {
        spanAttributes["error"] = "Order's ratio greater than market price";
        const result = {
            type: TradeType.RouteProcessor,
            spanAttributes,
            reason: BalancerRouterSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        };
        return Result.err(result);
    }

    spanAttributes["oppBlockNumber"] = Number(blockNumber);

    const balancerRouter = AddressProvider.BatchRouter(this.state.chainConfig.id);
    const orders = [orderDetails.takeOrder.struct];
    const takeOrdersConfigStruct: TakeOrdersConfigType = {
        minimumInput: 1n,
        maximumInput: maxUint256,
        maximumIORatio: this.appOptions.maxRatio ? maxUint256 : price,
        orders,
        data: encodeAbiParameters(
            [{ type: "address" }, ABI.BalancerBatchRouter.Structs.SwapPathExactAmountIn],
            [balancerRouter, route.value],
        ),
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
            abi: ABI.Orderbook.Primary.Arb,
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
        initDryrunResult.error.reason = BalancerRouterSimulationHaltReason.NoOpportunity;
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
            Object.assign(finalDryrunResult.error.spanAttributes, spanAttributes);
            finalDryrunResult.error.reason = BalancerRouterSimulationHaltReason.NoOpportunity;
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

/** Estimates profit for a route processor clear mode */
export function estimateProfit(
    orderDetails: Pair,
    ethPrice: bigint,
    marketPrice: bigint,
    maxInput: bigint,
): bigint {
    const marketAmountOut = (maxInput * marketPrice) / ONE18;
    const orderInput = (maxInput * orderDetails.takeOrder.quote!.ratio) / ONE18;
    const estimatedProfit = marketAmountOut - orderInput;
    return (estimatedProfit * ethPrice) / ONE18;
}
