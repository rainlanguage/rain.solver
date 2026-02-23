import { ChainId } from "sushi";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { ABI, normalizeFloat } from "../common";
import { BundledOrders, Pair, TakeOrder } from "./types";
import { decodeFunctionResult, encodeFunctionData, PublicClient } from "viem";
import { extractOracleUrl, fetchSignedContext } from "../oracle";

/**
 * If the order has oracle metadata, fetch signed context and inject it
 * into the takeOrder struct. Failures are swallowed so quoting proceeds
 * with empty signed context.
 */
async function fetchOracleContext(orderDetails: Pair): Promise<void> {
    const orderMeta = (orderDetails as any).meta;
    if (!orderMeta) return;

    const oracleUrl = extractOracleUrl(orderMeta);
    if (!oracleUrl) return;

    const signedContexts = await fetchSignedContext(oracleUrl, [
        {
            order: orderDetails.takeOrder.struct.order,
            inputIOIndex: orderDetails.takeOrder.struct.inputIOIndex,
            outputIOIndex: orderDetails.takeOrder.struct.outputIOIndex,
            counterparty: "0x0000000000000000000000000000000000000000",
        },
    ]);

    orderDetails.takeOrder.struct.signedContext = signedContexts;
}

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
    if (Pair.isV3(orderDetails)) {
        return quoteSingleOrderV3(orderDetails, viemClient, blockNumber, gas);
    } else {
        return quoteSingleOrderV4(orderDetails, viemClient, blockNumber, gas);
    }
}

/**
 * Quotes a single order v3
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrderV3(
    orderDetails: Pair,
    viemClient: PublicClient,
    blockNumber?: bigint,
    gas?: bigint,
) {
    try {
        await fetchOracleContext(orderDetails);
    } catch (error) {
        console.warn("Failed to fetch oracle context:", error);
    }

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
 * Quotes a single order v4
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrderV4(
    orderDetails: Pair,
    viemClient: PublicClient,
    blockNumber?: bigint,
    gas?: bigint,
) {
    try {
        await fetchOracleContext(orderDetails);
    } catch (error) {
        console.warn("Failed to fetch oracle context:", error);
    }

    const { data } = await viemClient
        .call({
            to: orderDetails.orderbook as `0x${string}`,
            data: encodeFunctionData({
                abi: ABI.Orderbook.V5.Primary.Orderbook,
                functionName: "quote2",
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
            abi: [ABI.Orderbook.V5.Primary.Orderbook[17]],
            functionName: "quote2",
            data,
        });

        // handle quote result floats
        const maxoutputResult = normalizeFloat(quoteResult[1], 18);
        if (maxoutputResult.isErr()) {
            orderDetails.takeOrder.quote = undefined;
            return Promise.reject(
                `Failed to handle quote maxoutput float, reason: ${maxoutputResult.error.readableMsg}`,
            );
        }
        const ratioResult = normalizeFloat(quoteResult[2], 18);
        if (ratioResult.isErr()) {
            orderDetails.takeOrder.quote = undefined;
            return Promise.reject(
                `Failed to handle quote ratio float, reason: ${ratioResult.error.readableMsg}`,
            );
        }

        orderDetails.takeOrder.quote = {
            maxOutput: maxoutputResult.value,
            ratio: ratioResult.value,
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
