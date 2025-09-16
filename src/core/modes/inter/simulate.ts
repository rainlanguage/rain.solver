import { RainSolver } from "../..";
import { dryrun } from "../dryrun";
import { Pair } from "../../../order";
import { estimateProfit } from "./utils";
import { errorSnapshot } from "../../../error";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { ONE18, scaleFrom18 } from "../../../math";
import { extendObjectWithHeader } from "../../../logger";
import { ABI, Result, RawTransaction } from "../../../common";
import { EnsureBountyTaskType, getEnsureBountyTaskBytecode } from "../../../task";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import {
    TaskType,
    TradeType,
    FailedSimulation,
    SimulationResult,
    TakeOrdersConfigType,
} from "../../types";

/** Arguments for simulating inter-orderbook trade */
export type SimulateInterOrderbookTradeArgs = {
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

/**
 * Attempts to simulate a inter-orderbook trade against the given counterparty order
 * @param this - The RainSolver instance context
 * @param args - The arguments for simulating the trade
 */
export async function trySimulateTrade(
    this: RainSolver,
    args: SimulateInterOrderbookTradeArgs,
): Promise<SimulationResult> {
    const {
        orderDetails,
        counterpartyOrderDetails,
        signer,
        maximumInputFixed,
        blockNumber,
        inputToEthPrice,
        outputToEthPrice,
    } = args;
    const spanAttributes: Attributes = {};
    const gasPrice = this.state.gasPrice;

    spanAttributes["against"] = counterpartyOrderDetails.takeOrder.id;
    spanAttributes["inputToEthPrice"] = inputToEthPrice;
    spanAttributes["outputToEthPrice"] = outputToEthPrice;
    spanAttributes["counterpartyOrderQuote"] = JSON.stringify({
        maxOutput: formatUnits(counterpartyOrderDetails.takeOrder.quote!.maxOutput, 18),
        ratio: formatUnits(counterpartyOrderDetails.takeOrder.quote!.ratio, 18),
    });

    const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);
    spanAttributes["maxInput"] = maximumInput.toString();

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

    // try to get task bytecode for ensure bounty task
    const taskBytecodeResult = await getEnsureBountyTaskBytecode(
        {
            type: EnsureBountyTaskType.External,
            inputToEthPrice: parseUnits(inputToEthPrice, 18),
            outputToEthPrice: parseUnits(outputToEthPrice, 18),
            minimumExpected: 0n,
            sender: signer.account.address,
        },
        this.state.client,
        this.state.dispair,
    );
    if (taskBytecodeResult.isErr()) {
        const errMsg = await errorSnapshot("", taskBytecodeResult.error);
        spanAttributes["isNodeError"] = true;
        spanAttributes["error"] = errMsg;
        const result = {
            type: TradeType.InterOrderbook,
            spanAttributes,
        };
        return Result.err(result);
    }
    const task: TaskType = {
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
        to: this.appOptions.genericArbAddress as `0x${string}`,
        gasPrice,
    };

    // initial dryrun with 0 minimum sender output to get initial
    // pass and tx gas cost to calc minimum sender output
    spanAttributes["oppBlockNumber"] = Number(blockNumber);
    const initDryrunResult = await dryrun(
        signer,
        rawtx,
        gasPrice,
        this.appOptions.gasLimitMultiplier,
    );
    if (initDryrunResult.isErr()) {
        spanAttributes["stage"] = 1;
        Object.assign(initDryrunResult.error.spanAttributes, spanAttributes);
        (initDryrunResult.error as FailedSimulation).type = TradeType.InterOrderbook;
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

    // repeat the same process with heaedroom if gas
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
                inputToEthPrice: parseUnits(inputToEthPrice, 18),
                outputToEthPrice: parseUnits(outputToEthPrice, 18),
                minimumExpected: (estimatedGasCost * headroom) / 100n,
                sender: signer.account.address,
            },
            this.state.client,
            this.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            spanAttributes["isNodeError"] = true;
            spanAttributes["error"] = errMsg;
            const result = {
                type: TradeType.InterOrderbook,
                spanAttributes,
            };
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
            Object.assign(finalDryrunResult.error.spanAttributes, spanAttributes);
            (finalDryrunResult.error as FailedSimulation).type = TradeType.InterOrderbook;
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

        taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(inputToEthPrice, 18),
                outputToEthPrice: parseUnits(outputToEthPrice, 18),
                minimumExpected:
                    (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) / 100n,
                sender: signer.account.address,
            },
            this.state.client,
            this.state.dispair,
        );
        if (taskBytecodeResult.isErr()) {
            const errMsg = await errorSnapshot("", taskBytecodeResult.error);
            spanAttributes["isNodeError"] = true;
            spanAttributes["error"] = errMsg;
            const result = {
                type: TradeType.InterOrderbook,
                spanAttributes,
            };
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
        type: TradeType.InterOrderbook,
        spanAttributes,
        rawtx,
        estimatedGasCost,
        oppBlockNumber: Number(blockNumber),
        estimatedProfit: estimateProfit(
            orderDetails,
            parseUnits(inputToEthPrice, 18),
            parseUnits(outputToEthPrice, 18),
            counterpartyOrderDetails,
            maximumInputFixed,
        )!,
    };
    return Result.ok(result);
}
