import { RainSolver } from "../..";
import { dryrun } from "../dryrun";
import { estimateProfit } from "./utils";
import { ABI, Result } from "../../../common";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { extendObjectWithHeader } from "../../../logger";
import { Pair, TakeOrderDetails } from "../../../order";
import { getWithdrawEnsureRainlang, parseRainlang } from "../../../task";
import { encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import { FailedSimulation, SimulationResult, TaskType, TradeType } from "../../types";

/** Arguments for simulating inter-orderbook trade */
export type SimulateIntraOrderbookTradeArgs = {
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

/**
 * Attempts to simulate a intra-orderbook trade against the given counterparty order
 * @param this - The RainSolver instance context
 * @param args - The arguments for simulating the trade
 */
export async function trySimulateTrade(
    this: RainSolver,
    args: SimulateIntraOrderbookTradeArgs,
): Promise<SimulationResult> {
    const {
        orderDetails,
        counterpartyOrderDetails,
        signer,
        inputToEthPrice,
        outputToEthPrice,
        inputBalance,
        outputBalance,
        blockNumber,
    } = args;
    const gasPrice = this.state.gasPrice;
    const spanAttributes: Attributes = {};
    const inputBountyVaultId = 1n;
    const outputBountyVaultId = 1n;

    spanAttributes["against"] = counterpartyOrderDetails.id;
    spanAttributes["inputToEthPrice"] = inputToEthPrice;
    spanAttributes["outputToEthPrice"] = outputToEthPrice;
    spanAttributes["counterpartyOrderQuote"] = JSON.stringify({
        maxOutput: formatUnits(counterpartyOrderDetails.quote!.maxOutput, 18),
        ratio: formatUnits(counterpartyOrderDetails.quote!.ratio, 18),
    });

    // build clear2 function call data and withdraw tasks
    const task: TaskType = {
        evaluable: {
            interpreter: this.state.dispair.interpreter as `0x${string}`,
            store: this.state.dispair.store as `0x${string}`,
            bytecode: (await parseRainlang(
                await getWithdrawEnsureRainlang(
                    signer.account.address,
                    orderDetails.buyToken,
                    orderDetails.sellToken,
                    inputBalance,
                    outputBalance,
                    parseUnits(inputToEthPrice, 18),
                    parseUnits(outputToEthPrice, 18),
                    0n,
                    signer.account.address,
                ),
                this.state.client,
                this.state.dispair,
            )) as `0x${string}`,
        },
        signedContext: [],
    };
    const withdrawInputCalldata = encodeFunctionData({
        abi: ABI.Orderbook.Primary.Orderbook,
        functionName: "withdraw2",
        args: [orderDetails.buyToken, inputBountyVaultId, maxUint256, []],
    });
    let withdrawOutputCalldata = encodeFunctionData({
        abi: ABI.Orderbook.Primary.Orderbook,
        functionName: "withdraw2",
        args: [
            orderDetails.sellToken,
            outputBountyVaultId,
            maxUint256,
            this.appOptions.gasCoveragePercentage === "0" ? [] : [task],
        ],
    });
    const clear2Calldata = encodeFunctionData({
        abi: ABI.Orderbook.Primary.Orderbook,
        functionName: "clear2",
        args: [
            orderDetails.takeOrder.struct.order,
            counterpartyOrderDetails.struct.order,
            {
                aliceInputIOIndex: BigInt(orderDetails.takeOrder.struct.inputIOIndex),
                aliceOutputIOIndex: BigInt(orderDetails.takeOrder.struct.outputIOIndex),
                bobInputIOIndex: BigInt(counterpartyOrderDetails.struct.inputIOIndex),
                bobOutputIOIndex: BigInt(counterpartyOrderDetails.struct.outputIOIndex),
                aliceBountyVaultId: inputBountyVaultId,
                bobBountyVaultId: outputBountyVaultId,
            },
            [],
            [],
        ],
    });
    const rawtx: any = {
        data: encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "multicall",
            args: [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]],
        }),
        to: orderDetails.orderbook,
        gasPrice,
    };
    spanAttributes["oppBlockNumber"] = Number(blockNumber);

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
        (initDryrunResult.error as FailedSimulation).type = TradeType.IntraOrderbook;
        return Result.err(initDryrunResult.error as FailedSimulation);
    }

    let { estimation, estimatedGasCost } = initDryrunResult.value;
    // include dryrun initial gas estimation in logs
    Object.assign(spanAttributes, initDryrunResult.value.spanAttributes);
    // include dryrun headroom gas estimation in otel logs
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
        const headroom = BigInt((Number(this.appOptions.gasCoveragePercentage) * 1.03).toFixed());
        spanAttributes["gasEst.initial.minBountyExpected"] = (
            (estimatedGasCost * headroom) /
            100n
        ).toString();
        task.evaluable.bytecode = (await parseRainlang(
            await getWithdrawEnsureRainlang(
                signer.account.address,
                orderDetails.buyToken,
                orderDetails.sellToken,
                inputBalance,
                outputBalance,
                parseUnits(inputToEthPrice, 18),
                parseUnits(outputToEthPrice, 18),
                (estimatedGasCost * headroom) / 100n,
                signer.account.address,
            ),
            this.state.client,
            this.state.dispair,
        )) as `0x${string}`;
        withdrawOutputCalldata = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "withdraw2",
            args: [orderDetails.sellToken, outputBountyVaultId, maxUint256, [task]],
        });
        rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "multicall",
            args: [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]],
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
            (finalDryrunResult.error as FailedSimulation).type = TradeType.IntraOrderbook;
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
            await getWithdrawEnsureRainlang(
                signer.account.address,
                orderDetails.buyToken,
                orderDetails.sellToken,
                inputBalance,
                outputBalance,
                parseUnits(inputToEthPrice, 18),
                parseUnits(outputToEthPrice, 18),
                (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) / 100n,
                signer.account.address,
            ),
            this.state.client,
            this.state.dispair,
        )) as `0x${string}`;
        withdrawOutputCalldata = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "withdraw2",
            args: [orderDetails.sellToken, outputBountyVaultId, maxUint256, [task]],
        });
        rawtx.data = encodeFunctionData({
            abi: ABI.Orderbook.Primary.Orderbook,
            functionName: "multicall",
            args: [[clear2Calldata, withdrawInputCalldata, withdrawOutputCalldata]],
        });
        spanAttributes["gasEst.final.minBountyExpected"] = (
            (estimatedGasCost * BigInt(this.appOptions.gasCoveragePercentage)) /
            100n
        ).toString();
    }

    // if reached here, it means there was a success and found opp
    spanAttributes["foundOpp"] = true;
    const result = {
        type: TradeType.IntraOrderbook,
        spanAttributes,
        rawtx,
        estimatedGasCost,
        oppBlockNumber: Number(blockNumber),
        estimatedProfit: estimateProfit(
            orderDetails,
            parseUnits(inputToEthPrice, 18),
            parseUnits(outputToEthPrice, 18),
            counterpartyOrderDetails,
        ),
    };
    return Result.ok(result);
}
