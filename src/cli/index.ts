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
import { EventSyncManager } from "../events/manager";
import { PreAssembledSpan, RainSolverLogger, redactException, redactUrl } from "../logger";
import { Context, context, Span, SpanStatusCode, trace } from "@opentelemetry/api";

config();

// re-export commands
export * from "./commands";
export { main } from "./main";

/** Represents the duration of a minute in milliseconds */
export const MINUTE = 60 * 1000;

/** Represents the duration of a day in milliseconds */
export const DAY = 24 * 60 * MINUTE;

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
    /**
     * The log sync of every orderbook that the subgraphs index. The orders and
     * the vault balances follow the chain logs, and the subgraphs only give the
     * startup snapshot.
     */
    eventSync?: EventSyncManager;

    /** The average gas cost across rounds */
    avgGasCost: bigint | undefined;
    /** Keeps the current round count */
    roundCount = 1;

    private nextGasReset = Date.now() + DAY;
    private nextDatafetcherReset: number;

    /** Wallet sweeper timer (once every 5 days) */
    private nextSweepTime: number;
    /** Convert bounties to gas timer (once every day) */
    private nextGasConversionTime: number;
    /** Time for next worker wallet assessment */
    private nextAssesWorkerWalletTime = Date.now() + 15 * MINUTE;
    /** Time for next wallet balance check */
    private nextCheckWalletBalanceTime: number;
    /** The last main wallet balance check report, re-exported on rounds that skip the check */
    prevMainWalletBalanceReport?: PreAssembledSpan;
    /** The last worker wallets balances, re-reported on rounds that skip the check */
    prevMultiWalletBalanceReports?: Record<string, bigint>;
    /** The in flight round finalizations, they run in the background while the next rounds start */
    pendingRoundFinalizations = new Set<Promise<void>>();

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
        const now = Date.now();
        this.state = state;
        this.appOptions = appOptions;
        this.orderManager = orderManager;
        this.walletManager = walletManager;
        this.subgraphManager = subgraphManager;
        this.rainSolver = rainSolver;
        this.logger = logger;
        this.nextDatafetcherReset = nextDatafetcherReset;
        this.nextSweepTime =
            appOptions.sweepWalletTime === 0 ? 0 : now + appOptions.sweepWalletTime * DAY;
        this.nextGasConversionTime =
            appOptions.convertToGasTime === 0 ? 0 : now + appOptions.convertToGasTime * DAY;
        this.nextCheckWalletBalanceTime =
            appOptions.checkWalletBalanceTime === 0
                ? 0
                : now + appOptions.checkWalletBalanceTime * MINUTE;
    }

    /**
     * Initializes the RainSolver CLI application, it sets up logging, parses
     * CLI arguments and config files, initializes shared state, checks subgraph
     * health, and sets up order and wallet managers, it also handles telemetry
     * and error reporting at each step. Finally, it creates and returns a fully
     * configured RainSolverCli instance with all dependencies injected and ready
     * to use.
     * @param cmdOptions - Parsed command-line arguments
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

                return { appOptions, state };
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

        // init order manager. The orders of every orderbook that the subgraphs
        // index follow the chain logs, see the events module. The subgraphs only
        // give the startup snapshot
        const orderManager = new OrderManager(state, subgraphManager);
        const eventSync = await EventSyncManager.init({
            state,
            orderManager,
            subgraphManager,
            filters: sgManagerConfig.filters,
        });

        // the orderbooks of a subgraph that does not answer are left out, the
        // bot runs with the others, it fails when no subgraph answers
        if (eventSync.failedSubgraphs.length) {
            const failedReport = new PreAssembledSpan("log-sync-subgraphs");
            failedReport.setAttr("failedSubgraphs", eventSync.failedSubgraphs);
            failedReport.setAttr("severity", ErrorSeverity.HIGH);
            failedReport.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Some subgraphs did not give their orderbooks, those are not synced",
            });
            failedReport.end();
            logger.exportPreAssembledSpan(failedReport);
            if (eventSync.failedSubgraphs.length === subgraphManager.subgraphs.length) {
                throw new Error("Failed to get the orderbooks from the subgraphs");
            }
        }

        // nothing of the log sync or of the block watcher outlives an init
        // that fails from here on
        try {
            // the log stream opens before the block watcher starts. The block
            // watcher keeps the current block number in the state without repeated
            // rpc calls. Without a ws rpc, it polls at the block time of the chain
            eventSync.open();
            state.watchBlockNumber(appOptions.blockTime);

            // start the log sync, it fetches the snapshot from the subgraphs once
            // enough blocks are buffered, and it goes live after that. An orderbook
            // that does not go live in time tries again in the background, also
            // when none goes live, so the bot does not exit behind a subgraph
            // that lags
            const startReport = new PreAssembledSpan("log-sync-start");
            startReport.setAttr("mode", eventSync.mode);
            startReport.setAttr("orderbooks", eventSync.orderbooks);
            const { reports: syncReports, failed } = await eventSync.start();
            for (const [orderbook, report] of syncReports) {
                startReport.setAttr(
                    `sync.${orderbook}`,
                    JSON.stringify(report, withBigintSerializer),
                );
            }
            for (const [orderbook, error] of failed) {
                startReport.setAttr(`failed.${orderbook}`, error);
            }
            if (failed.size) {
                startReport.setAttr("severity", ErrorSeverity.HIGH);
                startReport.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: syncReports.size
                        ? "Some orderbooks did not go live, they try again in the background"
                        : "No orderbook went live, they try again in the background",
                });
            } else {
                startReport.setStatus({ code: SpanStatusCode.OK });
            }
            startReport.end();
            logger.exportPreAssembledSpan(startReport);

            await orderManager.downscaleProtection();

            // init wallet manager
            const { walletManager, reports } = await WalletManager.init(state);
            reports.forEach((statusReport) => logger.exportPreAssembledSpan(statusReport));

            // init rain solver
            const rainSolver = new RainSolver(
                state,
                appOptions,
                orderManager,
                walletManager,
                logger,
            );

            const cli = new RainSolverCli(
                state,
                appOptions,
                orderManager,
                walletManager,
                subgraphManager,
                rainSolver,
                logger,
                Date.now() + appOptions.poolUpdateInterval * 60 * 1000,
            );
            cli.eventSync = eventSync;
            return cli;
        } catch (error) {
            eventSync.close();
            state.unwatchBlockNumber();
            throw error;
        }
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

            // report meta info, it runs alongside the round and the round finalization
            // awaits it before ending the span, so the meta attributes are not lost
            const metaInfoPromise = this.reportMetaInfoForRound(roundSpan).catch(async (err) => {
                roundSpan.setAttribute(
                    "meta.error",
                    await errorSnapshot("failed to report round meta info", err),
                );
            });

            const now = Date.now();

            // check wallet balances upon configured intervals
            let checkMainWalletBalancePromise = undefined;
            let getWorkerWalletsBalancePromise = undefined;
            if (
                this.roundCount === 1 ||
                (this.nextCheckWalletBalanceTime !== 0 && this.nextCheckWalletBalanceTime <= now)
            ) {
                // update interval
                if (this.roundCount > 1) {
                    this.nextCheckWalletBalanceTime =
                        now + this.appOptions.checkWalletBalanceTime * MINUTE;
                }

                // check main wallet balance
                checkMainWalletBalancePromise = this.walletManager.checkMainWalletBalance();

                // report worker wallet balances
                if (this.walletManager.config.type === WalletType.Mnemonic) {
                    getWorkerWalletsBalancePromise = this.walletManager.getWorkerWalletsBalance();
                    roundSpan.setAttribute(
                        "lastAccountIndex",
                        this.walletManager.workers.lastUsedDerivationIndex,
                    );
                }
            } else {
                if (this.prevMainWalletBalanceReport) {
                    this.prevMainWalletBalanceReport.startTime = now;
                    this.prevMainWalletBalanceReport.endTime = performance.now();
                    this.logger.exportPreAssembledSpan(this.prevMainWalletBalanceReport, roundCtx);
                }
                if (this.prevMultiWalletBalanceReports) {
                    roundSpan.setAttribute(
                        "circulatingAccounts",
                        JSON.stringify(this.prevMultiWalletBalanceReports, withBigintSerializer),
                    );
                    roundSpan.setAttribute(
                        "lastAccountIndex",
                        this.walletManager.workers.lastUsedDerivationIndex,
                    );
                }
            }

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

                // record ok status if we reach here
                roundSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (err: any) {
                const snapshot = await errorSnapshot("", err);
                roundSpan.setAttribute("severity", ErrorSeverity.HIGH);
                roundSpan.setAttribute("didClear", false);
                roundSpan.recordException(redactException(err));
                roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }

            // the log sync keeps the orders in step all the time, so the round
            // only reports where the sync stands, it runs alongside the rest of
            // the round finalization
            const syncOrdersPromise = this.reportLogSyncForRound(roundCtx).catch(() => {});

            // finalize the round in the background, the round span ends once all
            // the finalization operations settle, so the next round starts on time
            const finalization: Promise<void> = this.finalizeRound(
                roundSpan,
                roundCtx,
                syncOrdersPromise,
                checkMainWalletBalancePromise,
                getWorkerWalletsBalancePromise,
                metaInfoPromise,
            )
                .catch(() => {})
                .finally(() => this.pendingRoundFinalizations.delete(finalization));
            this.pendingRoundFinalizations.add(finalization);

            // eslint-disable-next-line no-console
            console.log(`Starting next round in ${this.appOptions.sleep / 1000} seconds...`, "\n");
            await sleep(this.appOptions.sleep);
            await syncOrdersPromise;

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

        // let every round finalize before flushing and closing the connection, as
        // spans that end after shutdown are dropped
        await Promise.allSettled(this.pendingRoundFinalizations);
        // close the log sync, its subscription, block listener and timers
        this.eventSync?.close();
        await this.logger.shutdown();
    }

    /**
     * Finalizes a round by running the post round operations concurrently, that
     * is the wallet operations, reporting rpc metrics and the pending wallet
     * balance checks, and ends the round span once all of them and the given
     * orders sync have settled, this is meant to run in the background, so the
     * next round does not wait for these operations to start
     * @param roundSpan - The round span
     * @param roundCtx - The round context
     * @param syncOrdersPromise - The in flight orders sync of the round, awaited by the caller too
     * @param checkMainWalletBalancePromise - The pending main wallet balance check, if any
     * @param getWorkerWalletsBalancePromise - The pending worker wallets balance read, if any
     * @param metaInfoPromise - The in flight round meta info report, if any, it sets the round
     * span meta attributes, so the span must not end before it
     */
    async finalizeRound(
        roundSpan: Span,
        roundCtx: Context,
        syncOrdersPromise: Promise<void>,
        checkMainWalletBalancePromise?: Promise<PreAssembledSpan>,
        getWorkerWalletsBalancePromise?: Promise<Record<string, bigint>>,
        metaInfoPromise?: Promise<void>,
    ) {
        try {
            // reset average gas cost
            this.maybeResetAvgGasCost();

            await Promise.all([
                syncOrdersPromise,
                metaInfoPromise,

                // run wallet operations for the round
                this.runWalletOpsForRound(roundCtx).catch(async (err) => {
                    const snapshot = await errorSnapshot("", err);
                    roundSpan.setAttribute("severity", ErrorSeverity.HIGH);
                    roundSpan.recordException(redactException(err));
                    roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
                }),

                // report rpcs performance for round
                this.reportRpcMetricsForRound(roundCtx).catch(() => {}),

                // report the main wallet balance check
                checkMainWalletBalancePromise
                    ?.then((checkBalanceReport) => {
                        this.logger.exportPreAssembledSpan(checkBalanceReport, roundCtx);
                        this.prevMainWalletBalanceReport = checkBalanceReport;
                    })
                    .catch(() => {}),

                // report the worker wallets balances
                getWorkerWalletsBalancePromise
                    ?.then((v) => {
                        roundSpan.setAttribute(
                            "circulatingAccounts",
                            JSON.stringify(v, withBigintSerializer),
                        );
                        this.prevMultiWalletBalanceReports = v;
                    })
                    .catch(() => {}),
            ]);
        } finally {
            // the span ends no matter what, the finalization runs in the
            // background and nothing awaits its failure
            roundSpan.end();
        }
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
        if (this.nextDatafetcherReset <= now || this.state.router.sushi?.signalReset) {
            this.nextDatafetcherReset = now + this.appOptions.poolUpdateInterval * 60 * 1000;
            // reset only if the data fetcher is initialized successfully
            const res = await this.state.router.sushi?.reset();
            if (res) this.state.router.reset();
        }
    }

    /**
     * Performs the next round of processing orders batch and reports the results.
     * @param roundSpan - The otel span for the current round
     * @param roundCtx - The otel context for the current round
     */
    async processOrdersForRound(roundSpan: Span, roundCtx: Context) {
        // process round and export the reports
        const { results, zeroLength, nonZeroLength } = await this.rainSolver.processNextRound({
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
            zeroLength + nonZeroLength,
        );
        roundSpan.setAttribute(
            "ordersMetadata.roundProcessedOrderPairsNonZeroCount",
            nonZeroLength,
        );
        roundSpan.setAttribute("ordersMetadata.roundProcessedOrderPairsZeroCount", zeroLength);
        for (const key in this.orderManager.metadata) {
            roundSpan.setAttribute(
                `ordersMetadata.${key}`,
                this.orderManager.metadata[key as keyof typeof this.orderManager.metadata],
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
        if (this.appOptions.rotateMultiWallet) {
            // retry pending add workers
            const retryPendingAddReports = await this.walletManager.retryPendingAddWorkers();
            retryPendingAddReports.forEach((report) => {
                this.logger.exportPreAssembledSpan(report, roundCtx);
            });

            // retry pending remove workers
            const pendingRemoveReports = await this.walletManager.retryPendingRemoveWorkers();
            pendingRemoveReports.forEach((report) => {
                this.logger.exportPreAssembledSpan(report, roundCtx);
            });
        }

        const now = Date.now();

        // assess workers
        if (this.nextAssesWorkerWalletTime <= now) {
            this.nextAssesWorkerWalletTime = now + 15 * MINUTE;
            const assessReports = await this.walletManager.assessWorkers();
            assessReports.forEach((report) => {
                if (report.removeWorkerReport)
                    this.logger.exportPreAssembledSpan(report.removeWorkerReport, roundCtx);
                if (report.addWorkerReport)
                    this.logger.exportPreAssembledSpan(report.addWorkerReport, roundCtx);
                if (report.topupWorkerReport)
                    this.logger.exportPreAssembledSpan(report.topupWorkerReport, roundCtx);
            });

            // re-evaluate owner limits
            await this.orderManager.downscaleProtection();
        }

        if (this.nextSweepTime !== 0 && this.nextSweepTime <= now) {
            this.nextSweepTime = now + this.appOptions.sweepWalletTime * DAY;
            // sweep worker wallet bounties
            for (const [, worker] of this.walletManager.workers.signers) {
                await this.walletManager.sweepWallet(worker, false).then((report) => {
                    this.logger.exportPreAssembledSpan(report, roundCtx);
                });
            }
        }

        if (this.nextGasConversionTime !== 0 && this.nextGasConversionTime <= now) {
            this.nextGasConversionTime = now + this.appOptions.convertToGasTime * DAY;

            // try to sweep main wallet's tokens back to gas
            await this.walletManager.convertHoldingsToGas().then((convertHoldingsToGasReport) => {
                this.logger.exportPreAssembledSpan(convertHoldingsToGasReport, roundCtx);
            });
        }
    }

    /**
     * Reports where the log stream and the log sync of every orderbook stand for
     * the round, as a sync-orders span. An error of the stream, or an orderbook
     * that is not live, that has an error, or that failed an order or a log
     * since the previous round, marks the span as an error. A high severity
     * marks what needs the operator: a subgraph that did not give its
     * orderbooks at the start, an order that the bot dropped since the previous
     * round because it could not read its token or vault balance, and a log
     * sync that is out of sync for too long, see EventSyncManager.report. Does
     * nothing when there is no log sync
     * @param roundCtx - The otel context for the current round
     */
    async reportLogSyncForRound(roundCtx: Context): Promise<void> {
        if (!this.eventSync) return;
        const { mode, stream, orderbooks, failedSubgraphs } = this.eventSync.report();
        const report = new PreAssembledSpan("sync-orders");
        report.setAttr("mode", mode);
        report.setAttr("stream", JSON.stringify(stream));
        let healthy = !stream.lastError;
        let givenUp = false;
        let outOfSync = stream.outOfSync;
        for (const sync of orderbooks) {
            report.setAttr(`sync.${sync.orderbook}`, JSON.stringify(sync, withBigintSerializer));
            if (sync.phase !== "live" || sync.lastError || sync.startError) healthy = false;
            // the counts are totals since the start, a new failure, bad log or
            // given up order marks the round once
            if (sync.newFailures || sync.newBadLogs) healthy = false;
            if (sync.newGivenUp) givenUp = true;
            if (sync.outOfSync) outOfSync = true;
        }
        // each of these needs the operator
        const lost: string[] = [];
        if (failedSubgraphs.length) {
            report.setAttr("failedSubgraphs", failedSubgraphs);
            lost.push("some subgraphs did not give their orderbooks, those are not synced");
        }
        if (givenUp) {
            lost.push(
                "the bot dropped some orders because it could not read their token or vault balance",
            );
        }
        if (outOfSync) {
            lost.push(
                "the log sync is out of sync for too long, an orderbook is not live or the logs do not come in",
            );
        }
        if (lost.length) {
            report.setAttr("severity", ErrorSeverity.HIGH);
            report.setStatus({ code: SpanStatusCode.ERROR, message: lost.join(", and ") });
        } else if (healthy) {
            report.setStatus({ code: SpanStatusCode.OK });
        } else {
            report.setAttr("severity", ErrorSeverity.MEDIUM);
            report.setStatus({
                code: SpanStatusCode.ERROR,
                message: "an orderbook log sync is not live or reported an error",
            });
        }
        report.end();
        this.logger.exportPreAssembledSpan(report, roundCtx);
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
                    "rpc-url": redactUrl(rpc),
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
                            "isWriteRpc:": "true",
                            "rpc-url": redactUrl(rpc),
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
            "meta.contracts.v6": this.state.contracts.v6
                ? JSON.stringify(this.state.contracts.v6)
                : "N/A",
            "meta.orderbooks": this.eventSync?.orderbooks ?? [],
            "meta.mainAccount": this.walletManager.mainWallet.address,
            "meta.gitCommitHash": process?.env?.GIT_COMMIT ?? "N/A",
            "meta.dockerTag": process?.env?.DOCKER_TAG ?? "N/A",
            "meta.trackedTokens": JSON.stringify(Array.from(this.state.watchedTokens.values())),
            "meta.configurations": JSON.stringify(
                {
                    ...this.appOptions,
                    key: this.appOptions.key ? "***" : "N/A",
                    mnemonic: this.appOptions.mnemonic ? "***" : "N/A",
                    // rpc providers put the api keys in the urls
                    rpc: this.appOptions.rpc?.map((v) => ({ ...v, url: redactUrl(v.url) })),
                    writeRpc: this.appOptions.writeRpc?.map((v) => ({
                        ...v,
                        url: redactUrl(v.url),
                    })),
                    wsRpc: this.appOptions.wsRpc && redactUrl(this.appOptions.wsRpc),
                },
                withBigintSerializer,
            ),
            "meta.liquidityProviders": this.state.router.getLiquidityProvidersList(),
        });

        // report avg gas cost
        if (this.avgGasCost) {
            roundSpan.setAttribute("avgGasCost", formatUnits(this.avgGasCost, 18));
        }
    }
}
