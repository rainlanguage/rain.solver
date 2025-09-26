import { RainSolver } from "../..";
import { ONE18 } from "../../../math";
import { errorSnapshot } from "../../../error";
import { RainSolverSigner } from "../../../signer";
import { Pair, TakeOrderDetails } from "../../../order";
import { TradeType, FailedSimulation } from "../../types";
import { Result, ABI, RawTransaction } from "../../../common";
import { SimulationHaltReason, TradeSimulatorBase } from "../simulator";
import { encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";

/** Arguments for simulating inter-orderbook trade */
export type SimulateIntraOrderbookTradeArgs = {
    /** The type of trade */
    type: TradeType.IntraOrderbook;
    /** The RainSolver instance used for simulation */
    solver: RainSolver;
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: Pair;
    /** The counterparty order to trade against */
    counterpartyOrderDetails: TakeOrderDetails;
    /** The RainSolverSigner instance used for signing transactions */
    signer: RainSolverSigner;
    /** The input token to ETH price (in 18 decimals) */
    inputToEthPrice: string;
    /** The output token to ETH price (in 18 decimals) */
    outputToEthPrice: string;
    /** The current input token balance of signer (in 18 decimals) */
    inputBalance: bigint;
    /** The current output token balance of signer (in 18 decimals) */
    outputBalance: bigint;
    /** The current block number for context */
    blockNumber: bigint;
};

/** Arguments for preparing router trade type parameters required for simulation and building tx object */
export type IntraOrderbookTradePrepareedParams = {
    type: TradeType.IntraOrderbook;
    rawtx: RawTransaction;
    minimumExpected: bigint;
    price?: bigint;
};

export class IntraOrderbookTradeSimulator extends TradeSimulatorBase {
    declare tradeArgs: SimulateIntraOrderbookTradeArgs;
    readonly inputBountyVaultId = 1n;
    readonly outputBountyVaultId = 1n;

    static withArgs(tradeArgs: SimulateIntraOrderbookTradeArgs): IntraOrderbookTradeSimulator {
        return new IntraOrderbookTradeSimulator(tradeArgs);
    }

    async prepareTradeParams(): Promise<
        Result<IntraOrderbookTradePrepareedParams, FailedSimulation>
    > {
        const {
            orderDetails,
            counterpartyOrderDetails,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        } = this.tradeArgs;
        const gasPrice = this.tradeArgs.solver.state.gasPrice;

        this.spanAttributes["against"] = counterpartyOrderDetails.id;
        this.spanAttributes["inputToEthPrice"] = inputToEthPrice;
        this.spanAttributes["outputToEthPrice"] = outputToEthPrice;
        this.spanAttributes["oppBlockNumber"] = Number(blockNumber);
        this.spanAttributes["counterpartyOrderQuote"] = JSON.stringify({
            maxOutput: formatUnits(counterpartyOrderDetails.quote!.maxOutput, 18),
            ratio: formatUnits(counterpartyOrderDetails.quote!.ratio, 18),
        });

        const rawtx: RawTransaction = {
            to: orderDetails.orderbook as `0x${string}`,
            gasPrice,
        };
        return Result.ok({
            type: TradeType.IntraOrderbook,
            rawtx,
            minimumExpected: 0n,
        });
    }

    async setTransactionData(
        params: IntraOrderbookTradePrepareedParams,
    ): Promise<Result<void, FailedSimulation>> {
        // build clear function call data and withdraw tasks
        const taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.Internal,
                botAddress: this.tradeArgs.signer.account.address,
                inputToken: this.tradeArgs.orderDetails.buyToken,
                outputToken: this.tradeArgs.orderDetails.sellToken,
                orgInputBalance: this.tradeArgs.inputBalance,
                orgOutputBalance: this.tradeArgs.outputBalance,
                inputToEthPrice: parseUnits(this.tradeArgs.inputToEthPrice, 18),
                outputToEthPrice: parseUnits(this.tradeArgs.outputToEthPrice, 18),
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
                type: TradeType.IntraOrderbook,
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
                bytecode: taskBytecodeResult.value,
            },
            signedContext: [],
        };
        const withdrawInputCalldata = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "withdraw2",
            args: [this.tradeArgs.orderDetails.buyToken, this.inputBountyVaultId, maxUint256, []],
        });
        const withdrawOutputCalldata = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "withdraw2",
            args: [
                this.tradeArgs.orderDetails.sellToken,
                this.outputBountyVaultId,
                maxUint256,
                this.tradeArgs.solver.appOptions.gasCoveragePercentage === "0" ? [] : [task],
            ],
        });
        const clear2Calldata = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "clear2",
            args: [
                this.tradeArgs.orderDetails.takeOrder.struct.order,
                this.tradeArgs.counterpartyOrderDetails.struct.order,
                {
                    aliceInputIOIndex: BigInt(
                        this.tradeArgs.orderDetails.takeOrder.struct.inputIOIndex,
                    ),
                    aliceOutputIOIndex: BigInt(
                        this.tradeArgs.orderDetails.takeOrder.struct.outputIOIndex,
                    ),
                    bobInputIOIndex: BigInt(
                        this.tradeArgs.counterpartyOrderDetails.struct.inputIOIndex,
                    ),
                    bobOutputIOIndex: BigInt(
                        this.tradeArgs.counterpartyOrderDetails.struct.outputIOIndex,
                    ),
                    aliceBountyVaultId: this.inputBountyVaultId,
                    bobBountyVaultId: this.outputBountyVaultId,
                },
                [],
                [],
            ],
        });
        params.rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "multicall",
            args: [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]],
        });
        return Result.ok(void 0);
    }

    estimateProfit(): bigint {
        const orderMaxInput =
            (this.tradeArgs.orderDetails.takeOrder.quote!.maxOutput *
                this.tradeArgs.orderDetails.takeOrder.quote!.ratio) /
            ONE18;
        const opposingMaxInput =
            (this.tradeArgs.counterpartyOrderDetails.quote!.maxOutput *
                this.tradeArgs.counterpartyOrderDetails.quote!.ratio) /
            ONE18;

        const orderOutput =
            this.tradeArgs.counterpartyOrderDetails.quote!.ratio === 0n
                ? this.tradeArgs.orderDetails.takeOrder.quote!.maxOutput
                : this.tradeArgs.orderDetails.takeOrder.quote!.maxOutput <= opposingMaxInput
                  ? this.tradeArgs.orderDetails.takeOrder.quote!.maxOutput
                  : opposingMaxInput;
        const orderInput =
            (orderOutput * this.tradeArgs.orderDetails.takeOrder.quote!.ratio) / ONE18;

        const opposingOutput =
            this.tradeArgs.counterpartyOrderDetails.quote!.ratio === 0n
                ? this.tradeArgs.counterpartyOrderDetails.quote!.maxOutput
                : orderMaxInput <= this.tradeArgs.counterpartyOrderDetails.quote!.maxOutput
                  ? orderMaxInput
                  : this.tradeArgs.counterpartyOrderDetails.quote!.maxOutput;
        const opposingInput =
            (opposingOutput * this.tradeArgs.counterpartyOrderDetails.quote!.ratio) / ONE18;

        let outputProfit = orderOutput - opposingInput;
        if (outputProfit < 0n) outputProfit = 0n;
        outputProfit = (outputProfit * parseUnits(this.tradeArgs.outputToEthPrice, 18)) / ONE18;

        let inputProfit = opposingOutput - orderInput;
        if (inputProfit < 0n) inputProfit = 0n;
        inputProfit = (inputProfit * parseUnits(this.tradeArgs.inputToEthPrice, 18)) / ONE18;

        return outputProfit + inputProfit;
    }
}
