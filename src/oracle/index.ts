import { Result } from "../common";
import { OracleError } from "./error";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { OracleHealthMap } from "./types";
import { Order, Pair } from "../order/types";
import { fetchSignedContext } from "./fetch";

/**
 * If the order has an oracle URL, fetch signed context and inject it
 * into the takeOrder struct. Called with SharedState as `this` to access
 * the oracle health map and results cache.
 *
 * The fetch result is cached per order hash along the given block number,
 * so repeated calls for the same order at an unchanged block number reuse
 * the cached result instead of hitting the oracle again.
 *
 * @returns Result that callers decide how to handle failures.
 */
export async function fetchOracleContext(
    this: SharedState,
    orderDetails: Pair,
    blockNumber?: bigint,
): Promise<Result<void, OracleError>> {
    const oracleUrl = orderDetails.oracleUrl;
    if (!oracleUrl) return Result.ok(undefined);

    // Oracle signed context only supported for V4 orders
    const order = orderDetails.takeOrder.struct.order;
    if (order.type !== Order.Type.V4) return Result.ok(undefined);

    // reuse the cached result without hitting the oracle again if the block
    // number has not changed since the previous fetch for this order pair,
    // keyed by order hash and IO indexes since the same order can be fetched
    // for different input/output IO combinations
    const cacheKey = [
        orderDetails.takeOrder.id.toLowerCase(),
        orderDetails.takeOrder.struct.inputIOIndex,
        orderDetails.takeOrder.struct.outputIOIndex,
    ].join("-");
    if (typeof blockNumber === "bigint") {
        const cached = this.oracleHealth
            .get(OracleHealthMap.key(oracleUrl, order.owner))
            ?.cache?.get(cacheKey);
        if (cached && cached.blockNumber === blockNumber) {
            if (cached.result.isErr()) {
                return Result.err(cached.result.error);
            }
            orderDetails.takeOrder.struct.signedContext = [cached.result.value];
            return Result.ok(undefined);
        }
    }

    const isMaxOwnerProfile = AppOptions.isMaxOwnerProfile(
        orderDetails.takeOrder.struct.order.owner,
        this.appOptions.ownerProfile,
    );
    const result = await fetchSignedContext(
        oracleUrl,
        {
            order: order as Order.V4,
            inputIOIndex: orderDetails.takeOrder.struct.inputIOIndex,
            outputIOIndex: orderDetails.takeOrder.struct.outputIOIndex,
            counterparty: "0x0000000000000000000000000000000000000000",
        },
        this.oracleHealth,
        isMaxOwnerProfile,
    );

    // cache the result for this order pair at the given block number
    if (typeof blockNumber === "bigint") {
        const state = OracleHealthMap.getOrCreate(this.oracleHealth, oracleUrl, order.owner);
        (state.cache ??= new Map()).set(cacheKey, { blockNumber, result });
    }

    if (result.isErr()) {
        return Result.err(result.error);
    }

    orderDetails.takeOrder.struct.signedContext = [result.value];
    return Result.ok(undefined);
}
