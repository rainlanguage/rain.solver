import assert from "assert";
import { RainSolver } from "../..";
import { fallbackEthPrice } from "../dryrun";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { InterOrderbookTradeSimulator } from "./simulate";
import { CounterpartySource, Pair } from "../../../order";
import { SimulationResult, TradeType } from "../../types";
import { Result, extendObjectWithHeader } from "../../../common";

/**
 * Tries to find the best trade against order orderbooks (inter-orderbook) for the given order,
 * it will simultaneously try to find the best trade against top 3 orders (by ratio) of all
 * orderbooks that have a counterparty order pair
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param inputToEthPrice - The current price of input token to ETH price
 * @param outputToEthPrice - The current price of output token to ETH price
 * @param blockNumber - The current block number
 */
export async function findBestInterOrderbookTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    inputToEthPrice: string,
    outputToEthPrice: string,
    blockNumber: bigint,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};

    // exit early if required trade addresses are not configured
    if (!this.state.contracts.getAddressesForTrade(orderDetails, TradeType.InterOrderbook)) {
        spanAttributes["error"] =
            `Cannot trade as generic arb address is not configured for order ${orderDetails.takeOrder.struct.order.type} trade`;
        return Result.err({
            type: TradeType.InterOrderbook,
            spanAttributes,
            reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
        });
    }

    const counterpartyOrders = this.orderManager.getCounterpartyOrders(
        orderDetails,
        CounterpartySource.InterOrderbook,
    );
    const maximumInputFixed = orderDetails.takeOrder.quote!.maxOutput;
    const counterparties: Pair[] = [];

    // run simulations for top 3 counterparty orders of each orderbook
    const promises = counterpartyOrders.flatMap((orderbookCounterparties) => {
        const cps = orderbookCounterparties.slice(0, 3);

        // skip if no counterparty orders or order type mismatch
        // as we currently cant trade v4 against v5 due generic arb contarcts
        // need to implement onTakeOrder2() for v4 ob and onTakeOrder() for v5 ob
        if (
            cps.length === 0 ||
            cps[0].takeOrder.struct.order.type !== orderDetails.takeOrder.struct.order.type
        ) {
            return [];
        }

        counterparties.push(...cps);
        return cps.map((counterpartyOrderDetails) => {
            return InterOrderbookTradeSimulator.withArgs({
                type: TradeType.InterOrderbook,
                solver: this,
                orderDetails,
                counterpartyOrderDetails,
                signer,
                maximumInputFixed,
                inputToEthPrice:
                    inputToEthPrice ||
                    fallbackEthPrice(
                        orderDetails.takeOrder.quote!.ratio,
                        counterpartyOrderDetails.takeOrder.quote!.ratio,
                        outputToEthPrice,
                    ),
                outputToEthPrice:
                    outputToEthPrice ||
                    fallbackEthPrice(
                        counterpartyOrderDetails.takeOrder.quote!.ratio,
                        orderDetails.takeOrder.quote!.ratio,
                        inputToEthPrice,
                    ),
                blockNumber,
            }).trySimulateTrade();
        });
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
            extendObjectWithHeader(
                spanAttributes,
                res.error.spanAttributes,
                "againstOrderbooks." + counterparties[i].orderbook,
            );
            allNoneNodeErrors.push(res.error.noneNodeError);
        }
        if (!results.length) {
            spanAttributes["error"] = "no counterparties found for inter-orderbook trade";
        }
        return Result.err({
            type: TradeType.InterOrderbook,
            spanAttributes,
            noneNodeError: allNoneNodeErrors[0],
        });
    }
}
