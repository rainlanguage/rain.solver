import assert from "assert";
import { RainSolver } from "../..";
import { BaseError, erc20Abi } from "viem";
import { fallbackEthPrice } from "../dryrun";
import { ONE18, scaleTo18 } from "../../../math";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { CounterpartySource, Pair } from "../../../order";
import { IntraOrderbookTradeSimulator } from "./simulation";
import { Result, extendObjectWithHeader } from "../../../common";
import { containsNodeError, errorSnapshot } from "../../../error";
import { FailedSimulation, SimulationResult, TradeType } from "../../types";

/**
 * Tries to find the best trade against opposite orders of the same orderbook (intra-orderbook) for
 * the given order, it will simultaneously try to find the best trade against top 3 orders (by ratio)
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param inputToEthPrice - The current price of input token to ETH price
 * @param outputToEthPrice - The current price of output token to ETH price
 * @param blockNumber - The current block number
 */
export async function findBestIntraOrderbookTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    inputToEthPrice: string,
    outputToEthPrice: string,
    blockNumber: bigint,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};

    // exit early if required trade addresses are not configured
    if (!this.state.contracts.getAddressesForTrade(orderDetails, TradeType.IntraOrderbook)) {
        spanAttributes["error"] =
            `Cannot trade as dispair addresses are not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
        return Result.err({
            type: TradeType.IntraOrderbook,
            spanAttributes,
            reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
        });
    }

    // get counterparties and perform a general filter on them
    const counterpartyOrders = this.orderManager
        .getCounterpartyOrders(orderDetails, CounterpartySource.IntraOrderbook)
        .filter(
            (v) =>
                v.takeOrder.quote &&
                // not same order
                v.takeOrder.id !== orderDetails.takeOrder.id &&
                // not same owner
                v.takeOrder.struct.order.owner.toLowerCase() !==
                    orderDetails.takeOrder.struct.order.owner.toLowerCase() &&
                // only orders that (priceA x priceB < 1) can be profitbale
                (v.takeOrder.quote.ratio * orderDetails.takeOrder.quote!.ratio) / ONE18 < ONE18,
        );

    // get input token balance of signer with handling errors
    const inputBalanceResult: Result<bigint, FailedSimulation> = await this.state.client
        .readContract({
            address: orderDetails.buyToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        })
        .then((v) => Result.ok(v) as Result<bigint, FailedSimulation>)
        .catch(async (err) => {
            const errMsg = await errorSnapshot("Failed to get input token balance", err);
            const isNodeError = await containsNodeError(err as BaseError);
            const result: FailedSimulation = {
                type: TradeType.IntraOrderbook,
                spanAttributes: { error: errMsg } as Attributes,
            };
            if (!isNodeError) {
                result.noneNodeError = errMsg;
            }
            return Result.err(result);
        });
    if (inputBalanceResult.isErr()) {
        return Result.err(inputBalanceResult.error);
    }
    const inputBalance = scaleTo18(inputBalanceResult.value, orderDetails.buyTokenDecimals);

    // get output token balance of signer with handling errors
    const outputBalanceResult: Result<bigint, FailedSimulation> = await this.state.client
        .readContract({
            address: orderDetails.sellToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        })
        .then((v) => Result.ok(v) as Result<bigint, FailedSimulation>)
        .catch(async (err) => {
            const errMsg = await errorSnapshot("Failed to get output token balance", err);
            const isNodeError = await containsNodeError(err as BaseError);
            const result: FailedSimulation = {
                type: TradeType.IntraOrderbook,
                spanAttributes: { error: errMsg } as Attributes,
            };
            if (!isNodeError) {
                result.noneNodeError = errMsg;
            }
            return Result.err(result);
        });
    if (outputBalanceResult.isErr()) {
        return Result.err(outputBalanceResult.error);
    }
    const outputBalance = scaleTo18(outputBalanceResult.value, orderDetails.sellTokenDecimals);

    // run simulations for top 3 counterparty orders
    const promises = counterpartyOrders.slice(0, 3).map((counterparty) => {
        if (!orderDetails.takeOrder.quote || !counterparty.takeOrder.quote) {
            return Result.err({
                type: TradeType.IntraOrderbook,
                spanAttributes: {},
            }) as SimulationResult;
        }
        return IntraOrderbookTradeSimulator.withArgs({
            type: TradeType.IntraOrderbook,
            solver: this,
            orderDetails,
            counterpartyOrderDetails: counterparty.takeOrder,
            signer,
            inputToEthPrice:
                inputToEthPrice ||
                fallbackEthPrice(
                    orderDetails.takeOrder.quote!.ratio,
                    counterparty.takeOrder.quote!.ratio,
                    outputToEthPrice,
                ),
            outputToEthPrice:
                outputToEthPrice ||
                fallbackEthPrice(
                    counterparty.takeOrder.quote!.ratio,
                    orderDetails.takeOrder.quote!.ratio,
                    inputToEthPrice,
                ),
            blockNumber,
            inputBalance,
            outputBalance,
        }).trySimulateTrade();
    });

    const results = await Promise.all(promises);
    if (results.some((res) => res.isOk())) {
        // pick the one with highest estimated profit
        return results.sort((a, b) => {
            if (a.isErr() && b.isErr()) return 0;
            if (a.isErr()) return 1;
            if (b.isErr()) return -1;
            return a.value.estimatedProfit < b.value.estimatedProfit
                ? 1
                : a.value.estimatedProfit > b.value.estimatedProfit
                  ? -1
                  : 0;
        })[0];
    } else {
        const allNoneNodeErrors: (string | undefined)[] = [];
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            assert(res.isErr()); // for type check as we know all results are errors
            extendObjectWithHeader(spanAttributes, res.error.spanAttributes, "intraOrderbook." + i);
            allNoneNodeErrors.push(res.error.noneNodeError);
        }
        if (!results.length) {
            spanAttributes["error"] = "no counterparties found for intra-orderbook trade";
        }
        return Result.err({
            type: TradeType.IntraOrderbook,
            spanAttributes,
            noneNodeError: allNoneNodeErrors[0],
        });
    }
}
