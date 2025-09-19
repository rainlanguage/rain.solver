import { OrderbookQuoteAbi } from "../abis";
import { BundledOrders, TakeOrder } from "./types";
import { decodeFunctionResult, encodeFunctionData, PublicClient } from "viem";

/**
 * Quotes a single order
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrder(
    orderDetails: BundledOrders,
    viemClient: PublicClient,
    blockNumber?: bigint,
    gas?: bigint,
) {
    const { data } = await viemClient.call({
        to: orderDetails.orderbook as `0x${string}`,
        data: encodeFunctionData({
            abi: OrderbookQuoteAbi,
            functionName: "quote",
            args: [TakeOrder.getQuoteConfig(orderDetails.takeOrders[0].takeOrder)],
        }),
        blockNumber,
        gas,
    });
    if (typeof data !== "undefined") {
        const quoteResult = decodeFunctionResult({
            abi: OrderbookQuoteAbi,
            functionName: "quote",
            data,
        });
        orderDetails.takeOrders[0].quote = {
            maxOutput: quoteResult[1],
            ratio: quoteResult[2],
        };
        return;
    } else {
        return Promise.reject(`Failed to quote order, reason: required no data`);
    }
}
