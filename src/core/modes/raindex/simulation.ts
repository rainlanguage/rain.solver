import { RPParams } from "sushi";
import { RouteLegType } from ".";
import { RainSolver } from "../..";
import { scaleFrom18 } from "../../../math";
import { errorSnapshot } from "../../../error";
import { RainSolverSigner } from "../../../signer";
import { SushiRouterQuote } from "../../../router";
import { PairV4, TakeOrdersConfigTypeV5 } from "../../../order";
import { TradeType, FailedSimulation, TaskType } from "../../types";
import { SimulationHaltReason, TradeSimulatorBase } from "../simulator";
import { encodeAbiParameters, encodeFunctionData, formatUnits } from "viem";
import { Result, ABI, RawTransaction, maxFloat, minFloat } from "../../../common";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

/** Arguments for simulating inter-orderbook trade */
export type SimulateRaindexRouterTradeArgs = {
    /** The type of trade */
    type: TradeType.Raindex;
    /** The RainSolver instance used for simulation */
    solver: RainSolver;
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: PairV4;
    /** The counterparty order to trade against */
    counterpartyOrderDetails: PairV4;
    /** The RainSolverSigner instance used for signing transactions */
    signer: RainSolverSigner;
    /** The maximum input amount (in 18 decimals) */
    maximumInputFixed: bigint;
    /** The current block number for context */
    blockNumber: bigint;
    /** The counterparty input token to ETH price (in 18 decimals) */
    counterpartyInputToEthPrice: bigint;
    /** The counterparty output token to ETH price (in 18 decimals) */
    counterpartyOutputToEthPrice: bigint;
    /** Sushi RP quote for route leg swap */
    quote: SushiRouterQuote;
    /** Estimated profit */
    profit: bigint;
    /** Prebuilt Sushi RP params that include the routecode needed for the intermediate swap as exchange data */
    rpParams: RPParams;
    /** Sushi RP route visualization */
    routeVisual: string[];
};

/** Arguments for preparing router trade type parameters required for simulation and building tx object */
export type RaindexRouterTradePreparedParams = {
    type: TradeType.Raindex;
    rawtx: RawTransaction;
    takeOrders: TakeOrdersConfigTypeV5[];
    minimumExpected: bigint;
    exchangeData: `0x${string}`;
    price?: bigint;
};

/**
 * Simulates a trade between 2 orders wwith different IO through a external route
 *
 * The `RaindexRouterTradeSimulator` class extends {@link TradeSimulatorBase} and is responsible for:
 * - Simulating trades between two order with external route such as A/B (order) -> B/C (external) -> C/A (order)
 * - Preparing and encoding the transaction data required to execute the trade on-chain.
 * - Estimating the profit from the simulated trade based on input/output prices and order quotes.
 * - Managing simulation state, error handling, and span attributes for tracing and observability.
 */
export class RaindexRouterTradeSimulator extends TradeSimulatorBase {
    declare tradeArgs: SimulateRaindexRouterTradeArgs;

    static withArgs(tradeArgs: SimulateRaindexRouterTradeArgs): RaindexRouterTradeSimulator {
        return new RaindexRouterTradeSimulator(tradeArgs);
    }

