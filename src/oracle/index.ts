import { Result } from "../common";
import { SharedState } from "../state";
import { AppOptions } from "../config";
import { Order, Pair } from "../order/types";
import { fetchSignedContext } from "./fetch";
import { Attributes } from "@opentelemetry/api";
import { OracleError, OracleErrorType } from "./error";
import { OracleConstants, OracleMarketHours } from "./types";

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
    spanAttributes: Attributes,
): Promise<Result<void, OracleError>> {
    const oracleUrl = orderDetails.oracleUrl;
    if (!oracleUrl) return Result.ok(undefined);

    // Oracle signed context only supported for V4 orders
    const order = orderDetails.takeOrder.struct.order;
    if (order.type !== Order.Type.V4) return Result.ok(undefined);

    // known oracles serve signed context only inside their market hours,
    // so skip the fetch out of market hours as it can only fail
    if (
        OracleConstants.isKnown(oracleUrl) &&
        !OracleMarketHours.isOpen(this.appOptions.oracleMarketHours)
    ) {
        return Result.err(
            new OracleError(
                `Oracle ${oracleUrl} is out of market hours, skipping`,
                OracleErrorType.OutOfMarketHours,
            ),
        );
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
        spanAttributes,
        isMaxOwnerProfile,
    );

    if (result.isErr()) {
        return Result.err(result.error);
    }

    orderDetails.takeOrder.struct.signedContext = [result.value];
    return Result.ok(undefined);
}
