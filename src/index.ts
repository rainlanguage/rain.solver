import { versions } from "process";
import { SharedState } from "./state";
import { processOrders } from "./processOrders";
import { Context, Tracer } from "@opentelemetry/api";
import { RoundReport, BotConfig } from "./types";
import { BundledOrders } from "./order";

/**
 * Method to find and take arbitrage trades for Rain Orderbook orders against some liquidity providers
 * @param config - The configuration object
 * @param ordersDetails - The order details queried from subgraph
 * @param options - The options for clear, such as 'gasCoveragePercentage'
 * @param tracer
 * @param ctx
 * @returns The report of details of cleared orders
 */
export async function clear(
    config: BotConfig,
    bundledOrders: BundledOrders[][],
    state: SharedState,
    tracer: Tracer,
    ctx: Context,
): Promise<RoundReport> {
    const version = versions.node;
    const majorVersion = Number(version.slice(0, version.indexOf(".")));

    if (majorVersion >= 22) return await processOrders(config, bundledOrders, state, tracer, ctx);
    else throw `NodeJS v22 or higher is required for running the app, current version: ${version}`;
}
