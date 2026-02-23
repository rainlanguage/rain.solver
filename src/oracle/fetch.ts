import { Pair } from "../order/types";
import { SharedState } from "../state";
import { extractOracleUrl, fetchSignedContext } from ".";

/**
 * If the order has oracle metadata, fetch signed context and inject it
 * into the takeOrder struct. Called with SharedState as `this` to access
 * the oracle health map.
 *
 * Failures are swallowed so quoting proceeds with empty signed context.
 */
export async function fetchOracleContext(
    this: SharedState,
    orderDetails: Pair,
): Promise<void> {
    const orderMeta = (orderDetails as any).meta;
    if (!orderMeta) return;

    const oracleUrl = extractOracleUrl(orderMeta);
    if (!oracleUrl) return;

    const signedContexts = await fetchSignedContext(
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

    orderDetails.takeOrder.struct.signedContext = signedContexts;
}
