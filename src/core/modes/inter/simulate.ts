import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { errorSnapshot } from "../../../error";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { Result, ABI, RawTransaction } from "../../../common";
import { SimulationHaltReason, TradeSimulatorBase } from "../simulator";
import { TradeType, FailedSimulation, TakeOrdersConfigType } from "../../types";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

/** Arguments for simulating inter-orderbook trade */
export type SimulateInterOrderbookTradeArgs = {
    /** The type of trade */
    type: TradeType.InterOrderbook;
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: Pair;
    /** The counterparty order to trade against */
    counterpartyOrderDetails: Pair;
    /** The RainSolverSigner instance used for signing transactions */
    signer: RainSolverSigner;
    /** The input token to ETH price (in 18 decimals) */
    inputToEthPrice: string;
    /** The output token to ETH price (in 18 decimals) */
    outputToEthPrice: string;
    /** The maximum input amount (in 18 decimals) */
    maximumInputFixed: bigint;
    /** The current block number for context */
    blockNumber: bigint;
};

/** Arguments for preparing router trade type parameters required for simulation and building tx object */
export type InterOrderbookTradePreparedParams = {
    type: TradeType.InterOrderbook;
    rawtx: RawTransaction;
    takeOrdersConfigStruct: TakeOrdersConfigType;
    minimumExpected: bigint;
    price?: bigint;
};

export class InterOrderbookTradeSimulator extends TradeSimulatorBase {
    declare tradeArgs: SimulateInterOrderbookTradeArgs;

    static withArgs(
        solver: RainSolver,
        tradeArgs: SimulateInterOrderbookTradeArgs,
    ): InterOrderbookTradeSimulator {
        return new InterOrderbookTradeSimulator(solver, tradeArgs);
    }

    async prepareTradeParams(): Promise<
        Result<InterOrderbookTradePreparedParams, FailedSimulation>
    > {
        const {
            orderDetails,
            counterpartyOrderDetails,
            maximumInputFixed,
            blockNumber,
            inputToEthPrice,
            outputToEthPrice,
        } = this.tradeArgs;
        const gasPrice = this.solver.state.gasPrice;

        this.spanAttributes["against"] = counterpartyOrderDetails.takeOrder.id;
        this.spanAttributes["inputToEthPrice"] = inputToEthPrice;
        this.spanAttributes["outputToEthPrice"] = outputToEthPrice;
        this.spanAttributes["oppBlockNumber"] = Number(blockNumber);
        this.spanAttributes["counterpartyOrderQuote"] = JSON.stringify({
            maxOutput: formatUnits(counterpartyOrderDetails.takeOrder.quote!.maxOutput, 18),
            ratio: formatUnits(counterpartyOrderDetails.takeOrder.quote!.ratio, 18),
        });

        const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
        this.spanAttributes["maxInput"] = maximumInput.toString();

        const opposingMaxInput =
            orderDetails.takeOrder.quote!.ratio === 0n
                ? maxUint256
                : scaleFrom18(
                      (maximumInputFixed * orderDetails.takeOrder.quote!.ratio) / ONE18,
                      orderDetails.buyTokenDecimals,
                  );

        const opposingMaxIORatio =
            orderDetails.takeOrder.quote!.ratio === 0n
                ? maxUint256
                : ONE18 ** 2n / orderDetails.takeOrder.quote!.ratio;

        // encode takeOrders2() and build tx fields
        const encodedFN = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "takeOrders2",
            args: [
                {
                    minimumInput: 1n,
                    maximumInput: opposingMaxInput, // main maxout * main ratio
                    maximumIORatio: opposingMaxIORatio, // inverse of main ratio (1 / ratio)
                    orders: [counterpartyOrderDetails.takeOrder.struct], // opposing orders
                    data: "0x",
                },
            ],
        });
        const takeOrdersConfigStruct: TakeOrdersConfigType = {
            minimumInput: 1n,
            maximumInput: maxUint256,
            maximumIORatio: maxUint256,
            orders: [orderDetails.takeOrder.struct],
            data: encodeAbiParameters(
                [{ type: "address" }, { type: "address" }, { type: "bytes" }],
                [
                    counterpartyOrderDetails.orderbook as `0x${string}`,
                    counterpartyOrderDetails.orderbook as `0x${string}`,
                    encodedFN,
                ],
            ),
        };

        const rawtx: RawTransaction = {
            to: this.solver.appOptions.genericArbAddress as `0x${string}`,
            gasPrice,
        };
        return Result.ok({
            type: TradeType.InterOrderbook,
            rawtx,
            takeOrdersConfigStruct,
            minimumExpected: 0n,
        });
    }

    async setTransactionData(
        params: InterOrderbookTradePreparedParams,
    ): Promise<Result<void, FailedSimulation>> {
        // try to get task bytecode for ensure bounty task
        const taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(this.tradeArgs.inputToEthPrice, 18),
                outputToEthPrice: parseUnits(this.tradeArgs.outputToEthPrice, 18),
                minimumExpected: params.minimumExpected,
                sender: this.tradeArgs.signer.account.address,
            },
            this.solver.state.client,
            this.solver.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            this.spanAttributes["isNodeError"] =
                taskBytecodeResult.error.type === EnsureBountyTaskErrorType.ParseError;
            this.spanAttributes["error"] = errMsg;
            const result = {
                type: TradeType.InterOrderbook,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.FailedToGetTaskBytecode,
            };
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err(result);
        }
        const task = {
            evaluable: {
                interpreter: this.solver.state.dispair.interpreter as `0x${string}`,
                store: this.solver.state.dispair.store as `0x${string}`,
                bytecode:
                    this.solver.appOptions.gasCoveragePercentage === "0"
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

    estimateProfit(): bigint {
        const orderOutput = this.tradeArgs.maximumInputFixed;
        const orderInput =
            (this.tradeArgs.maximumInputFixed *
                this.tradeArgs.orderDetails.takeOrder.quote!.ratio) /
            ONE18;

        let opposingMaxInput =
            this.tradeArgs.orderDetails.takeOrder.quote!.ratio === 0n
                ? maxUint256
                : (this.tradeArgs.maximumInputFixed *
                      this.tradeArgs.orderDetails.takeOrder.quote!.ratio) /
                  ONE18;
        const opposingMaxIORatio =
            this.tradeArgs.orderDetails.takeOrder.quote!.ratio === 0n
                ? maxUint256
                : ONE18 ** 2n / this.tradeArgs.orderDetails.takeOrder.quote!.ratio;

        let counterpartyInput = 0n;
        let counterpartyOutput = 0n;
        const quote = this.tradeArgs.counterpartyOrderDetails.takeOrder.quote!;
        if (opposingMaxIORatio >= quote.ratio) {
            const maxOut = opposingMaxInput < quote.maxOutput ? opposingMaxInput : quote.maxOutput;
            counterpartyOutput += maxOut;
            counterpartyInput += (maxOut * quote.ratio) / ONE18;
            opposingMaxInput -= maxOut;
        }
        const outputProfit =
            ((orderOutput - counterpartyInput) * parseUnits(this.tradeArgs.outputToEthPrice, 18)) /
            ONE18;
        const inputProfit =
            ((counterpartyOutput - orderInput) * parseUnits(this.tradeArgs.inputToEthPrice, 18)) /
            ONE18;
        return outputProfit + inputProfit;
    }
}
