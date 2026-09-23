import { ChainId } from "sushi";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { fetchOracleContext } from "../oracle";
import { ABI, normalizeFloat, withBigintSerializer } from "../common";
import { BundledOrders, Pair, TakeOrder } from "./types";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { Attributes } from "@opentelemetry/api";
import { OrderSpanEvents } from "../core/types";

/**
 * Quotes a single order
 * @param orderDetails - Order details to quote
 * @param viemClient - Viem client
 * @param state - SharedState for oracle health tracking
 * @param blockNumber - Optional block number
 * @param gas - Optional read gas
 */
export async function quoteSingleOrder(
    orderDetails: Pair,
    state: SharedState,
    spanAttributes: Attributes,
    spanEvents: OrderSpanEvents,
    blockNumber?: bigint,
    gas?: bigint,
) {
    if (Pair.isV3(orderDetails)) {
        return quoteSingleOrderV3(
            orderDetails,
            state,
            spanAttributes,
            spanEvents,
            blockNumber,
            gas,
        );
    } else {
        return quoteSingleOrderV4(
            orderDetails,
            state,
            spanAttributes,
            spanEvents,
            blockNumber,
            gas,
        );
    }
}

/**
 * Fetches the oracle signed context for the order (noop for orders without
 * oracle url) and records the fetch details in the span attributes and events,
 * throws the oracle error if the fetch fails
 * @param orderDetails - Order details to fetch oracle context for
 * @param state - SharedState for oracle health tracking
 * @param spanAttributes - Span attributes to record the oracle details into
 * @param spanEvents - Span events to record the oracle fetch timing into
 */
export async function fetchOracleContextWithSpan(
    orderDetails: Pair,
    state: SharedState,
    spanAttributes: Attributes,
    spanEvents: OrderSpanEvents,
) {
    const oracleTime = performance.now();
    const oracleResult = await fetchOracleContext.call(state, orderDetails, spanAttributes);
    if (orderDetails.oracleUrl) {
        const duration = performance.now() - oracleTime;
        spanAttributes["events.duration.oracleFetch"] = duration;
        spanEvents["oracleFetch"] = { startTime: oracleTime, duration };
    }
    if (oracleResult.isErr()) {
        throw oracleResult.error;
    }
    if (orderDetails.oracleUrl) {
        spanAttributes["details.oracle.new"] = orderDetails.takeOrder.struct.signedContext
            ? JSON.stringify(orderDetails.takeOrder.struct.signedContext, withBigintSerializer)
            : "N/A";
    }
}

/**
 * Quotes a single order v3
 */
export async function quoteSingleOrderV3(
    orderDetails: Pair,
    state: SharedState,
    spanAttributes: Attributes,
    spanEvents: OrderSpanEvents,
    blockNumber?: bigint,
    gas?: bigint,
) {
    blockNumber;
    await fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents);

    const { data } = await state.client
        .call({
            to: orderDetails.orderbook as `0x${string}`,
            data: encodeFunctionData({
                abi: ABI.Orderbook.V4.Primary.Orderbook,
                functionName: "quote",
                args: [TakeOrder.getQuoteConfig(orderDetails.takeOrder.struct)],
            }),
            gas,
            blockTag: "pending",
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
 */
export async function quoteSingleOrderV4(
    orderDetails: Pair,
    state: SharedState,
    spanAttributes: Attributes,
    spanEvents: OrderSpanEvents,
    blockNumber?: bigint,
    gas?: bigint,
) {
    blockNumber;
    await fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents);

    const { data } = await state.client
        .call({
            to: orderDetails.orderbook as `0x${string}`,
            data: encodeFunctionData({
                abi: ABI.Orderbook.V5.Primary.Orderbook,
                functionName: "quote2",
                args: [TakeOrder.getQuoteConfig(orderDetails.takeOrder.struct)],
            }),
            gas,
            blockTag: "pending",
        })
        .catch((error) => {
            orderDetails.takeOrder.quote = undefined;
            spanAttributes["details.oracle.quoteRpcUrl"] = state.rpc?.lastUsedUrl;
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
