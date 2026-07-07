import { Result } from "../common";
import { OracleError } from "./error";
import { SharedState } from "../state";
import { Order, Pair } from "../order/types";
import { fetchSignedContext } from "./fetch";

/**
 * If the order has an oracle URL, fetch signed context and inject it
 * into the takeOrder struct. Called with SharedState as `this` to access
 * the oracle health map.
 *
 * @returns Result that callers decide how to handle failures.
 */
export async function fetchOracleContext(
    this: SharedState,
    orderDetails: Pair,
    counterparty: `0x${string}` = "0x0000000000000000000000000000000000000000",
): Promise<Result<void, OracleError>> {
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
            counterparty,
        },
        this.oracleHealth,
    );

    if (result.isErr()) {
        return Result.err(result.error);
    }

    orderDetails.takeOrder.struct.signedContext = [result.value];
    return Result.ok(undefined);
}
