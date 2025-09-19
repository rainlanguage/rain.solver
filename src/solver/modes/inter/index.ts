import assert from "assert";
import { RainSolver } from "../..";
import { Result } from "../../../result";
import { trySimulateTrade } from "./simulate";
import { SimulationResult } from "../../types";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { BundledOrders, Pair } from "../../../order";
import { extendObjectWithHeader } from "../../../logger";

/**
 * Tries to find the best trade against order orderbooks (inter-orderbook) for the given order,
 * it will simultaneously try to find the best trade against top 3 orders (by ratio) of all
 * orderbooks that have a counterparty order pair
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param inputToEthPrice - The current price of input token to ETH price
 * @param outputToEthPrice - The current price of output token to ETH price
 */
export async function findBestInterOrderbookTrade(
    this: RainSolver,
    orderDetails: BundledOrders,
    signer: RainSolverSigner,
    inputToEthPrice: string,
    outputToEthPrice: string,
): Promise<SimulationResult> {
    // bail early if generic arb address is not set
    if (!this.appOptions.genericArbAddress) {
        return Result.err({
            spanAttributes: {
                error: "No generic arb address was set in config, cannot perform inter-orderbook trades",
            },
        });
    }

    const spanAttributes: Attributes = {};
    const blockNumber = await this.state.client.getBlockNumber();
    const counterpartyOrders = this.orderManager.getCounterpartyOrders(orderDetails, false);
    const maximumInputFixed = orderDetails.takeOrders.reduce((a, b) => a + b.quote!.maxOutput, 0n);
    const counterparties: Pair[] = [];

    // run simulations for top 3 counterparty orders of each orderbook
    const promises = counterpartyOrders.flatMap((orderbookCounterparties) => {
        const cps = orderbookCounterparties.slice(0, 3);
        counterparties.push(...cps);
        return cps.map((counterpartyOrderDetails) => {
            return trySimulateTrade.call(this, {
                orderDetails,
                counterpartyOrderDetails,
                signer,
                maximumInputFixed,
                inputToEthPrice,
                outputToEthPrice,
                blockNumber,
            });
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
        return Result.err({
            spanAttributes,
            noneNodeError: allNoneNodeErrors[0],
        });
    }
}
