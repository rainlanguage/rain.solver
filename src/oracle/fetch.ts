import { Order, Pair } from "../order/types";
import { SharedState } from "../state";
import { Result } from "../common";
import { fetchSignedContext } from ".";

/**
 * If the order has an oracle URL, fetch signed context and inject it
 * into the takeOrder struct. Called with SharedState as `this` to access
 * the oracle health map.
 *
 * Returns Result — callers decide how to handle failures.
 */
export async function fetchOracleContext(
    this: SharedState,
    orderDetails: Pair,
): Promise<Result<void, string>> {
    const oracleUrl = orderDetails.oracleUrl;
    if (!oracleUrl) return Result.ok(undefined);

    // Oracle signed context only supported for V4 orders
    const order = orderDetails.takeOrder.struct.order;
    if (order.type !== Order.Type.V4) return Result.ok(undefined);

    const result = await fetchSignedContext(
        oracleUrl,
        {
            order: order as Order.V4,
            inputIOIndex: orderDetails.takeOrder.struct.inputIOIndex,
            outputIOIndex: orderDetails.takeOrder.struct.outputIOIndex,
            counterparty: "0x0000000000000000000000000000000000000000",
        },
        this.oracleHealth,
    );

    if (result.isErr()) {
        return Result.err(result.error);
    }

    orderDetails.takeOrder.struct.signedContext = [result.value];
    return Result.ok(undefined);
}
