import { ChainId } from "sushi";
import { ABI } from "../common";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { BundledOrders, Pair, TakeOrder } from "./types";
import { decodeFunctionResult, encodeFunctionData, PublicClient } from "viem";

/**
 * Quotes a single order
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrder(
    orderDetails: Pair,
    viemClient: PublicClient,
    blockNumber?: bigint,
    gas?: bigint,
) {
    const { data } = await viemClient
        .call({
            to: orderDetails.orderbook as `0x${string}`,
            data: encodeFunctionData({
                abi: ABI.Orderbook.V4.Primary.Orderbook,
                functionName: "quote",
                args: [TakeOrder.getQuoteConfig(orderDetails.takeOrder.struct)],
            }),
            blockNumber,
            gas,
        })
        .catch((error) => {
            orderDetails.takeOrder.quote = undefined;
            throw error;
        });
    if (typeof data !== "undefined") {
        const quoteResult = decodeFunctionResult({
            abi: [ABI.Orderbook.V4.Primary.Orderbook[14]],
            functionName: "quote",
            data,
        });
        orderDetails.takeOrder.quote = {
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
            abi: ABI.Orderbook.V4.Primary.Orderbook,
            functionName: "quote",
            args: [TakeOrder.getQuoteConfig(orderDetails.takeOrders[0].struct)],
        });

        // call Arbitrum Node Interface for the calldata to get L1 gas
        const result = await state.client.simulateContract({
            abi: ABI.ArbitrumNodeInterface.Abi,
            address: ABI.ArbitrumNodeInterface.Address,
            functionName: "gasEstimateL1Component",
            args: [orderDetails.orderbook as `0x${string}`, false, calldata],
        });
        return appOptions.quoteGas + result.result[0];
    } else {
        return appOptions.quoteGas;
    }
}
