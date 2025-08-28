import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { estimateProfit } from "../rp/utils";
import { Attributes } from "@opentelemetry/api";
import { Result, ABI, toFloat } from "../../../common";
import { extendObjectWithHeader } from "../../../logger";
import { maxFloat, minFloat, scaleFrom18 } from "../../../math";
import { RainSolverSigner, RawTransaction } from "../../../signer";
import { getBountyEnsureRainlang, parseRainlang } from "../../../task";
import { BalancerRouter, BalancerRouterErrorType } from "../../../router/balancer";
import { encodeAbiParameters, encodeFunctionData, formatUnits, parseUnits } from "viem";
import { TakeOrdersConfigType, SimulationResult, TradeType, FailedSimulation } from "../../types";

/** Specifies the reason that balancer trade simulation failed */
export enum BalancerRouterSimulationHaltReason {
    NoOpportunity = 1,
    NoRoute = 2,
    OrderRatioGreaterThanMarketPrice = 3,
    FetchFailed = 4,
    SwapQueryFailed = 5,
}

/** Arguments for simulating balancer protocol trade */
export type SimulateBalancerTradeArgs = {
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
 * Attempts to find a profitable opportunity (opp) for a given order by simulating a trade against balancer protocol.
 * @param this - The RainSolver instance context
 * @param args - The arguments for simulating the trade
 */
export async function trySimulateTrade(
    this: RainSolver,
    args: SimulateBalancerTradeArgs,
): Promise<SimulationResult> {
    const { orderDetails, signer, ethPrice, toToken, fromToken, maximumInputFixed, blockNumber } =
        args;
    const gasPrice = this.state.gasPrice;
    const spanAttributes: Attributes = {};

    const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
    spanAttributes["amountIn"] = formatUnits(maximumInputFixed, 18);

    const quoteResult = await this.state.balancerRouter!.tryQuote(
        {
            tokenIn: fromToken,
            tokenOut: toToken,
            swapAmount: maximumInput,
        },
        signer,
    );
    if (quoteResult.isErr()) {
        spanAttributes["error"] = quoteResult.error.message;

        let reason = BalancerRouterSimulationHaltReason.NoOpportunity;
        if (quoteResult.error.type === BalancerRouterErrorType.NoRouteFound) {
            spanAttributes["route"] = "no-way";
            reason = BalancerRouterSimulationHaltReason.NoRoute;
        } else if (quoteResult.error.type === BalancerRouterErrorType.FetchFailed) {
            reason = BalancerRouterSimulationHaltReason.FetchFailed;
        } else if (quoteResult.error.type === BalancerRouterErrorType.SwapQueryFailed) {
            reason = BalancerRouterSimulationHaltReason.SwapQueryFailed;
        } else {
            reason = BalancerRouterSimulationHaltReason.NoOpportunity;
        }

        return Result.err({
            type: TradeType.Balancer,
            spanAttributes,
            reason,
        });
    }

    const quote = quoteResult.value;
    const amountOut = quote.amountOut;
    const price = quote.price;

    spanAttributes["amountOut"] = formatUnits(amountOut, toToken.decimals);
    spanAttributes["marketPrice"] = formatUnits(price, 18);

    const routeVisual: string[] = [];
    try {
        BalancerRouter.visualizeRoute(quote.route, this.state.watchedTokens).forEach((v) => {
            routeVisual.push(v);
        });
    } catch {
        /**/
    }
    spanAttributes["route"] = routeVisual;

    // exit early if market price is lower than order quote ratio
    if (price < orderDetails.takeOrder.quote!.ratio) {
        spanAttributes["error"] = "Order's ratio greater than market price";
        const result = {
            type: TradeType.Balancer,
            spanAttributes,
            reason: BalancerRouterSimulationHaltReason.OrderRatioGreaterThanMarketPrice,
        };
        return Result.err(result);
    }

    spanAttributes["oppBlockNumber"] = Number(blockNumber);

    const maximumInputFloat: `0x${string}` = maxFloat(orderDetails.sellTokenDecimals);
    let maximumIORatioFloat: `0x${string}` = maxFloat(18);
    if (!this.appOptions.maxRatio) {
        const valueResult = toFloat(price, 18);
        if (valueResult.isErr()) {
            spanAttributes["error"] = valueResult.error.readableMsg;
            const result: FailedSimulation = {
                spanAttributes,
                type: TradeType.RouteProcessor,
                noneNodeError: valueResult.error.readableMsg,
            };
            return Result.err(result);
        }
        maximumIORatioFloat = valueResult.value;
    }

    const balancerRouter = this.state.balancerRouter!.routerAddress;
    const orders = [orderDetails.takeOrder.struct];
    const takeOrdersConfigStruct: TakeOrdersConfigType = {
        minimumInput: minFloat(orderDetails.sellTokenDecimals),
        maximumInput: maximumInputFloat,
        maximumIORatio: maximumIORatioFloat,
        orders,
        data: encodeAbiParameters(
            [{ type: "address" }, ABI.BalancerBatchRouter.Structs.SwapPathExactAmountIn],
            [balancerRouter, quote.route[0]],
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
            functionName: "arb4",
            args: [orderDetails.orderbook as `0x${string}`, takeOrdersConfigStruct, task],
        }),
        to: this.appOptions.balancerArbAddress as `0x${string}`,
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
        (initDryrunResult.error as FailedSimulation).type = TradeType.Balancer;
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
            functionName: "arb4",
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
            (finalDryrunResult.error as FailedSimulation).type = TradeType.Balancer;
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
            functionName: "arb4",
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
        type: TradeType.Balancer,
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
