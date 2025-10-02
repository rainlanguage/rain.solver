import { config } from "dotenv";
import { formatUnits } from "viem";
import { AppOptions } from "../config";
import { RainSolver } from "../core";
import { OrderManager } from "../order";
import { OptionValues } from "commander";
import { ChainId, ChainKey } from "sushi";
import { WalletManager, WalletType } from "../wallet";
import { sleep, withBigintSerializer } from "../common";
import { ErrorSeverity, errorSnapshot } from "../error";
import { SharedState, SharedStateConfig } from "../state";
import { SubgraphConfig, SubgraphManager } from "../subgraph";
import { PreAssembledSpan, RainSolverLogger } from "../logger";
import { Context, context, Span, SpanStatusCode, trace } from "@opentelemetry/api";

config();

// re-export commands
export * from "./commands";

/** Represents the duration of a day in milliseconds */
export const DAY = 24 * 60 * 60 * 1000;

/**
 * The `RainSolverCli` class serves as the main entry point and orchestrator for the
 * Rain Solver CLI application.
 *
 * This class is responsible for initializing and managing the application's core
 * sub-components, including shared state, configuration options, order and wallet
 * managers, subgraph manager, and the RainSolver engine itself. It provides a robust
 * main loop for processing rounds of operations, handling telemetry, error reporting,
 * and operational metrics.
 *
 * Key responsibilities include:
 * - Parsing CLI arguments and yaml configuration file
 * - Initializing and injecting dependencies for all major subsystems
 * - Managing the main processing loop, including order processing, wallet operations, etc
 * - Reporting telemetry and operational metrics for observability and debugging
 * - Handling error scenarios gracefully and ensuring proper shutdown procedures
 */
export class RainSolverCli {
    /** The shared state instance */
    readonly state: SharedState;
    /** The app options, i.e. yaml config */
    readonly appOptions: AppOptions;
    /** The order manager instance */
    readonly orderManager: OrderManager;
    /** The wallet manager instance */
    readonly walletManager: WalletManager;
    /** The subgraph manager instance */
    readonly subgraphManager: SubgraphManager;
    /** The RainSolver instance */
    readonly rainSolver: RainSolver;
    /** The logger instance */
    readonly logger: RainSolverLogger;

    /** The average gas cost across rounds */
    avgGasCost: bigint | undefined;
    /** Keeps the current round count */
    roundCount = 1;

    private nextGasReset = Date.now() + DAY;
    private nextDatafetcherReset: number;

    private constructor(
        state: SharedState,
        appOptions: AppOptions,
        orderManager: OrderManager,
        walletManager: WalletManager,
        subgraphManager: SubgraphManager,
        rainSolver: RainSolver,
        logger: RainSolverLogger,
        nextDatafetcherReset: number,
    ) {
        this.state = state;
        this.appOptions = appOptions;
        this.orderManager = orderManager;
        this.walletManager = walletManager;
        this.subgraphManager = subgraphManager;
        this.rainSolver = rainSolver;
        this.logger = logger;
        this.nextDatafetcherReset = nextDatafetcherReset;
    }

