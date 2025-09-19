import { versions } from "process";
import { AppOptions } from "./config";
import { SharedState } from "./state";
import { getDataFetcher } from "./client";
import { processOrders } from "./processOrders";
import { publicClientConfig } from "sushi/config";
import { Context, Tracer } from "@opentelemetry/api";
import { RoundReport, BotConfig } from "./types";
import { BundledOrders } from "./order";

/**
 * @deprecated
 *
 * Get the general and network configuration required for the bot to operate
 * @param options - App Options
 * @param state - App shared state
 * @returns The configuration object
 */
export async function getConfig(options: AppOptions, state: SharedState): Promise<BotConfig> {
    const config: any = {
        ...options,
        lps: state.liquidityProviders!,
        viemClient: state.client,
        dispair: state.dispair,
        nativeWrappedToken: state.chainConfig.nativeWrappedToken,
        routeProcessors: state.chainConfig.routeProcessors,
        stableTokens: state.chainConfig.stableTokens,
        isSpecialL2: state.chainConfig.isSpecialL2,
        chain: publicClientConfig[state.chainConfig.id as keyof typeof publicClientConfig].chain,
    };
    const dataFetcher = await getDataFetcher(state);
    config.dataFetcher = dataFetcher;

    return config;
}

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
