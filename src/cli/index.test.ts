import { cmd } from "./cmd";
import { AppOptions } from "../config";
import { RainSolver } from "../solver";
import { OrderManager } from "../order";
import { RainSolverCli } from "./index";
import { RainSolverLogger } from "../logger";
import { WalletManager, WalletType } from "../wallet";
import { sleep, withBigintSerializer } from "../utils";
import { SharedState, SharedStateConfig } from "../state";
import { SubgraphConfig, SubgraphManager } from "../subgraph";
import { SpanStatusCode, trace, context } from "@opentelemetry/api";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

// mocks
vi.mock("./cmd", () => ({
    cmd: vi.fn(),
}));

vi.mock("../order", () => ({
    OrderManager: {
        init: vi.fn(),
    },
}));

vi.mock("../config", () => ({
    AppOptions: {
        fromYaml: vi.fn(),
    },
}));

vi.mock("../solver", () => ({
    RainSolver: vi.fn(),
}));

vi.mock("../state", () => ({
    SharedState: vi.fn(),
    SharedStateConfig: {
        tryFromAppOptions: vi.fn(),
    },
}));

vi.mock("../subgraph", () => ({
    SubgraphConfig: {
        tryFromAppOptions: vi.fn(),
    },
    SubgraphManager: vi.fn(),
}));

vi.mock("sushi", async (importOriginal) => ({
    ...(await importOriginal()),
    RainDataFetcher: {
        init: vi.fn(),
    },
}));

vi.mock("../utils", async (importOriginal) => ({
    ...(await importOriginal()),
    sleep: vi.fn(),
}));

vi.mock("../wallet", async (importOriginal) => ({
    ...(await importOriginal()),
    WalletManager: {
        init: vi.fn(),
    },
}));

vi.mock("@opentelemetry/api", async (importOriginal) => ({
    ...(await importOriginal()),
    trace: {
        setSpan: vi.fn(),
    },
    context: {
        active: vi.fn(),
    },
}));

vi.mock("../logger", async (importOriginal) => ({
    ...(await importOriginal()),
    RainSolverLogger: vi.fn().mockImplementation(() => ({
        tracer: {
            startActiveSpan: vi.fn(),
        },
        exportPreAssembledSpan: vi.fn(),
        shutdown: vi.fn(),
    })),
}));