    /**
     * Initializes the RainSolver CLI application, it sets up logging, parses
     * CLI arguments and config files, initializes shared state, checks subgraph
     * health, and sets up order and wallet managers, it also handles telemetry
     * and error reporting at each step. Finally, it creates and returns a fully
     * configured RainSolverCli instance with all dependencies injected and ready
     * to use.
     * @param argv - The array of command-line arguments passed to the CLI.
     */
    static async init(cmdOptions: OptionValues) {
        // init logger
        const logger = new RainSolverLogger();

        // parse cli args and appOptions and init state
        // record the process as startup otel report
        const { appOptions, state } = await (async () => {
            const report = new PreAssembledSpan("startup");
            try {
                // parse cli args and config yaml
                const appOptionsResult = AppOptions.tryFromYamlPath(cmdOptions.config);
                if (appOptionsResult.isErr()) {
                    throw appOptionsResult.error;
                }
                const appOptions = appOptionsResult.value;

                // init state
                const stateConfig = await SharedStateConfig.tryFromAppOptions(appOptions);
                if (stateConfig.isErr()) {
                    throw stateConfig.error;
                }
                const state = new SharedState(stateConfig.value);

                report.setStatus({ code: SpanStatusCode.OK });
                report.end();
                logger.exportPreAssembledSpan(report);

                return { cmdOptions, appOptions, state };
            } catch (err: any) {
                const snapshot = await errorSnapshot("", err);
                report.setAttr("severity", ErrorSeverity.HIGH);
                report.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
                report.recordException(err);
                report.end();
                logger.exportPreAssembledSpan(report);

                return Promise.reject(err);
            }
        })();

        // init subgraph manager and check status
        const sgManagerConfig = SubgraphConfig.tryFromAppOptions(appOptions);
        const subgraphManager = new SubgraphManager(sgManagerConfig);
        const statusCheckResult = await subgraphManager.statusCheck();
        if (statusCheckResult.isOk()) {
            statusCheckResult.value.forEach((statusReport) =>
                logger.exportPreAssembledSpan(statusReport),
            );
        } else {
            // export the report and throw
            statusCheckResult.error.forEach((statusReport: any) =>
                logger.exportPreAssembledSpan(statusReport),
            );
            throw new Error("All subgraphs have indexing error");
        }

        // init order manager
        const orderManagerResult = await OrderManager.init(state, subgraphManager);
        if (orderManagerResult.isErr()) {
            // export the report and throw
            logger.exportPreAssembledSpan(orderManagerResult.error);
            throw new Error("Failed to get order details from subgraphs");
        }
        const { orderManager, report } = orderManagerResult.value;
        logger.exportPreAssembledSpan(report);

        // init wallet manager
        const { walletManager, reports } = await WalletManager.init(state);
        reports.forEach((statusReport) => logger.exportPreAssembledSpan(statusReport));

        // init rain solver
        const rainSolver = new RainSolver(state, appOptions, orderManager, walletManager, logger);

        return new RainSolverCli(
            state,
            appOptions,
            orderManager,
            walletManager,
            subgraphManager,
            rainSolver,
            logger,
            Date.now() + appOptions.poolUpdateInterval * 60 * 1000,
        );
    }

    /**
     * Runs the main processing loop for the RainSolverCli app, handling each round of operations
     * that revolve around processing orders, managing wallet interactions and reportings.
     *
     * In each iteration, this method starts a new tracing span for the round and reports meta
     * information, attempts to fund owned vaults, processes the next round while exporting relevant
     * reports and executes wallet ops.
     */
    async run() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            // start round span and get round ctx
            const roundSpan = this.logger.tracer.startSpan(`round-${this.roundCount}`);
            const roundCtx = trace.setSpan(context.active(), roundSpan);

            // report meta info
            await this.reportMetaInfoForRound(roundSpan);

            // check main wallet balance
            const checkBalanceReport = await this.walletManager.checkMainWalletBalance();
            this.logger.exportPreAssembledSpan(checkBalanceReport, roundCtx);

            try {
                // try funding owned vaults and report
                const fundOwnedVaultsReport = await this.walletManager.fundOwnedVaults();
                fundOwnedVaultsReport.forEach((report) => {
                    this.logger.exportPreAssembledSpan(report, roundCtx);
                });

                // reset data fetcher
                await this.maybeResetDataFetcher();

                // process round and export the reports
                await this.processOrdersForRound(roundSpan, roundCtx);

                // reset average gas cost
                this.maybeResetAvgGasCost();

                // run wallet operations for the round
                await this.runWalletOpsForRound(roundCtx);

                // record ok status if we reach here
                roundSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (err: any) {
                const snapshot = await errorSnapshot("", err);
                roundSpan.setAttribute("severity", ErrorSeverity.HIGH);
                roundSpan.setAttribute("didClear", false);
                roundSpan.recordException(err);
                roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }

            // sync orders to upstream
            try {
                const report = await this.orderManager.sync();
                this.logger.exportPreAssembledSpan(report, roundCtx); // export sync report
            } catch {
                roundSpan.addEvent("Failed to sync orders to upstream, will try again next round");
            }

            // report rpcs performance for round
            await this.reportRpcMetricsForRound(roundCtx);

            // eslint-disable-next-line no-console
            console.log(`Starting next round in ${this.appOptions.sleep / 1000} seconds...`, "\n");
            roundSpan.end();
            await sleep(this.appOptions.sleep);
            // give otel some time to export
            await sleep(3000);

            // increment round count
            this.roundCount++;

            // for preview CI
            // break out of the loop if in preview mode after specified number of rounds are executed
            if (
                process.env.IS_PREVIEW === "true" &&
                this.roundCount > Number(process.env.PREVIEW_ROUNDS ?? 1)
            ) {
                break;
            }
        }

