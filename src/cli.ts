import { config } from "dotenv";
import { Command } from "commander";
import { clear } from ".";
import { AppOptions } from "./config";
import { BigNumber, ethers } from "ethers";
import { RainSolverLogger } from "./logger";
import { sleep, withBigintSerializer } from "./utils";
import { ErrorSeverity, errorSnapshot } from "./error";
import { getDataFetcher, getMetaInfo } from "./client";
import { SharedState, SharedStateConfig } from "./state";
import { SubgraphManager, SubgraphConfig } from "./subgraph";
import { BotConfig, ProcessPairReportStatus } from "./types";
import { OrderManager, BundledOrders } from "./order";
import { trace, Tracer, context, Context, SpanStatusCode } from "@opentelemetry/api";
import { getBatchEthBalance } from "./account";
import { WalletManager, WalletType } from "./wallet";
import { publicClientConfig } from "sushi/config";

config();

const getOptions = async (argv: any, version?: string) => {
    const cmdOptions = new Command("node rain-solver")
        .option(
            "-c, --config <path>",
            "Path to config yaml file, can be set in 'CONFIG' env var instead, if none is given looks for ./config.yaml in workspace root directory",
            process.env.CONFIG || "./config.yaml",
        )
        .description(
            [
                "A NodeJS app to find and take arbitrage trades for Rain Orderbook orders against some DeFi liquidity providers, requires NodeJS v18 or higher.",
                '- Use "node rain-solver [options]" command alias for running the app from its repository workspace',
                '- Use "rain-solver [options]" command alias when this app is installed as a dependency in another project',
            ].join("\n"),
        )
        .alias("rain-solver")
        .version(version ?? "0.0.0")
        .parse(argv)
        .opts();

    return cmdOptions;
};

