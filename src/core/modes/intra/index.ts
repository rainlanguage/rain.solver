import assert from "assert";
import { erc20Abi } from "viem";
import { RainSolver } from "../..";
import { Result } from "../../../common";
import { ONE18, scaleTo18 } from "../../../math";
import { Attributes } from "@opentelemetry/api";
import { trySimulateTrade } from "./simulation";
import { RainSolverSigner } from "../../../signer";
import { fallbackEthPrice } from "../../../router";
import { CounterpartySource, Pair } from "../../../order";
import { extendObjectWithHeader } from "../../../logger";
import { SimulationResult, TradeType } from "../../types";

/**
 * Tries to find the best trade against opposite orders of the same orderbook (intra-orderbook) for
 * the given order, it will simultaneously try to find the best trade against top 3 orders (by ratio)
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param inputToEthPrice - The current price of input token to ETH price
 * @param outputToEthPrice - The current price of output token to ETH price
 */
export async function findBestIntraOrderbookTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    inputToEthPrice: string,
    outputToEthPrice: string,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};

    // get counterparties and perform a general filter on them
    const counterpartyOrders = this.orderManager
        .getCounterpartyOrders(orderDetails, CounterpartySource.IntraOrderbook)
        .filter(
            (v) =>
                v.takeOrder.quote &&
                // not same order
                v.takeOrder.id !== orderDetails.takeOrder.id &&
                // not same owner
                v.takeOrder.takeOrder.order.owner.toLowerCase() !==
                    orderDetails.takeOrder.takeOrder.order.owner.toLowerCase() &&
                // only orders that (priceA x priceB < 1) can be profitbale
                (v.takeOrder.quote.ratio * orderDetails.takeOrder.quote!.ratio) / ONE18 < ONE18,
        );

    const blockNumber = await this.state.client.getBlockNumber();
    const inputBalance = scaleTo18(
        await this.state.client.readContract({
            address: orderDetails.buyToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        }),
        orderDetails.buyTokenDecimals,
    );
    const outputBalance = scaleTo18(
        await this.state.client.readContract({
            address: orderDetails.sellToken as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        }),
        orderDetails.sellTokenDecimals,
    );

    // run simulations for top 3 counterparty orders
    const promises = counterpartyOrders.slice(0, 3).map((counterparty) => {
        return trySimulateTrade.call(this, {
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
            extendObjectWithHeader(spanAttributes, res.error.spanAttributes, "intraOrderbook." + i);
            allNoneNodeErrors.push(res.error.noneNodeError);
        }
        return Result.err({
            type: TradeType.IntraOrderbook,
            spanAttributes,
            noneNodeError: allNoneNodeErrors[0],
        });
    }
}