describe("Test RainSolverCli", () => {
    let mockAppOptions: AppOptions;
    let mockState: SharedState;
    let mockOrderManager: OrderManager;
    let mockWalletManager: WalletManager;
    let mockSubgraphManager: SubgraphManager;
    let mockRainSolver: RainSolver;
    let mockLogger: RainSolverLogger;
    let rainSolverCli: RainSolverCli;

    beforeEach(() => {
        vi.clearAllMocks();

        mockAppOptions = {
            sleep: 1000,
            poolUpdateInterval: 60,
            gasCoveragePercentage: "100",
        } as any;

        mockState = {
            chainConfig: {
                id: 1,
                blockExplorers: {
                    default: { url: "https://etherscan.io" },
                },
            },
            rpc: {
                urls: ["https://rpc1.com", "https://rpc2.com"],
                metrics: {
                    "https://rpc1.com": {
                        req: 10,
                        success: 8,
                        failure: 2,
                        timeout: 0,
                        avgRequestIntervals: 100,
                        progress: {
                            successRate: 8000,
                            selectionWeight: 0.8,
                        },
                        reset: vi.fn(),
                    },
                    "https://rpc2.com": {
                        req: 5,
                        success: 4,
                        failure: 1,
                        timeout: 0,
                        avgRequestIntervals: 120,
                        progress: {
                            successRate: 8000,
                            selectionWeight: 0.8,
                        },
                        reset: vi.fn(),
                    },
                },
            },
            writeRpc: {
                metrics: {
                    "https://writerpc.com": {
                        req: 3,
                        success: 3,
                        failure: 0,
                        timeout: 0,
                        avgRequestIntervals: 80,
                        progress: {
                            successRate: 10000,
                            selectionWeight: 1.0,
                        },
                        reset: vi.fn(),
                    },
                },
            },
            watchedTokens: new Map([
                ["ETH", { address: "0xETH", symbol: "ETH", decimals: 18 }],
                ["USDC", { address: "0xUSDC", symbol: "USDC", decimals: 6 }],
            ]),
            dataFetcher: { test: "data" },
            liquidityProviders: ["uniswap"],
            client: {},
            avgGasCost: 1000000000000000000n,
            gasCosts: [500000000000000000n, 1500000000000000000n],
        } as any;

        mockOrderManager = {
            sync: vi.fn(),
        } as any;

        mockWalletManager = {
            mainWallet: {
                address: "0xMainWallet",
            },
            config: {
                type: WalletType.Mnemonic,
            },
            checkMainWalletBalance: vi.fn(),
            fundOwnedVaults: vi.fn(),
            retryPendingAddWorkers: vi.fn(),
            assessWorkers: vi.fn(),
            retryPendingRemoveWorkers: vi.fn(),
            convertHoldingsToGas: vi.fn(),
            getWorkerWalletsBalance: vi.fn(),
            workers: {
                lastUsedDerivationIndex: 5,
            },
        } as any;

        mockSubgraphManager = {
            subgraphs: ["subgraph1", "subgraph2"],
            statusCheck: vi.fn(),
            getOrderbooks: vi.fn().mockResolvedValue(new Set(["orderbook1", "orderbook2"])),
        } as any;

        mockRainSolver = {
            processNextRound: vi.fn(),
        } as any;

        mockLogger = {
            tracer: {
                startSpan: vi.fn(),
                startActiveSpan: vi.fn(),
            },
            exportPreAssembledSpan: vi.fn(),
            shutdown: vi.fn(),
        } as any;

        // create RainSolverCli instance manually for testing
        rainSolverCli = Object.create(RainSolverCli.prototype);
        (rainSolverCli as any).state = mockState;
        (rainSolverCli as any).appOptions = mockAppOptions;
        (rainSolverCli as any).orderManager = mockOrderManager;
        (rainSolverCli as any).walletManager = mockWalletManager;
        (rainSolverCli as any).subgraphManager = mockSubgraphManager;
        (rainSolverCli as any).rainSolver = mockRainSolver;
        (rainSolverCli as any).logger = mockLogger;
        rainSolverCli.roundCount = 1;
        rainSolverCli.avgGasCost = 1000000000000000000n;
        (rainSolverCli as any).nextDatafetcherReset = Date.now() + 60000;
    });

    describe("Test init static method", () => {
        it("should initialize RainSolverCli with all dependencies", async () => {
            const mockCmdOptions = { config: "config.yaml" };
            const mockStateConfig = { test: "config" };
            const mockSgManagerConfig = { test: "sg_config" };
            const mockOrderManagerResult = {
                orderManager: mockOrderManager,
                report: { name: "order-init" },
            };
            const mockWalletManagerResult = {
                walletManager: mockWalletManager,
                reports: [{ name: "wallet-init" }],
            };

            (cmd as Mock).mockResolvedValue(mockCmdOptions);
            (AppOptions.fromYaml as Mock).mockReturnValue(mockAppOptions);
            (SharedStateConfig.tryFromAppOptions as Mock).mockResolvedValue(mockStateConfig);
            (SharedState as Mock).mockImplementation(() => mockState);
            (SubgraphConfig.tryFromAppOptions as Mock).mockReturnValue(mockSgManagerConfig);
            (SubgraphManager as Mock).mockImplementation(() => mockSubgraphManager);
            (mockSubgraphManager.statusCheck as Mock).mockResolvedValue([{ name: "sg-status" }]);
            (OrderManager.init as Mock).mockResolvedValue(mockOrderManagerResult);
            (WalletManager.init as Mock).mockResolvedValue(mockWalletManagerResult);
            (RainSolver as Mock).mockImplementation(() => mockRainSolver);
            (RainSolverLogger as Mock).mockImplementation(() => mockLogger);

            const result = await RainSolverCli.init(["--config", "config.yaml"]);

            expect(cmd).toHaveBeenCalledWith(["--config", "config.yaml"]);
            expect(AppOptions.fromYaml).toHaveBeenCalledWith("config.yaml");
            expect(SharedStateConfig.tryFromAppOptions).toHaveBeenCalledWith(mockAppOptions);
            expect(SharedState).toHaveBeenCalledWith(mockStateConfig);
            expect(SubgraphConfig.tryFromAppOptions).toHaveBeenCalledWith(mockAppOptions);
            expect(SubgraphManager).toHaveBeenCalledWith(mockSgManagerConfig);
            expect(mockSubgraphManager.statusCheck).toHaveBeenCalledTimes(1);
            expect(OrderManager.init).toHaveBeenCalledWith(mockState, mockSubgraphManager);
            expect(WalletManager.init).toHaveBeenCalledWith(mockState);
            expect(RainSolver).toHaveBeenCalledWith(
                mockState,
                mockAppOptions,
                mockOrderManager,
                mockWalletManager,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                expect.objectContaining({ name: "startup" }),
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith({ name: "sg-status" });
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith({ name: "order-init" });
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith({ name: "wallet-init" });

            expect(result).toBeInstanceOf(RainSolverCli);
        });

        it("should handle startup errors", async () => {
            const startupError = new Error("Startup failed");
            (cmd as Mock).mockRejectedValue(startupError);
            const mockLogger = {
                exportPreAssembledSpan: vi.fn(),
                shutdown: vi.fn(),
            };
            (RainSolverLogger as Mock).mockImplementation(() => mockLogger);

            await expect(RainSolverCli.init(["--config", "config.yaml"])).rejects.toThrow(
                "Startup failed",
            );

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: "startup",
                    status: { code: SpanStatusCode.ERROR, message: expect.any(String) },
                }),
            );
        });

        it("should handle subgraph status check errors", async () => {
            const mockCmdOptions = { config: "config.yaml" };
            const mockStateConfig = { test: "config" };
            const mockSgManagerConfig = { test: "sg_config" };

            (cmd as Mock).mockResolvedValue(mockCmdOptions);
            (AppOptions.fromYaml as Mock).mockReturnValue(mockAppOptions);
            (SharedStateConfig.tryFromAppOptions as Mock).mockResolvedValue(mockStateConfig);
            (SharedState as Mock).mockImplementation(() => mockState);
            (SubgraphConfig.tryFromAppOptions as Mock).mockReturnValue(mockSgManagerConfig);
            (SubgraphManager as Mock).mockImplementation(() => mockSubgraphManager);
            (mockSubgraphManager.statusCheck as Mock).mockRejectedValue([{ name: "sg-error" }]);
            const mockLogger = {
                exportPreAssembledSpan: vi.fn(),
                shutdown: vi.fn(),
            };
            (RainSolverLogger as Mock).mockImplementation(() => mockLogger);

            await expect(RainSolverCli.init(["--config", "config.yaml"])).rejects.toThrow(
                "All subgraphs have indexing error",
            );

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith({ name: "sg-error" });
        });

        it("should handle order manager init errors", async () => {
            const mockCmdOptions = { config: "config.yaml" };
            const mockStateConfig = { test: "config" };
            const mockSgManagerConfig = { test: "sg_config" };

            (cmd as Mock).mockResolvedValue(mockCmdOptions);
            (AppOptions.fromYaml as Mock).mockReturnValue(mockAppOptions);
            (SharedStateConfig.tryFromAppOptions as Mock).mockResolvedValue(mockStateConfig);
            (SharedState as Mock).mockImplementation(() => mockState);
            (SubgraphConfig.tryFromAppOptions as Mock).mockReturnValue(mockSgManagerConfig);
            (SubgraphManager as Mock).mockImplementation(() => mockSubgraphManager);
            (mockSubgraphManager.statusCheck as Mock).mockResolvedValue([{ name: "sg-status" }]);
            (OrderManager.init as Mock).mockRejectedValue({ name: "order-error" });
            const mockLogger = {
                exportPreAssembledSpan: vi.fn(),
                shutdown: vi.fn(),
            };
            (RainSolverLogger as Mock).mockImplementation(() => mockLogger);

            await expect(RainSolverCli.init(["--config", "config.yaml"])).rejects.toThrow(
                "Failed to get order details from subgraphs",
            );

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith({ name: "order-error" });
        });
    });

    describe("Test reportRpcMetricsForRound method", () => {
        it("should report metrics for all RPCs", async () => {
            const mockRoundSpan = {
                setAttribute: vi.fn(),
                setAttributes: vi.fn(),
                setStatus: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn(),
            };
            const mockRoundCtx = { test: "context" };
            (mockLogger.tracer.startActiveSpan as Mock).mockImplementation(
                (_name, callback1, _ctx, callback2) => {
                    if (typeof callback1 === "function") return callback1(mockRoundSpan);
                    if (typeof callback2 === "function") return callback2(mockRoundSpan);
                },
            );

            await rainSolverCli.reportRpcMetricsForRound(mockRoundCtx as any);

            expect(mockLogger.tracer.startActiveSpan).toHaveBeenCalledTimes(3); // 2 read RPCs + 1 write RPC
            expect(mockState.rpc.metrics["https://rpc1.com"].reset).toHaveBeenCalledTimes(1);
            expect(mockState.rpc.metrics["https://rpc2.com"].reset).toHaveBeenCalledTimes(1);
            expect(mockState.writeRpc?.metrics["https://writerpc.com"].reset).toHaveBeenCalledTimes(
                1,
            );
        });

        it("should handle missing writeRpc", async () => {
            rainSolverCli.state.writeRpc = undefined;
            const mockRoundCtx = { test: "context" };

            await rainSolverCli.reportRpcMetricsForRound(mockRoundCtx as any);

            expect(mockLogger.tracer.startActiveSpan).toHaveBeenCalledTimes(2); // only read RPCs
        });
    });

    describe("Test reportMetaInfoForRound method", () => {
        it("should report all meta information attributes", async () => {
            const mockRoundSpan = {
                setAttributes: vi.fn(),
                setAttribute: vi.fn(),
            };

            (mockWalletManager.getWorkerWalletsBalance as Mock).mockResolvedValue({
                "0xworker1": 1000000000000000000n,
                "0xworker2": 2000000000000000000n,
            });

            await rainSolverCli.reportMetaInfoForRound(mockRoundSpan as any);

            expect(mockRoundSpan.setAttributes).toHaveBeenCalledWith({
                "meta.chain": "ethereum",
                "meta.chainId": 1,
                "meta.sgs": ["subgraph1", "subgraph2"],
                "meta.rpArb": undefined,
                "meta.genericArb": undefined,
                "meta.orderbooks": ["orderbook1", "orderbook2"],
                "meta.mainAccount": "0xMainWallet",
                "meta.gitCommitHash": "N/A",
                "meta.dockerTag": "N/A",
                "meta.trackedTokens": JSON.stringify([
                    { address: "0xETH", symbol: "ETH", decimals: 18 },
                    { address: "0xUSDC", symbol: "USDC", decimals: 6 },
                ]),
                "meta.configurations": JSON.stringify({
                    sleep: 1000,
                    poolUpdateInterval: 60,
                    gasCoveragePercentage: "100",
                    key: "N/A",
                    mnemonic: "N/A",
                }),
            });

            expect(mockRoundSpan.setAttribute).toHaveBeenCalledWith(
                "circulatingAccounts",
                JSON.stringify(
                    {
                        "0xworker1": 1000000000000000000n,
                        "0xworker2": 2000000000000000000n,
                    },
                    withBigintSerializer,
                ),
            );
            expect(mockRoundSpan.setAttribute).toHaveBeenCalledWith("lastAccountIndex", 5);
            expect(mockRoundSpan.setAttribute).toHaveBeenCalledWith("avgGasCost", "1");

            expect(mockSubgraphManager.getOrderbooks).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.getWorkerWalletsBalance).toHaveBeenCalledTimes(1);
        });

        it("should handle single wallet mode (no worker balances)", async () => {
            rainSolverCli.walletManager.config.type = WalletType.PrivateKey;
            const mockRoundSpan = {
                setAttributes: vi.fn(),
                setAttribute: vi.fn(),
            };

            await rainSolverCli.reportMetaInfoForRound(mockRoundSpan as any);

            expect(mockRoundSpan.setAttributes).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.getWorkerWalletsBalance).not.toHaveBeenCalled();
            expect(mockRoundSpan.setAttribute).not.toHaveBeenCalledWith(
                "circulatingAccounts",
                expect.any(String),
            );
        });

        it("should handle missing avgGasCost", async () => {
            rainSolverCli.avgGasCost = undefined;
            const mockRoundSpan = {
                setAttributes: vi.fn(),
                setAttribute: vi.fn(),
            };

            (mockWalletManager.getWorkerWalletsBalance as Mock).mockResolvedValue({});

            await rainSolverCli.reportMetaInfoForRound(mockRoundSpan as any);

            expect(mockRoundSpan.setAttributes).toHaveBeenCalledTimes(1);
            expect(mockRoundSpan.setAttribute).not.toHaveBeenCalledWith(
                "avgGasCost",
                expect.any(String),
            );
        });
    });

    describe("Test maybeResetAvgGasCost method", () => {
        it("should reset avgGasCost when time has passed", () => {
            const pastTime = Date.now() - 100000;
            (rainSolverCli as any).nextGasReset = pastTime;
            rainSolverCli.state.gasCosts = [1000000000000000000n, 2000000000000000000n];

            rainSolverCli.maybeResetAvgGasCost();

            expect((rainSolverCli as any).nextGasReset).toBeGreaterThan(pastTime);
            expect(rainSolverCli.avgGasCost).toBe(mockState.avgGasCost);
            expect(rainSolverCli.state.gasCosts).toEqual([]);
        });

        it("should not reset when time has not passed", () => {
            const futureTime = Date.now() + 100000;
            const originalGasCosts = [1000000000000000000n, 2000000000000000000n];
            (rainSolverCli as any).nextGasReset = futureTime;
            rainSolverCli.state.gasCosts = [...originalGasCosts];

            rainSolverCli.maybeResetAvgGasCost();

            expect((rainSolverCli as any).nextGasReset).toBe(futureTime);
            expect(rainSolverCli.state.gasCosts).toEqual(originalGasCosts);
        });

        it("should update avgGasCost from state even when not resetting", () => {
            const futureTime = Date.now() + 100000;
            (rainSolverCli as any).nextGasReset = futureTime;
            (rainSolverCli.state as any).avgGasCost = 2000000000000000000n;

            rainSolverCli.maybeResetAvgGasCost();

            expect(rainSolverCli.avgGasCost).toBe(2000000000000000000n);
        });
    });

    describe("Test maybeResetDataFetcher method", () => {
        it("should reset data fetcher when time has passed", async () => {
            const pastTime = Date.now() - 100000;
            (rainSolverCli as any).nextDatafetcherReset = pastTime;

            const mockNewDataFetcher = { test: "new_data" };
            const RainDataFetcher = await import("sushi");
            (RainDataFetcher.RainDataFetcher.init as Mock).mockResolvedValue(mockNewDataFetcher);

            await rainSolverCli.maybeResetDataFetcher();

            expect((rainSolverCli as any).nextDatafetcherReset).toBeGreaterThan(pastTime);
            expect(RainDataFetcher.RainDataFetcher.init).toHaveBeenCalledWith(
                1,
                mockState.client,
                mockState.liquidityProviders,
            );
            expect(rainSolverCli.state.dataFetcher).toBe(mockNewDataFetcher);
        });

        it("should not reset when time has not passed", async () => {
            const futureTime = Date.now() + 100000;
            const originalDataFetcher = rainSolverCli.state.dataFetcher;
            (rainSolverCli as any).nextDatafetcherReset = futureTime;

            const RainDataFetcher = await import("sushi");
            const initSpy = RainDataFetcher.RainDataFetcher.init as Mock;

            await rainSolverCli.maybeResetDataFetcher();

            expect((rainSolverCli as any).nextDatafetcherReset).toBe(futureTime);
            expect(initSpy).not.toHaveBeenCalled();
            expect(rainSolverCli.state.dataFetcher).toBe(originalDataFetcher);
        });

        it("should handle data fetcher init failure gracefully", async () => {
            const pastTime = Date.now() - 100000;
            (rainSolverCli as any).nextDatafetcherReset = pastTime;
            const originalDataFetcher = rainSolverCli.state.dataFetcher;

            const RainDataFetcher = await import("sushi");
            (RainDataFetcher.RainDataFetcher.init as Mock).mockRejectedValue(
                new Error("Init failed"),
            );

            await rainSolverCli.maybeResetDataFetcher();

            expect((rainSolverCli as any).nextDatafetcherReset).toBeGreaterThan(pastTime);
            expect(rainSolverCli.state.dataFetcher).toBe(originalDataFetcher);
        });
    });

    describe("Test runWalletOpsForRound method", () => {
        it("should call all wallet operations in correct order", async () => {
            const mockRoundCtx = { test: "context" };
            const mockRetryAddReports = [{ name: "retry-add-1" }, { name: "retry-add-2" }];
            const mockAssessReports = [
                {
                    removeWorkerReport: { name: "remove-1" },
                    addWorkerReport: { name: "add-1" },
                },
                {
                    removeWorkerReport: { name: "remove-2" },
                    addWorkerReport: { name: "add-2" },
                },
            ];

            (mockWalletManager.retryPendingAddWorkers as Mock).mockResolvedValue(
                mockRetryAddReports,
            );
            (mockWalletManager.assessWorkers as Mock).mockResolvedValue(mockAssessReports);

            await rainSolverCli.runWalletOpsForRound(mockRoundCtx as any);

            expect(mockWalletManager.retryPendingAddWorkers).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.assessWorkers).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.retryPendingRemoveWorkers).not.toHaveBeenCalled();
            expect(mockWalletManager.convertHoldingsToGas).not.toHaveBeenCalled();

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "retry-add-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "retry-add-2" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "remove-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "add-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "remove-2" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "add-2" },
                mockRoundCtx,
            );
        });

        it("should call additional operations on round 250", async () => {
            rainSolverCli.roundCount = 250;
            const mockRoundCtx = { test: "context" };
            const mockPendingRemoveReports = [{ name: "pending-remove-1" }];
            const mockConvertHoldingsReport = { name: "convert-holdings" };

            (mockWalletManager.retryPendingAddWorkers as Mock).mockResolvedValue([]);
            (mockWalletManager.assessWorkers as Mock).mockResolvedValue([]);
            (mockWalletManager.retryPendingRemoveWorkers as Mock).mockResolvedValue(
                mockPendingRemoveReports,
            );
            (mockWalletManager.convertHoldingsToGas as Mock).mockResolvedValue(
                mockConvertHoldingsReport,
            );

            await rainSolverCli.runWalletOpsForRound(mockRoundCtx as any);

            expect(mockWalletManager.retryPendingRemoveWorkers).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.convertHoldingsToGas).toHaveBeenCalledTimes(1);

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "pending-remove-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                mockConvertHoldingsReport,
                mockRoundCtx,
            );
        });
    });

    describe("Test processOrdersForRound method", () => {
        it("should process round and export all reports", async () => {
            const mockRoundSpan = {
                setAttribute: vi.fn(),
            };
            const mockRoundCtx = { test: "context" };
            const mockResults = [
                { isOk: () => true, value: { txUrl: "https://etherscan.io/tx/0x123" } },
                { isOk: () => false, error: { txUrl: "https://etherscan.io/tx/0x456" } },
                { isOk: () => true, value: { txUrl: undefined } },
            ];
            const mockReports = [{ name: "report-1" }, { name: "report-2" }];
            const mockCheckpointReports = [{ name: "checkpoint-1" }];

            (mockRainSolver.processNextRound as Mock).mockResolvedValue({
                results: mockResults,
                reports: mockReports,
                checkpointReports: mockCheckpointReports,
            });

            await rainSolverCli.processOrdersForRound(mockRoundSpan as any, mockRoundCtx as any);

            expect(mockRainSolver.processNextRound).toHaveBeenCalledTimes(1);

            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "checkpoint-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "report-1" },
                mockRoundCtx,
            );
            expect(mockLogger.exportPreAssembledSpan).toHaveBeenCalledWith(
                { name: "report-2" },
                mockRoundCtx,
            );

            expect(mockRoundSpan.setAttribute).toHaveBeenCalledWith("foundOpp", true);
            expect(mockRoundSpan.setAttribute).toHaveBeenCalledWith("txUrls", [
                "https://etherscan.io/tx/0x123",
                "https://etherscan.io/tx/0x456",
            ]);
        });

        it("should not set foundOpp when no transactions found", async () => {
            const mockRoundSpan = {
                setAttribute: vi.fn(),
            };
            const mockRoundCtx = { test: "context" };
            const mockResults = [
                { isOk: () => true, value: { txUrl: undefined } },
                { isOk: () => false, error: { txUrl: undefined } },
            ];

            (mockRainSolver.processNextRound as Mock).mockResolvedValue({
                results: mockResults,
                reports: [],
                checkpointReports: [],
            });

            await rainSolverCli.processOrdersForRound(mockRoundSpan as any, mockRoundCtx as any);

            expect(mockRoundSpan.setAttribute).not.toHaveBeenCalledWith("foundOpp", true);
            expect(mockRoundSpan.setAttribute).not.toHaveBeenCalledWith(
                "txUrls",
                expect.any(Array),
            );
        });
    });

    describe("Test run method", () => {
        it("should run continuous processing loop", async () => {
            // mock process.env for preview mode to break the loop
            const originalEnv = process.env;
            process.env = {
                ...originalEnv,
                IS_PREVIEW: "true",
                PREVIEW_ROUNDS: "1",
            };

            const mockSpan = {
                setAttribute: vi.fn(),
                setAttributes: vi.fn(),
                setStatus: vi.fn(),
                recordException: vi.fn(),
                end: vi.fn(),
            };

            (mockLogger.tracer.startSpan as Mock).mockReturnValue(mockSpan);

            (trace.setSpan as Mock).mockReturnValue({ test: "context" });
            (context.active as Mock).mockReturnValue({ test: "active" });

            (mockWalletManager.checkMainWalletBalance as Mock).mockResolvedValue({
                name: "check-balance",
            });
            (mockWalletManager.fundOwnedVaults as Mock).mockResolvedValue([
                { name: "fund-vaults" },
            ]);
            (mockRainSolver.processNextRound as Mock).mockResolvedValue({
                results: [],
                reports: [],
                checkpointReports: [],
            });
            (mockWalletManager.retryPendingAddWorkers as Mock).mockResolvedValue([]);
            (mockWalletManager.assessWorkers as Mock).mockResolvedValue([]);
            (mockWalletManager.getWorkerWalletsBalance as Mock).mockResolvedValue({});
            (mockSubgraphManager.getOrderbooks as Mock).mockResolvedValue(new Set());
            (mockOrderManager.sync as Mock).mockResolvedValue({ name: "sync" });
            (sleep as Mock).mockResolvedValue(undefined);

            const runPromise = rainSolverCli.run();

            // Wait for the method to complete
            await runPromise;

            expect(mockLogger.tracer.startSpan).toHaveBeenCalledWith("round-1");
            expect(mockWalletManager.checkMainWalletBalance).toHaveBeenCalledTimes(1);
            expect(mockWalletManager.fundOwnedVaults).toHaveBeenCalledTimes(1);
            expect(mockRainSolver.processNextRound).toHaveBeenCalledTimes(1);
            expect(mockOrderManager.sync).toHaveBeenCalledTimes(1);
            expect(mockLogger.shutdown).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledWith(1000);
            expect(sleep).toHaveBeenCalledWith(3000);

            // Restore process.env
            process.env = originalEnv;
        });

        it("should handle errors in processing loop", async () => {
            const originalEnv = process.env;
            process.env = {
                ...originalEnv,
                IS_PREVIEW: "true",
                PREVIEW_ROUNDS: "1",
            };

            const mockSpan = {
                setAttribute: vi.fn(),
                setAttributes: vi.fn(),
                setStatus: vi.fn(),
                recordException: vi.fn(),
                addEvent: vi.fn(),
                end: vi.fn(),
            };

            (mockLogger.tracer.startSpan as Mock).mockReturnValue(mockSpan);

            (trace.setSpan as Mock).mockReturnValue({ test: "context" });
            (context.active as Mock).mockReturnValue({ test: "active" });

            (mockWalletManager.checkMainWalletBalance as Mock).mockResolvedValue({
                name: "check-balance",
            });
            (mockWalletManager.fundOwnedVaults as Mock).mockRejectedValue(
                new Error("Fund vault failed"),
            );
            (mockSubgraphManager.getOrderbooks as Mock).mockResolvedValue(new Set());
            (mockOrderManager.sync as Mock).mockRejectedValue({ name: "sync" });
            (sleep as Mock).mockResolvedValue(undefined);

            await rainSolverCli.run();

            expect(mockSpan.setAttribute).toHaveBeenCalledWith("severity", "HIGH");
            expect(mockSpan.setAttribute).toHaveBeenCalledWith("didClear", false);
            expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
            expect(mockSpan.addEvent).toHaveBeenCalledWith(
                "Failed to sync orders to upstream, will try again next round",
            );
            expect(mockSpan.setStatus).toHaveBeenCalledWith({
                code: SpanStatusCode.ERROR,
                message: expect.any(String),
            });

            process.env = originalEnv;
        });
    });
});
