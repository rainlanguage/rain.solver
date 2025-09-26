import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { errorSnapshot } from "../../../error";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { Result, ABI, RawTransaction } from "../../../common";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { SimulationHaltReason, TradeSimulatorBase } from "../simulator";
import { RainSolverRouterErrorType, RouterType } from "../../../router/types";
import { TradeType, FailedSimulation, TakeOrdersConfigType } from "../../types";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

/** Arguments for simulating router trade */
export type SimulateRouterTradeArgs = {
    /** The type of trade */
    type: TradeType.Router;
    /** The RainSolver instance used for simulation */
    solver: RainSolver;
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

/** Arguments for preparing router trade type parameters required for simulation and building tx object */
export type RouterTradePreparedParams = {
    type: TradeType.Router | TradeType.Balancer | TradeType.RouteProcessor;
    rawtx: RawTransaction;
    price: bigint;
    minimumExpected: bigint;
    takeOrdersConfigStruct: TakeOrdersConfigType;
};

export class RouterTradeSimulator extends TradeSimulatorBase {
    declare tradeArgs: SimulateRouterTradeArgs;

    static withArgs(tradeArgs: SimulateRouterTradeArgs): RouterTradeSimulator {
        return new RouterTradeSimulator(tradeArgs);
    }

    async prepareTradeParams(): Promise<Result<RouterTradePreparedParams, FailedSimulation>> {
        const {
            orderDetails,
            signer,
            toToken,
            fromToken,
            maximumInputFixed,
            blockNumber,
            isPartial,
        } = this.tradeArgs;
        const gasPrice = this.tradeArgs.solver.state.gasPrice;

        const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
        this.spanAttributes["amountIn"] = formatUnits(maximumInputFixed, 18);
        this.spanAttributes["oppBlockNumber"] = Number(blockNumber);

        const tradeParamsResult = await this.tradeArgs.solver.state.router.getTradeParams({
            state: this.tradeArgs.solver.state,
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
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.NoOpportunity,
            };
            if (tradeParamsResult.error.typ === RainSolverRouterErrorType.NoRouteFound) {
                this.spanAttributes["route"] = "no way for sushi and balancer";
                result.reason = SimulationHaltReason.NoRoute;
            } else {
                this.spanAttributes["error"] = tradeParamsResult.error.message;
            }
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err(result);
        }
        const {
            type: routeType,
            quote,
            routeVisual,
            takeOrdersConfigStruct,
        } = tradeParamsResult.value;

        // determine trade type based on router type
        let type = TradeType.Router;
        let arbAddress = this.tradeArgs.solver.appOptions.arbAddress;
        if (routeType === RouterType.Sushi) {
            type = TradeType.RouteProcessor;
        } else if (routeType === RouterType.Balancer) {
            type = TradeType.Balancer;
            arbAddress = this.tradeArgs.solver.appOptions.balancerArbAddress!;
        } else {
            type = TradeType.Router;
        }

        this.spanAttributes["amountOut"] = formatUnits(quote.amountOut, toToken.decimals);
        this.spanAttributes["marketPrice"] = formatUnits(quote.price, 18);
        this.spanAttributes["route"] = routeVisual;

        // exit early if market price is lower than order quote ratio
        if (quote.price < orderDetails.takeOrder.quote!.ratio) {
            this.spanAttributes["error"] = "Order's ratio greater than market price";
            const result = {
                type,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.OrderRatioGreaterThanMarketPrice,
            };
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err(result);
        }

        const rawtx: RawTransaction = {
            to: arbAddress as `0x${string}`,
            gasPrice,
        };
        return Result.ok({
            type,
            rawtx,
            takeOrdersConfigStruct,
            minimumExpected: 0n,
            price: quote.price,
        });
    }

    async setTransactionData(
        params: RouterTradePreparedParams,
    ): Promise<Result<void, FailedSimulation>> {
        // try to get task bytecode for ensure bounty task
        const taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(this.tradeArgs.ethPrice, 18),
                outputToEthPrice: 0n,
                minimumExpected: params.minimumExpected,
                sender: this.tradeArgs.signer.account.address,
            },
            this.tradeArgs.solver.state.client,
            this.tradeArgs.solver.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            this.spanAttributes["isNodeError"] =
                taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
            this.spanAttributes["error"] = errMsg;
            const result = {
                type: params.type,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
            };
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err(result);
        }
        const task = {
            evaluable: {
                interpreter: this.tradeArgs.solver.state.dispair.interpreter as `0x${string}`,
                store: this.tradeArgs.solver.state.dispair.store as `0x${string}`,
                bytecode:
                    this.tradeArgs.solver.appOptions.gasCoveragePercentage === "0"
                        ? "0x"
                        : taskBytecodeResult.value,
            },
            signedContext: [],
        };
        params.rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Arb,
            functionName: "arb3",
            args: [
                this.tradeArgs.orderDetails.orderbook as `0x${string}`,
                params.takeOrdersConfigStruct,
                task,
            ],
        });
        return Result.ok(void 0);
    }

    estimateProfit(marketPrice: bigint): bigint {
        const marketAmountOut = (this.tradeArgs.maximumInputFixed * marketPrice) / ONE18;
        const orderInput =
            (this.tradeArgs.maximumInputFixed *
                this.tradeArgs.orderDetails.takeOrder.quote!.ratio) /
            ONE18;
        const estimatedProfit = marketAmountOut - orderInput;
        return (estimatedProfit * parseUnits(this.tradeArgs.ethPrice, 18)) / ONE18;
    }
}
