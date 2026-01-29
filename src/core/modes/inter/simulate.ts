import { RainSolver } from "../..";
import { errorSnapshot } from "../../../error";
import { ONE18, scaleFrom18 } from "../../../math";
import { RainSolverSigner } from "../../../signer";
import { WasmEncodedError } from "@rainlanguage/float";
import { TradeType, FailedSimulation, TaskType } from "../../types";
import { SimulationHaltReason, TradeSimulatorBase } from "../simulator";
import { Result, ABI, RawTransaction, maxFloat, toFloat, minFloat } from "../../../common";
import { encodeAbiParameters, encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import {
    EnsureBountyTaskType,
    EnsureBountyTaskErrorType,
    getEnsureBountyTaskBytecode,
} from "../../../task";
import {
    Pair,
    PairV3,
    PairV4,
    TakeOrdersConfigType,
    TakeOrdersConfigTypeV3,
    TakeOrdersConfigTypeV4,
    TakeOrdersConfigTypeV5,
} from "../../../order";

/** Arguments for simulating inter-orderbook trade */
export type SimulateInterOrderbookTradeArgs = {
    /** The type of trade */
    type: TradeType.InterOrderbook;
    /** The RainSolver instance used for simulation */
    solver: RainSolver;
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

/**
 * Simulates a trade between two different orderbooks and prepares the necessary transaction
 * parameters and calldata for on-chain execution.
 *
 * The `InterOrderbookTradeSimulator` class extends {@link TradeSimulatorBase} and is responsible for:
 * - Simulating trades between two orderbooks (inter-orderbook trades).
 * - Preparing and encoding the transaction data required to execute the trade on-chain.
 * - Handling V4/V5 orderbook versions (order v3/v4).
 * - Estimating the profit from the simulated trade based on input/output prices and order quotes.
 * - Managing simulation state, error handling, and span attributes for tracing and observability.
 *
 * Key responsibilities:
 * - Validates and prepares trade parameters, including order details, counterparty details, and price data.
 * - Builds the calldata for the appropriate arbitrage contract method (`arb3` for V3, `arb4` for V4/V5).
 * - Encodes the counterparty's take orders configuration for use in the transaction.
 * - Estimates the expected profit from the trade.
 * - Handles errors and simulation halt reasons, returning detailed error information when simulation cannot proceed.
 *
 * @remarks
 * Use this class to simulate and prepare trades between two orders of different orderbooks,
 * including all necessary transaction data for execution on on-chain.
 */
export class InterOrderbookTradeSimulator extends TradeSimulatorBase {
    declare tradeArgs: SimulateInterOrderbookTradeArgs;

    static withArgs(tradeArgs: SimulateInterOrderbookTradeArgs): InterOrderbookTradeSimulator {
        return new InterOrderbookTradeSimulator(tradeArgs);
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
        const gasPrice = this.tradeArgs.solver.state.gasPrice;

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

        const encodedFnResult = this.getCounterpartyTakeOrdersConfig(
            orderDetails,
            counterpartyOrderDetails,
            maximumInputFixed,
        );
        if (encodedFnResult.isErr()) {
            this.spanAttributes["error"] = encodedFnResult.error.readableMsg;
            const result: FailedSimulation = {
                spanAttributes: this.spanAttributes,
                type: TradeType.InterOrderbook,
                noneNodeError: encodedFnResult.error.readableMsg,
            };
            return Result.err(result);
        }
        const encodedFN = encodedFnResult.value;

        const takeOrdersConfigStruct = this.getTakeOrdersConfig(
            orderDetails,
            counterpartyOrderDetails,
            encodedFN,
        );

        // exit early if required trade addresses are not configured
        const addresses = this.tradeArgs.solver.state.contracts.getAddressesForTrade(
            orderDetails,
            TradeType.InterOrderbook,
        );
        if (!addresses) {
            this.spanAttributes["error"] =
                `Cannot trade as generic arb address is not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
            this.spanAttributes["duration"] = performance.now() - this.startTime;
            return Result.err({
                type: TradeType.InterOrderbook,
                spanAttributes: this.spanAttributes,
                reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
            });
        }

        const rawtx: RawTransaction = {
            to: addresses.destination,
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
        // we can be sure the addresses exist here since we checked in prepareTradeParams
        const addresses = this.tradeArgs.solver.state.contracts.getAddressesForTrade(
            this.tradeArgs.orderDetails,
            params.type,
        )!;

        // try to get task bytecode for ensure bounty task
        const taskBytecodeResult = await getEnsureBountyTaskBytecode(
            {
                type: EnsureBountyTaskType.External,
                inputToEthPrice: parseUnits(this.tradeArgs.inputToEthPrice, 18),
                outputToEthPrice: parseUnits(this.tradeArgs.outputToEthPrice, 18),
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
                type: TradeType.InterOrderbook,
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

        params.rawtx.data = this.getCalldata(params.takeOrdersConfigStruct, task);
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

    /**
     * Creates a new TakeOrdersConfigType based on the order and counterparty order,
     * this is unified method to handle any order versions combiations
     * @param orderDetails - The order pair to create the config for
     * @param counterpartyOrderDetails - Counterparty order
     * @param maximumInputFixed - The trade maximum input
     */
    getTakeOrdersConfig(
        orderDetails: Pair,
        counterpartyOrderDetails: Pair,
        encodedFN: `0x${string}`,
    ): TakeOrdersConfigType {
        if (Pair.isV3(orderDetails)) {
            return this.getTakeOrdersConfigV3(orderDetails, counterpartyOrderDetails, encodedFN);
        } else if (Pair.isV4OrderbookV5(orderDetails)) {
            return this.getTakeOrdersConfigV4(orderDetails, counterpartyOrderDetails, encodedFN);
        } else {
            return this.getTakeOrdersConfigV5(orderDetails, counterpartyOrderDetails, encodedFN);
        }
    }

    /**
     * Creates a new TakeOrdersConfigTypeV3 based on the v3 order and counterparty order
     * @param orderDetails - The order pair v3 to create the config for
     * @param counterpartyOrderDetails - Counterparty order
     * @param maximumInputFixed - The trade maximum input
     */
    getTakeOrdersConfigV3(
        orderDetails: PairV3,
        counterpartyOrderDetails: Pair,
        encodedFN: `0x${string}`,
    ): TakeOrdersConfigTypeV3 {
        const takeOrdersConfigStruct: TakeOrdersConfigTypeV3 = {
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
        return takeOrdersConfigStruct;
    }

    /**
     * Creates a new TakeOrdersConfigTypeV4 based on the v4 order and counterparty order
     * @param orderDetails - The order pair v4 to create the config for
     * @param counterpartyOrderDetails - Counterparty order
     * @param maximumInputFixed - The trade maximum input
     */
    getTakeOrdersConfigV4(
        orderDetails: PairV4,
        counterpartyOrderDetails: Pair,
        encodedFN: `0x${string}`,
    ): TakeOrdersConfigTypeV4 {
        const takeOrdersConfigStruct: TakeOrdersConfigTypeV4 = {
            minimumInput: minFloat(orderDetails.sellTokenDecimals),
            maximumInput: maxFloat(orderDetails.sellTokenDecimals),
            maximumIORatio: maxFloat(18),
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
        return takeOrdersConfigStruct;
    }

    /**
     * Creates a new TakeOrdersConfigTypeV4 based on the v4 order and counterparty order
     * @param orderDetails - The order pair v4 to create the config for
     * @param counterpartyOrderDetails - Counterparty order
     * @param maximumInputFixed - The trade maximum input
     */
    getTakeOrdersConfigV5(
        orderDetails: PairV4,
        counterpartyOrderDetails: Pair,
        encodedFN: `0x${string}`,
    ): TakeOrdersConfigTypeV5 {
        const takeOrdersConfigStruct: TakeOrdersConfigTypeV5 = {
            minimumIO: minFloat(orderDetails.sellTokenDecimals),
            maximumIO: maxFloat(orderDetails.sellTokenDecimals),
            maximumIORatio: maxFloat(18),
            IOIsInput: true,
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
        return takeOrdersConfigStruct;
    }

    /**
     * Creates the encoded TakeOrdersConfigType based on the order and counterparty order,
     * this is unified method to handle any order versions combiations
     * @param orderDetails - The order pair to create the config for
     * @param counterpartyOrderDetails - Counterparty order
     * @param maximumInputFixed - The trade maximum input
     */
    getCounterpartyTakeOrdersConfig(
        orderDetails: Pair,
        counterpartyOrderDetails: Pair,
        maximumInputFixed: bigint,
    ): Result<`0x${string}`, WasmEncodedError> {
        if (Pair.isV3(counterpartyOrderDetails)) {
            return Result.ok(
                this.getEncodedCounterpartyTakeOrdersConfigV3(
                    orderDetails,
                    counterpartyOrderDetails as PairV3,
                    maximumInputFixed,
                ),
            );
        } else if (Pair.isV4OrderbookV5(counterpartyOrderDetails)) {
            return this.getEncodedCounterpartyTakeOrdersConfigV4(
                orderDetails as PairV4,
                counterpartyOrderDetails as PairV4,
                maximumInputFixed,
            );
        } else {
            return this.getEncodedCounterpartyTakeOrdersConfigV5(
                orderDetails as PairV4,
                counterpartyOrderDetails as PairV4,
                maximumInputFixed,
            );
        }
    }

    /**
     * Creates encoded TakeOrdersConfigTypeV3 based on the order and counterparty v3 order
     * @param orderDetails - The order pair
     * @param counterpartyOrderDetails - Counterparty v3 order
     * @param maximumInputFixed - The trade maximum input
     */
    getEncodedCounterpartyTakeOrdersConfigV3(
        orderDetails: Pair,
        counterpartyOrderDetails: PairV3,
        maximumInputFixed: bigint,
    ): `0x${string}` {
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
            abi: ABI.Orderbook.V4.Primary.Orderbook,
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
        return encodedFN;
    }

    /**
     * Creates encoded TakeOrdersConfigTypeV4 based on the order and counterparty v4 order
     * @param orderDetails - The order pair
     * @param counterpartyOrderDetails - Counterparty v4 order to create config for
     * @param maximumInputFixed - The trade maximum input
     */
    getEncodedCounterpartyTakeOrdersConfigV4(
        orderDetails: Pair,
        counterpartyOrderDetails: PairV4,
        maximumInputFixed: bigint,
    ): Result<`0x${string}`, WasmEncodedError> {
        let opposingMaxInput: `0x${string}` = maxFloat(orderDetails.buyTokenDecimals);
        let opposingMaxIORatio: `0x${string}` = maxFloat(18);
        if (orderDetails.takeOrder.quote!.ratio !== 0n) {
            const maxInputResult = toFloat(
                scaleFrom18(
                    (maximumInputFixed * orderDetails.takeOrder.quote!.ratio) / ONE18,
                    orderDetails.buyTokenDecimals,
                ),
                orderDetails.buyTokenDecimals,
            );
            if (maxInputResult.isErr()) {
                return Result.err(maxInputResult.error);
            }
            opposingMaxInput = maxInputResult.value;

            const maxIoRatioResult = toFloat(ONE18 ** 2n / orderDetails.takeOrder.quote!.ratio, 18);
            if (maxIoRatioResult.isErr()) {
                return Result.err(maxIoRatioResult.error);
            }
            opposingMaxIORatio = maxIoRatioResult.value;
        }

        // encode takeOrders3() and build tx fields
        const encodedFN = encodeFunctionData({
            abi: ABI.Orderbook.V5.Primary.Orderbook,
            functionName: "takeOrders3",
            args: [
                {
                    minimumInput: minFloat(orderDetails.sellTokenDecimals),
                    maximumInput: opposingMaxInput, // main maxout * main ratio
                    maximumIORatio: opposingMaxIORatio, // inverse of main ratio (1 / ratio)
                    orders: [counterpartyOrderDetails.takeOrder.struct], // opposing orders
                    data: "0x",
                },
            ],
        });
        return Result.ok(encodedFN);
    }

    /**
     * Creates encoded TakeOrdersConfigTypeV5 based on the order and counterparty v4 order
     * @param orderDetails - The order pair
     * @param counterpartyOrderDetails - Counterparty v4 order to create config for
     * @param maximumInputFixed - The trade maximum input
     */
    getEncodedCounterpartyTakeOrdersConfigV5(
        orderDetails: Pair,
        counterpartyOrderDetails: PairV4,
        maximumInputFixed: bigint,
    ): Result<`0x${string}`, WasmEncodedError> {
        let opposingMaxInput: `0x${string}` = maxFloat(orderDetails.buyTokenDecimals);
        let opposingMaxIORatio: `0x${string}` = maxFloat(18);
        if (orderDetails.takeOrder.quote!.ratio !== 0n) {
            const maxInputResult = toFloat(
                scaleFrom18(
                    (maximumInputFixed * orderDetails.takeOrder.quote!.ratio) / ONE18,
                    orderDetails.buyTokenDecimals,
                ),
                orderDetails.buyTokenDecimals,
            );
            if (maxInputResult.isErr()) {
                return Result.err(maxInputResult.error);
            }
            opposingMaxInput = maxInputResult.value;

            const maxIoRatioResult = toFloat(ONE18 ** 2n / orderDetails.takeOrder.quote!.ratio, 18);
            if (maxIoRatioResult.isErr()) {
                return Result.err(maxIoRatioResult.error);
            }
            opposingMaxIORatio = maxIoRatioResult.value;
        }

        // encode takeOrders3() and build tx fields
        const encodedFN = encodeFunctionData({
            abi: ABI.Orderbook.V6.Primary.Orderbook,
            functionName: "takeOrders4",
            args: [
                {
                    minimumIO: minFloat(orderDetails.sellTokenDecimals),
                    maximumIO: opposingMaxInput, // main maxout * main ratio
                    maximumIORatio: opposingMaxIORatio, // inverse of main ratio (1 / ratio)
                    IOIsInput: true,
                    orders: [counterpartyOrderDetails.takeOrder.struct], // opposing orders
                    data: "0x",
                },
            ],
        });
        return Result.ok(encodedFN);
    }

    /**
     * Builds the calldata based on the order type
     * @param takeOrdersConfigStruct - The take orders config struct
     * @param task - The ensure bounty task object
     */
    getCalldata(takeOrdersConfigStruct: TakeOrdersConfigType, task: TaskType): `0x${string}` {
        if (Pair.isV3(this.tradeArgs.orderDetails)) {
            return encodeFunctionData({
                abi: ABI.Orderbook.V4.Primary.Arb,
                functionName: "arb3",
                args: [
                    this.tradeArgs.orderDetails.orderbook as `0x${string}`,
                    takeOrdersConfigStruct,
                    task,
                ],
            });
        } else {
            const args = [
                this.tradeArgs.orderDetails.orderbook as `0x${string}`,
                takeOrdersConfigStruct,
                task,
            ] as const;
            const isV6 = Pair.isV4OrderbookV6(this.tradeArgs.orderDetails);
            if (isV6) {
                return encodeFunctionData({
                    abi: ABI.Orderbook.V6.Primary.Arb,
                    functionName: "arb5",
                    args,
                });
            } else {
                return encodeFunctionData({
                    abi: ABI.Orderbook.V5.Primary.Arb,
                    functionName: "arb4",
                    args,
                });
            }
        }
    }
}
