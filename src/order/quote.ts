import { ChainId } from "sushi";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { BundledOrders, TakeOrder } from "./types";
import { decodeFunctionResult, encodeFunctionData, PublicClient } from "viem";
import {
    OrderbookQuoteAbi,
    ArbitrumNodeInterfaceAbi,
    ArbitrumNodeInterfaceAddress,
} from "../common";

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

/**
 * Calculates the gas limit that used for quoting orders
 */
export async function getQuoteGas(
    state: SharedState,
    orderDetails: BundledOrders,
    appOptions: AppOptions,
): Promise<bigint> {
    // currently only arbitrum needs extra calculations for quote gas limit
    if (state.chainConfig.id === ChainId.ARBITRUM) {
        // build the calldata of a quote call
        const calldata = encodeFunctionData({
            abi: OrderbookQuoteAbi,
            functionName: "quote",
            args: [TakeOrder.getQuoteConfig(orderDetails.takeOrders[0].takeOrder)],
        });

        // call Arbitrum Node Interface for the calldata to get L1 gas
        const result = await state.client.simulateContract({
            abi: ArbitrumNodeInterfaceAbi,
            address: ArbitrumNodeInterfaceAddress,
            functionName: "gasEstimateL1Component",
            args: [orderDetails.orderbook as `0x${string}`, false, calldata],
        });
        return appOptions.quoteGas + result.result[0];
    } else {
        return appOptions.quoteGas;
    }
}
