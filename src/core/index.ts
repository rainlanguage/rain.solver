import { Result } from "../common";
import { AppOptions } from "../config";
import { SharedState } from "../state";
import { OrderManager } from "../order";
import { WalletManager } from "../wallet";
import { findBestTrade, FindBestTradeArgs } from "./modes";
import { RainSolverLogger, SpanWithContext } from "../logger";
import { finalizeRound, initializeRound } from "./process/round";
import { processOrder, ProcessOrderArgs } from "./process/order";
import { FindBestTradeResult, ProcessOrderFailure, ProcessOrderSuccess } from "./types";

/**
 * The `RainSolver` class orchestrates the core umbrella logic for processing and settling
 * orders, it manages shared state, application configuration, order processing, and wallet
 * operations, providing high-level methods to process orders to find best trades for them
 * and broadcast them onchain.
 *
 * This class coordinates between the order manager and wallet manager to ensure that order
 * processing is performed concurrently, while respecting resource constraints. It exposes
 * methods for processing individual orders, finding optimal trades, and executing complete
 * processing rounds for batch of orders.
 *
 * The high-level methods of this class are exposed as public for easy access, while the internal
 * methods are defined in other files as standalone functions with `this` context and are used
 * to manage the flow of order processing and settlement.
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
    /** The logger instance */
    readonly logger?: RainSolverLogger;

    constructor(
        state: SharedState,
        appOptions: AppOptions,
        orderManager: OrderManager,
        walletManager: WalletManager,
        logger?: RainSolverLogger,
    ) {
        this.state = state;
        this.appOptions = appOptions;
        this.orderManager = orderManager;
        this.walletManager = walletManager;
        this.logger = logger;
    }

    /**
     * Processes the next batch of orders that order manager provides, found
     * transactions are processed concurrently with max concurrency always capped
     * at number of worker wallets that are free at any given point in time which
     * is managed by wallet manager.
     * @returns An object containing results and reports of the processed round
     */
    async processNextRound(roundSpanCtx?: SpanWithContext, shuffle = true) {
        const { settlements, checkpointReports } = await initializeRound.call(
            this,
            roundSpanCtx,
            shuffle,
        );
        const { results, reports } = await finalizeRound.call(this, settlements, roundSpanCtx);
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