    async prepareTradeParams(): Promise<
        Result<RaindexRouterTradePreparedParams, FailedSimulation>
    > {
        const {
            orderDetails,
            counterpartyOrderDetails,
            maximumInputFixed,
            blockNumber,
            // type,
            // solver,
            // signer,
            counterpartyInputToEthPrice,
            counterpartyOutputToEthPrice,
            quote,
            // profit,
            rpParams,
            routeVisual,
        } = this.tradeArgs;
        const gasPrice = this.tradeArgs.solver.state.gasPrice;

        this.spanAttributes["against"] = counterpartyOrderDetails.takeOrder.id;
        this.spanAttributes["counterpartyInputToEthPrice"] = formatUnits(
            counterpartyInputToEthPrice,
            18,
        );
        this.spanAttributes["counterpartyOutputToEthPrice"] = formatUnits(
            counterpartyOutputToEthPrice,
            18,
        );
        this.spanAttributes["route"] = routeVisual;
        this.spanAttributes["routeQuote"] = formatUnits(quote.price, 18);
        this.spanAttributes["oppBlockNumber"] = Number(blockNumber);
        this.spanAttributes["counterpartyPair"] =
            `${counterpartyOrderDetails.buyTokenSymbol}/${counterpartyOrderDetails.sellTokenSymbol}`;
        this.spanAttributes["counterpartyOrderQuote"] = JSON.stringify({
            maxOutput: formatUnits(counterpartyOrderDetails.takeOrder.quote!.maxOutput, 18),
            ratio: formatUnits(counterpartyOrderDetails.takeOrder.quote!.ratio, 18),
        });

        const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
        this.spanAttributes["maxInput"] = maximumInput.toString();

        // exit early if required trade addresses are not configured
        const addresses = this.tradeArgs.solver.state.contracts.getAddressesForTrade(
            orderDetails,
            TradeType.Raindex,
        );
        if (!addresses) {
            this.spanAttributes["error"] =
                `Cannot trade as generic arb address is not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err({
                type: TradeType.Raindex,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
            });
        }

        // Single RouteLeg
        const legs = [
            {
                routeLegType: RouteLegType.SUSHI,
                destination: addresses.destination as `0x${string}`,
                data: rpParams.routeCode,
            },
        ];
        const exchangeData = encodeAbiParameters(ABI.Orderbook.V6.Primary.RouteLeg, [legs]);
        const takeOrders: TakeOrdersConfigTypeV5[] = [
            {
                minimumIO: minFloat(this.tradeArgs.orderDetails.sellTokenDecimals),
                maximumIO: maxFloat(this.tradeArgs.orderDetails.sellTokenDecimals),
                maximumIORatio: maxFloat(18),
                orders: [this.tradeArgs.orderDetails.takeOrder.struct],
                data: "0x",
                IOIsInput: false,
            },
            {
                minimumIO: minFloat(this.tradeArgs.orderDetails.buyTokenDecimals),
                maximumIO: maxFloat(this.tradeArgs.orderDetails.buyTokenDecimals),
                maximumIORatio: maxFloat(18),
                orders: [this.tradeArgs.counterpartyOrderDetails.takeOrder.struct],
                data: "0x",
                IOIsInput: false,
            },
        ];

        const rawtx: RawTransaction = {
            to: addresses.destination,
            gasPrice,
        };
        return Result.ok({
            type: TradeType.Raindex,
            rawtx,
            takeOrders,
            exchangeData,
            minimumExpected: 0n,
        });
    }

    async setTransactionData(
        params: RaindexRouterTradePreparedParams,
    ): Promise<Result<void, FailedSimulation>> {
        // we can be sure the addresses exist here since we checked in prepareTradeParams
        const addresses = this.tradeArgs.solver.state.contracts.getAddressesForTrade(
            this.tradeArgs.orderDetails,
            params.type,
        )!;

        // try to get task bytecode for ensure bounty task
        const taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: this.tradeArgs.counterpartyInputToEthPrice,
                outputToEthPrice: this.tradeArgs.counterpartyOutputToEthPrice,
                minimumExpected: params.minimumExpected,
                sender: this.tradeArgs.signer.account.address,
            },
            this.tradeArgs.solver.state.client,
            addresses.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            this.spanAttributes["isNodeError"] =
                taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
            this.spanAttributes["error"] = errMsg;
            const result = {
                type: TradeType.Raindex,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
            };
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err(result);
        }
        const task = {
            evaluable: {
                interpreter: addresses.dispair.interpreter as `0x${string}`,
                store: addresses.dispair.store as `0x${string}`,
                bytecode:
                    this.tradeArgs.solver.appOptions.gasCoveragePercentage === "0"
                        ? "0x"
                        : taskBytecodeResult.value,
            },
            signedContext: [],
        };

        params.rawtx.data = this.getCalldata(params.takeOrders, params.exchangeData, task);
        return Result.ok(void 0);
    }

    estimateProfit(): bigint {
        return this.tradeArgs.profit;
    }

    /**
     * Builds the calldata
     * @param takeOrdersConfigStruct - The take orders config structs
     * @param exchangeData
     * @param task - The ensure bounty task object
     */
    getCalldata(
        takeOrders: TakeOrdersConfigTypeV5[],
        exchangeData: `0x${string}`,
        task: TaskType,
    ): `0x${string}` {
        return encodeFunctionData({
            abi: ABI.Orderbook.V6.Primary.Arb,
            functionName: "arb4",
            args: [
                this.tradeArgs.orderDetails.orderbook as `0x${string}`,
                takeOrders,
                exchangeData,
                task,
            ],
        });
    }
}
