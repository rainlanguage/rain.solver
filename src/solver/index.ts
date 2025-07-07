import { Result } from "../result";
import { AppOptions } from "../config";
import { SharedState } from "../state";
import { OrderManager } from "../order";
import { WalletManager } from "../wallet";
import { findBestTrade, FindBestTradeArgs } from "./modes";
import { finalizeRound, initializeRound } from "./process/round";
import { processOrder, ProcessOrderArgs } from "./process/order";
import { FindBestTradeResult, ProcessOrderFailure, ProcessOrderSuccess } from "./types";

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

    constructor(
        state: SharedState,
        appOptions: AppOptions,
        orderManager: OrderManager,
        walletManager: WalletManager,
    ) {
        this.state = state;
        this.appOptions = appOptions;
        this.orderManager = orderManager;
        this.walletManager = walletManager;
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

    /**
     * Processes an order trying to find an opportunity to clear it
     * @param args - The arguments for processing the order
     * @returns A function that returns the result of processing the order
     */
    async processOrder(
        args: ProcessOrderArgs,
    ): Promise<() => Promise<Result<ProcessOrderSuccess, ProcessOrderFailure>>> {
        return processOrder.call(this, args);
    }

    /**
     * Finds the most profitable trade transaction for the given order to be
     * broadcasted onchain, it calls the `findBestTrade` function with `this`
     * context and the provided arguments.
     * @param args - The arguments required to find the best trade
     */
    async findBestTrade(args: FindBestTradeArgs): Promise<FindBestTradeResult> {
        return findBestTrade.call(this, args);
    }
}