        // flush and close the connection.
        await this.logger.shutdown();
    }

    /** Resets the average gas cost daily */
    maybeResetAvgGasCost() {
        const _now = Date.now();
        if (this.nextGasReset <= _now) {
            this.nextGasReset = _now + DAY;
            this.avgGasCost = this.state.avgGasCost;
            this.state.gasCosts = [];
        }
        this.avgGasCost = this.state.avgGasCost || this.avgGasCost;
    }

    /** Resets the DataFetcher (sushi router cached pool data) by the given interval */
    async maybeResetDataFetcher() {
        const now = Date.now();
        if (this.nextDatafetcherReset <= now) {
            this.nextDatafetcherReset = now + this.appOptions.poolUpdateInterval * 60 * 1000;
            // reset only if the data fetcher is initialized successfully
            await this.state.router.sushi?.reset();
        }
    }

    /**
     * Performs the next round of processing orders batch and reports the results.
     * @param roundSpan - The otel span for the current round
     * @param roundCtx - The otel context for the current round
     */
    async processOrdersForRound(roundSpan: Span, roundCtx: Context) {
        // process round and export the reports
        const { results, checkpointReports } = await this.rainSolver.processNextRound({
            span: roundSpan,
            context: roundCtx,
        });
        const successTxs: string[] = [];
        const failedTxs: string[] = [];
        results.forEach((v) => {
            if (v.isOk()) {
                if (v.value.txUrl) successTxs.push(v.value.txUrl);
            } else if (v.error.txUrl) {
                failedTxs.push(v.error.txUrl);
            }
        });
        if (successTxs.length > 0 || failedTxs.length > 0) {
            roundSpan.setAttribute("foundOpp", true);
        }
        roundSpan.setAttribute("txUrls.success", successTxs);
        roundSpan.setAttribute("txUrls.failed", failedTxs);
        roundSpan.setAttribute(
            "ordersMetadata.roundProcessedOrderPairsCount",
            checkpointReports.length,
        );
        const ordersMetadata = this.orderManager.getCurrentMetadata();
        for (const key in ordersMetadata) {
            roundSpan.setAttribute(
                `ordersMetadata.${key}`,
                ordersMetadata[key as keyof typeof ordersMetadata],
            );
        }
    }

    /**
     * Performs and reports wallet operations for the current round, the operations
     * include retrying pending workers to be added into circulation, assessing workers
     * for removal and sweeping wallets funds.
     * @param roundCtx - The otel context for the current round
     */
    async runWalletOpsForRound(roundCtx: Context) {
        // retry pending add workers
        const retryPendingAddReports = await this.walletManager.retryPendingAddWorkers();
        retryPendingAddReports.forEach((report) => {
            this.logger.exportPreAssembledSpan(report, roundCtx);
        });

        // assess workers
        const assessReports = await this.walletManager.assessWorkers();
        assessReports.forEach((report) => {
            this.logger.exportPreAssembledSpan(report.removeWorkerReport, roundCtx);
            this.logger.exportPreAssembledSpan(report.addWorkerReport, roundCtx);
        });

        // retry wallet removals and sweep funds once every 250 rounds
        if (this.roundCount % 250 === 0) {
            // retry pending remove workers
            const pendingRemoveReports = await this.walletManager.retryPendingRemoveWorkers();
            pendingRemoveReports.forEach((report) => {
                this.logger.exportPreAssembledSpan(report, roundCtx);
            });

            // try to sweep main wallet's tokens back to gas
            const convertHoldingsToGasReport = await this.walletManager.convertHoldingsToGas();
            this.logger.exportPreAssembledSpan(convertHoldingsToGasReport, roundCtx);

            // re-evaluate owner limits
            await this.orderManager.downscaleProtection();
        }
    }

    /**
     * Reports RPC metrics for the current round
     * @param roundCtx - The otel context for the current round
     */
    async reportRpcMetricsForRound(roundCtx: Context) {
        for (const rpc in this.state.rpc.metrics) {
            await this.logger.tracer.startActiveSpan("rpc-report", {}, roundCtx, async (span) => {
                const record = this.state.rpc.metrics[rpc];
                span.setAttributes({
                    "rpc-url": rpc,
                    "request-count": record.req,
                    "success-count": record.success,
                    "failure-count": record.failure,
                    "timeout-count": record.timeout,
                    "avg-request-interval": record.avgRequestIntervals,
                    "latest-success-rate": record.progress.successRate / 100,
                    "selection-weight": record.progress.selectionWeight,
                });
                record.reset();
                span.end();
            });
        }
        // report write rpcs performance
        if (this.state.writeRpc) {
            for (const rpc in this.state.writeRpc.metrics) {
                await this.logger.tracer.startActiveSpan(
                    "rpc-report",
                    {},
                    roundCtx,
                    async (span) => {
                        const record = this.state.writeRpc!.metrics[rpc];
                        span.setAttributes({
                            "rpc-url": rpc,
                            "request-count": record.req,
                            "success-count": record.success,
                            "failure-count": record.failure,
                            "timeout-count": record.timeout,
                            "avg-request-interval": record.avgRequestIntervals,
                            "latest-success-rate": record.progress.successRate / 100,
                            "selection-weight": record.progress.selectionWeight,
                        });
                        record.reset();
                        span.end();
                    },
                );
            }
        }
    }

    /**
     * Reports metadata information for the current round
     * @param roundSpan - The otel span for the current round
     */
    async reportMetaInfoForRound(roundSpan: Span) {
        roundSpan.setAttributes({
            "meta.chain": ChainKey[this.state.chainConfig.id as ChainId],
            "meta.chainId": this.state.chainConfig.id,
            "meta.sgs": this.subgraphManager.subgraphs,
            "meta.contracts.v4": this.state.contracts.v4
                ? JSON.stringify(this.state.contracts.v4)
                : "N/A",
            "meta.contracts.v5": this.state.contracts.v5
                ? JSON.stringify(this.state.contracts.v5)
                : "N/A",
            "meta.orderbooks": Array.from(await this.subgraphManager.getOrderbooks()),
            "meta.mainAccount": this.walletManager.mainWallet.address,
            "meta.gitCommitHash": process?.env?.GIT_COMMIT ?? "N/A",
            "meta.dockerTag": process?.env?.DOCKER_TAG ?? "N/A",
            "meta.trackedTokens": JSON.stringify(Array.from(this.state.watchedTokens.values())),
            "meta.configurations": JSON.stringify(
                {
                    ...this.appOptions,
                    key: this.appOptions.key ? "***" : "N/A",
                    mnemonic: this.appOptions.mnemonic ? "***" : "N/A",
                },
                withBigintSerializer,
            ),
        });

        // report worker wallet balances
        if (this.walletManager.config.type === WalletType.Mnemonic) {
            roundSpan.setAttribute(
                "circulatingAccounts",
                JSON.stringify(
                    await this.walletManager.getWorkerWalletsBalance(),
                    withBigintSerializer,
                ),
            );
            roundSpan.setAttribute(
                "lastAccountIndex",
                this.walletManager.workers.lastUsedDerivationIndex,
            );
        }

        // report avg gas cost
        if (this.avgGasCost) {
            roundSpan.setAttribute("avgGasCost", formatUnits(this.avgGasCost, 18));
        }
    }
}
