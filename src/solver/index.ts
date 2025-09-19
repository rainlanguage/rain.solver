import { BotConfig } from "../types";
import { AppOptions } from "../config";
import { SharedState } from "../state";
import { OrderManager } from "../order";
import { WalletManager } from "../wallet";
import { finalizeRound, initializeRound } from "./process/round";

/**
 * RainSolver is the main class that orchestrates the Rain Orderbook solver logic
 */
export class RainSolver {
    /** The shared state instance */
    readonly state: SharedState;
    /** The app options, i.e. yaml config */
    readonly appOptions: AppOptions;
    /** The order manager instance */
    readonly orderManager: OrderManager;
    /** The wallet manager instance */
    readonly walletManager: WalletManager;

    /** @deprecated Temporary for backward compatibility */
    readonly config: BotConfig;

    constructor(
        state: SharedState,
        appOptions: AppOptions,
        orderManager: OrderManager,
        walletManager: WalletManager,
        config: BotConfig,
    ) {
        this.state = state;
        this.appOptions = appOptions;
        this.orderManager = orderManager;
        this.walletManager = walletManager;
        this.config = config;
    }

    /**
     * Processes the next batch of orders that order manager provides, found
     * transactions are processed concurrently with max concurrency always capped
     * at number of worker wallets that are free at any given point in time which
     * is managed by wallet manager.
     * @returns An object containing results and reports of the processed round
     */
    async processNextRound() {
        const { settlements, checkpointReports } = await initializeRound.call(this);
        const { results, reports } = await finalizeRound.call(this, settlements);
        return {
            results,
            reports,
            checkpointReports,
        };
    }
}