export const arbRound = async (
    tracer: Tracer,
    roundCtx: Context,
    options: AppOptions,
    config: BotConfig,
    bundledOrders: BundledOrders[][],
    state: SharedState,
) => {
    return await tracer.startActiveSpan("process-orders", {}, roundCtx, async (span) => {
        const ctx = trace.setSpan(context.active(), span);
        options;
        try {
            let txs;
            let foundOpp = false;
            let didClear = false;
            const { reports = [], avgGasCost = undefined } = await clear(
                config,
                bundledOrders,
                state,
                tracer,
                ctx,
            );
            if (reports && reports.length) {
                txs = reports.map((v) => v.txUrl).filter((v) => !!v);
                if (txs.length) {
                    foundOpp = true;
                    span.setAttribute("txUrls", txs);
                    span.setAttribute("foundOpp", true);
                } else if (
                    reports.some((v) => v.status === ProcessPairReportStatus.FoundOpportunity)
                ) {
                    foundOpp = true;
                    span.setAttribute("foundOpp", true);
                }
                if (
                    reports.some(
                        (v) => v.status === ProcessPairReportStatus.FoundOpportunity && !v.reason,
                    )
                ) {
                    didClear = true;
                    span.setAttribute("didClear", true);
                }
            } else {
                span.setAttribute("didClear", false);
            }
            if (avgGasCost) {
                span.setAttribute("avgGasCost", ethers.utils.formatUnits(avgGasCost));
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return { txs, foundOpp, didClear, avgGasCost };
        } catch (e: any) {
            if (e?.startsWith?.("Failed to batch quote orders")) {
                span.setAttribute("severity", ErrorSeverity.LOW);
                span.setStatus({ code: SpanStatusCode.ERROR, message: e });
            } else {
                const snapshot = errorSnapshot("Unexpected error occurred", e);
                span.setAttribute("severity", ErrorSeverity.HIGH);
                span.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }
            span.recordException(e);
            span.setAttribute("didClear", false);
            span.setAttribute("foundOpp", false);
            span.end();
            return { txs: [], foundOpp: false, didClear: false, avgGasCost: undefined };
        }
    });
};

/**
 * CLI startup function
 * @param argv - cli args
 */
export async function startup(argv: any, version?: string) {
    const cmdOptions = await getOptions(argv, version);
    const options = AppOptions.fromYaml(cmdOptions.config);
    const roundGap = options.sleep;

    // init state
    const stateConfig = await SharedStateConfig.tryFromAppOptions(options);
    const state = new SharedState(stateConfig);

    // get config
    const config: BotConfig = {
        ...options,
        lps: state.liquidityProviders!,
        viemClient: state.client,
        dispair: state.dispair,
        nativeWrappedToken: state.chainConfig.nativeWrappedToken,
        routeProcessors: state.chainConfig.routeProcessors,
        stableTokens: state.chainConfig.stableTokens,
        isSpecialL2: state.chainConfig.isSpecialL2,
        chain: publicClientConfig[state.chainConfig.id as keyof typeof publicClientConfig].chain,
        dataFetcher: state.dataFetcher,
    } as any;

    return {
        roundGap,
        options,
        poolUpdateInterval: options.poolUpdateInterval * 60 * 1000,
        config,
        state,
    };
}

export const main = async (argv: any, version?: string) => {
    const logger = new RainSolverLogger();

    // parse cli args and startup bot configuration
    const { roundGap, options, poolUpdateInterval, config, state } =
        await logger.tracer.startActiveSpan("startup", async (startupSpan) => {
            try {
                const result = await startup(argv, version);
                startupSpan.setStatus({ code: SpanStatusCode.OK });
                startupSpan.end();
                return result;
            } catch (e: any) {
                const snapshot = errorSnapshot("", e);
                startupSpan.setAttribute("severity", ErrorSeverity.HIGH);
                startupSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
                startupSpan.recordException(e);

                // end this span and wait for it to finish
                startupSpan.end();
                await sleep(20000);

                // reject the promise that makes the cli process to exit with error
                return Promise.reject(e);
            }
        });

    // init subgraph manager and check status
    const sgManagerConfig = SubgraphConfig.tryFromAppOptions(options);
    const subgraphManager = new SubgraphManager(sgManagerConfig);
    try {
        const report = await subgraphManager.statusCheck();
        report.forEach((statusReport) => logger.exportPreAssembledSpan(statusReport));
    } catch (error: any) {
        // export the report and throw
        error.forEach((statusReport: any) => logger.exportPreAssembledSpan(statusReport));
        throw new Error("All subgraphs have indexing error");
    }

    // init order manager
    const orderManager = await (async () => {
        try {
            const { orderManager, report } = await OrderManager.init(state, subgraphManager);
            logger.exportPreAssembledSpan(report);
            return orderManager;
        } catch (error: any) {
            // export the report and throw
            logger.exportPreAssembledSpan(error);
            throw new Error("Failed to get order details from subgraphs");
        }
    })();

    const { walletManager, reports } = await WalletManager.init(state);
    reports.forEach((statusReport) => logger.exportPreAssembledSpan(statusReport));

    // set config main acc and workers
    config.mainAccount = walletManager.mainSigner;
    config.accounts = Array.from(walletManager.workers.signers.values());

    const day = 24 * 60 * 60 * 1000;
    let lastGasReset = Date.now() + day;
    let lastInterval = Date.now() + poolUpdateInterval;
    let avgGasCost: BigNumber | undefined;
    let counter = 1;

    // run bot's processing orders in a loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await logger.tracer.startActiveSpan(`round-${counter}`, async (roundSpan) => {
            const roundCtx = trace.setSpan(context.active(), roundSpan);
            const newMeta = await getMetaInfo(config, subgraphManager);
            roundSpan.setAttributes({
                ...newMeta,
                "meta.mainAccount": config.mainAccount.account.address,
                "meta.gitCommitHash": process?.env?.GIT_COMMIT ?? "N/A",
                "meta.dockerTag": process?.env?.DOCKER_TAG ?? "N/A",
                "meta.trackedTokens": JSON.stringify(Array.from(state.watchedTokens.values())),
                "meta.configurations": JSON.stringify(
                    {
                        ...options,
                        key: options.key ? "***" : "N/A",
                        mnemonic: options.mnemonic ? "***" : "N/A",
                    },
                    withBigintSerializer,
                ),
            });

            // check main wallet balance
            const checkBalanceReport = await walletManager.checkMainWalletBalance();
            logger.exportPreAssembledSpan(checkBalanceReport, roundCtx);

            // remove pool memoizer cache on each interval
            let update = false;
            const now = Date.now();
            if (lastInterval <= now) {
                lastInterval = now + poolUpdateInterval;
                update = true;
            }
            try {
                const bundledOrders = orderManager.getNextRoundOrders();
                if (update) {
                    const freshdataFetcher = await getDataFetcher(state);
                    state.dataFetcher = freshdataFetcher;
                    config.dataFetcher = state.dataFetcher;
                }
                roundSpan.setAttribute("details.rpc", state.rpc.urls);
                const roundResult = await arbRound(
                    logger.tracer,
                    roundCtx,
                    options,
                    config,
                    bundledOrders,
                    state,
                );
                let txs, foundOpp, didClear, roundAvgGasCost;
                if (roundResult) {
                    txs = roundResult.txs;
                    foundOpp = roundResult.foundOpp;
                    didClear = roundResult.didClear;
                    roundAvgGasCost = roundResult.avgGasCost;
                }
                if (txs && txs.length) {
                    roundSpan.setAttribute("txUrls", txs);
                    roundSpan.setAttribute("foundOpp", true);
                } else if (didClear) {
                    roundSpan.setAttribute("foundOpp", true);
                    roundSpan.setAttribute("didClear", true);
                } else if (foundOpp) {
                    roundSpan.setAttribute("foundOpp", true);
                    roundSpan.setAttribute("didClear", false);
                } else {
                    roundSpan.setAttribute("foundOpp", false);
                    roundSpan.setAttribute("didClear", false);
                }

                // fecth account's balances
                if (foundOpp && config.accounts.length) {
                    try {
                        const balances = await getBatchEthBalance(
                            config.accounts.map((v) => v.account.address),
                            state.client,
                        );
                        config.accounts.forEach((v, i) => (v.BALANCE = balances[i]));
                    } catch {
                        /**/
                    }
                }

                // keep avg gas cost
                if (roundAvgGasCost) {
                    const _now = Date.now();
                    if (lastGasReset <= _now) {
                        lastGasReset = _now + day;
                        avgGasCost = undefined;
                        state.gasCosts = [roundAvgGasCost.toBigInt()];
                    } else {
                        state.gasCosts.push(roundAvgGasCost.toBigInt());
                    }
                    avgGasCost = ethers.BigNumber.from(state.avgGasCost);
                }

                // retry pending add workers
                const retryPendingAddReports = await walletManager.retryPendingAddWorkers();
                retryPendingAddReports.forEach((report) => {
                    logger.exportPreAssembledSpan(report, roundCtx);
                });

                // assess workers
                const assessReports = await walletManager.assessWorkers();
                assessReports.forEach((report) => {
                    logger.exportPreAssembledSpan(report.removeWorkerReport, roundCtx);
                    logger.exportPreAssembledSpan(report.addWorkerReport, roundCtx);
                });
                config.accounts = Array.from(walletManager.workers.signers.values());

                if (counter % 100 === 0) {
                    // retry pending remove workers
                    const pendingRemoveReports = await walletManager.retryPendingRemoveWorkers();
                    pendingRemoveReports.forEach((report) => {
                        logger.exportPreAssembledSpan(report, roundCtx);
                    });

                    // try to sweep main wallet's tokens back to gas
                    const convertHoldingsToGasReport = await walletManager.convertHoldingsToGas();
                    logger.exportPreAssembledSpan(convertHoldingsToGasReport, roundCtx);
                }

                roundSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (error: any) {
                const snapshot = errorSnapshot("", error);
                roundSpan.setAttribute("severity", ErrorSeverity.HIGH);
                roundSpan.setAttribute("didClear", false);
                roundSpan.recordException(error);
                roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: snapshot });
            }
            if (walletManager.config.type === WalletType.Mnemonic) {
                const accountsWithBalance: Record<string, string> = {};
                config.accounts.forEach(
                    (v) =>
                        (accountsWithBalance[v.account.address] = ethers.utils.formatUnits(
                            v.BALANCE,
                        )),
                );
                roundSpan.setAttribute("circulatingAccounts", JSON.stringify(accountsWithBalance));
                roundSpan.setAttribute(
                    "lastAccountIndex",
                    walletManager.workers.lastUsedDerivationIndex,
                );
            }
            if (avgGasCost) {
                roundSpan.setAttribute("avgGasCost", ethers.utils.formatUnits(avgGasCost));
            }

            try {
                const report = await orderManager.sync();
                logger.exportPreAssembledSpan(report, roundCtx); // export sync report
            } catch {
                /**/
            }

            // report rpcs performance for round
            for (const rpc in state.rpc.metrics) {
                await logger.tracer.startActiveSpan("rpc-report", {}, roundCtx, async (span) => {
                    const record = state.rpc.metrics[rpc];
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
            if (state.writeRpc) {
                for (const rpc in state.writeRpc.metrics) {
                    await logger.tracer.startActiveSpan(
                        "rpc-report",
                        {},
                        roundCtx,
                        async (span) => {
                            const record = state.writeRpc!.metrics[rpc];
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

            // eslint-disable-next-line no-console
            console.log(`Starting next round in ${roundGap / 1000} seconds...`, "\n");
            roundSpan.end();
            await sleep(roundGap);
            // give otel some time to export
            await sleep(3000);
        });
        counter++;

        // for preview CI
        // break out of the loop if in prod preview mode
        // after specified number of rounds are executed
        if (
            process?.env?.IS_PREVIEW === "true" &&
            counter > Number(process?.env?.PREVIEW_ROUNDS ?? 1)
        ) {
            break;
        }
    }

    // flush and close the connection.
    await logger.shutdown();
};
