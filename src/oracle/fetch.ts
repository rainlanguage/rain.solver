import { Pair } from "../order/types";
import { SharedState } from "../state";
import { Result } from "../common";
import { extractOracleUrl, fetchSignedContext } from ".";

/**
 * If the order has oracle metadata, fetch signed context and inject it
 * into the takeOrder struct. Called with SharedState as `this` to access
 * the oracle health map.
 *
 * Returns Result — callers decide how to handle failures.
 */
export async function fetchOracleContext(
    this: SharedState,
    orderDetails: Pair,
): Promise<Result<void, string>> {
    const orderMeta = (orderDetails as any).meta;
    if (!orderMeta) return Result.ok(undefined);

    const oracleUrl = extractOracleUrl(orderMeta);
    if (!oracleUrl) return Result.ok(undefined);

    const result = await fetchSignedContext(
        oracleUrl,
        [
            {
                order: orderDetails.takeOrder.struct.order,
                inputIOIndex: orderDetails.takeOrder.struct.inputIOIndex,
                outputIOIndex: orderDetails.takeOrder.struct.outputIOIndex,
                counterparty: "0x0000000000000000000000000000000000000000",
            },
        ],
        this.oracleHealth,
    );

    if (result.isErr()) {
        return Result.err(result.error);
    }

    orderDetails.takeOrder.struct.signedContext = result.value;
    return Result.ok(undefined);
}
