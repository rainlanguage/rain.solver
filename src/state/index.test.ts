import { GasManager } from "../gas";
import { SushiRouter, TradeSizeStatus } from "../router";
import { Token } from "sushi/currency";
import { getChainConfig } from "./chain";
import { createPublicClient } from "viem";
import { LiquidityProviders } from "sushi";
import { SolverContracts } from "./contracts";
import { RainSolverRouter } from "../router/router";
import { Result, TokenDetails } from "../common";
import { describe, it, expect, vi, beforeEach, afterEach, Mock, assert } from "vitest";
import {
    SharedState,
    SharedStateConfig,
    SharedStateErrorType,
    WS_RESUBSCRIBE_DELAY,
    subscribeToFlashblocks,
} from ".";

vi.mock("../gas", () => ({
    GasManager: {
        init: vi.fn().mockReturnValue({
            gasPrice: 0n,
            l1GasPrice: 0n,
            gasPriceMultiplier: 123,
            record: vi.fn(),
        }),
    },
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    createPublicClient: vi.fn().mockImplementation(() => ({
        getChainId: vi.fn().mockResolvedValue(1),
        readContract: vi.fn(),
    })),
}));

vi.mock("./chain", () => ({
    getChainConfig: vi.fn(),
}));

vi.mock("./contracts", () => ({
    SolverContracts: {
        fromAppOptions: vi.fn(),
    },
}));

describe("Test SharedStateConfig tryFromAppOptions", () => {
    let options: any;
    let mockClient: any;

    beforeEach(() => {
        options = {
            key: "0xkey",
            rpc: [{ url: "http://example.com" }],
            writeRpc: undefined,
            gasPriceMultiplier: 123,
            liquidityProviders: ["UniswapV2"],
            timeout: 1000,
            txGas: "120%",
            botMinBalance: "0.0000000001",
            contracts: {
                v4: {
                    sushiArb: "0xsushiArb",
                    genericArb: "0xgenericArb",
                    balancerArb: "0xbalancerArb",
                    dispair: {
                        deployer: "0xdispair",
                        iInterpreter: "0xinterpreter",
                        iStore: "0xstore",
                    },
                },
            },
        };
        mockClient = {
            getChainId: vi.fn().mockResolvedValue(1),
            getBlockNumber: vi.fn().mockResolvedValue(123),
            readContract: vi
                .fn()
                .mockImplementationOnce(() => Promise.resolve("0xinterpreter"))
                .mockImplementationOnce(() => Promise.resolve("0xstore")),
        };
        (SolverContracts.fromAppOptions as Mock).mockResolvedValue({
            v4: {
                sushiArb: "0xsushiArb",
                genericArb: "0xgenericArb",
                balancerArb: "0xbalancerArb",
                dispair: {
                    deployer: "0xdispair",
                    interpreter: "0xinterpreter",
                    store: "0xstore",
                },
            },
        } as any as SolverContracts);
        (getChainConfig as Mock).mockReturnValue(
            Result.ok({
                id: 1,
                isSpecialL2: false,
                nativeWrappedToken: "0xwrapped",
                routeProcessors: {
                    "4": "0xrouteProcessor",
                },
                stableTokens: [],
            }),
        );
        (createPublicClient as Mock).mockReturnValue(mockClient);
    });

    it("should build SharedStateConfig from AppOptions (happy path)", async () => {
        const spy = vi.spyOn(RainSolverRouter, "create");
        const solverContractsSpy = vi.spyOn(SolverContracts, "fromAppOptions");
        const configResult = await SharedStateConfig.tryFromAppOptions(options);
        assert(configResult.isOk());
        const config = configResult.value;
        expect(config.walletConfig).toEqual({ key: "0xkey", minBalance: 100_000_000n, type: 1 });
        expect(config.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
        expect(config.client).toBeDefined();
        expect(config.chainConfig.id).toBe(1);
        expect(config.contracts.v4?.dispair).toEqual({
            interpreter: "0xinterpreter",
            store: "0xstore",
            deployer: "0xdispair",
        });
        expect(config.transactionGas).toBe("120%");
        expect(config.rainSolverTransportConfig).toMatchObject({ timeout: 1000 });
        expect(config.router).toBeDefined();
        expect(config.router.balancer).toBeDefined();
        expect(config.router.sushi).toBeDefined();
        expect(GasManager.init as Mock).toHaveBeenCalledWith({
            chainConfig: {
                id: 1,
                isSpecialL2: false,
                nativeWrappedToken: "0xwrapped",
                routeProcessors: {
                    "4": "0xrouteProcessor",
                },
                stableTokens: [],
            },
            client: mockClient,
            baseGasPriceMultiplier: 123,
        });
        expect(spy).toHaveBeenCalledWith({
            chainId: 1,
            client: mockClient,
            stabullRouter: false,
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            balancerRouterConfig: {
                balancerRouterAddress: expect.any(String),
            },
        });
        expect(solverContractsSpy).toHaveBeenCalledWith(mockClient, options);

        spy.mockRestore();
        solverContractsSpy.mockRestore();
    });

    it("should throw if getChainConfig returns undefined", async () => {
        (getChainConfig as Mock).mockReturnValue(Result.err("some err"));
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isErr());
        expect(result.error.type).toBe(SharedStateErrorType.ChainConfigError);
    });

    it("should throw if fails to init router", async () => {
        const spy = vi.spyOn(RainSolverRouter, "create");
        (spy as Mock).mockResolvedValue(Result.err("some err"));
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isErr());
        expect(result.error.type).toBe(SharedStateErrorType.RouterInitializationError);
        expect(result.error.cause).toBe("some err");
        expect(spy).toHaveBeenCalledWith({
            chainId: 1,
            client: mockClient,
            stabullRouter: false,
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            balancerRouterConfig: {
                balancerRouterAddress: expect.any(String),
            },
        });

        spy.mockRestore();
    });

    it("should not include balancer router if balancerArbAddress is not set", async () => {
        options.contracts.v4.balancerArb = undefined;
        const spy = vi.spyOn(RainSolverRouter, "create");
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isOk());
        expect(spy).toHaveBeenCalledWith({
            chainId: 1,
            client: mockClient,
            stabullRouter: false,
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            balancerRouterConfig: undefined,
        });

        spy.mockRestore();
    });

    it("should not include balancer router if balancer batch router address is undefined", async () => {
        (mockClient.getChainId as Mock).mockReturnValue(99999);
        const spy = vi.spyOn(RainSolverRouter, "create");
        const sushiRouterSpy = vi.spyOn(SushiRouter, "create");
        sushiRouterSpy.mockResolvedValue(Result.ok({} as any));
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isOk());
        expect(spy).toHaveBeenCalledWith({
            chainId: 99999,
            client: mockClient,
            stabullRouter: false,
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            balancerRouterConfig: undefined,
        });

        spy.mockRestore();
        sushiRouterSpy.mockRestore();
    });
});

describe("Test SharedState", () => {
    let config: any;
    let sharedState: SharedState;

    beforeEach(() => {
        config = {
            dispair: {
                interpreter: "0xinterpreter",
                store: "0xstore",
                deployer: "0xdispair",
            },
            contracts: {
                v5: {
                    sushiArb: "0xsushiArb",
                    genericArb: "0xgenericArb",
                    balancerArb: "0xbalancerArb",
                    dispair: {
                        deployer: "0xdispair",
                        iInterpreter: "0xinterpreter",
                        iStore: "0xstore",
                    },
                },
            },
            walletConfig: {
                key: "0xkey",
            },
            liquidityProviders: [LiquidityProviders.UniswapV2],
            client: { dummy: true },
            chainConfig: { id: 1, isSpecialL2: false },
            rpcState: {},
            writeRpcState: {},
            gasPriceMultiplier: 123,
            initGasPrice: 1000n,
            initL1GasPrice: 0n,
            router: {
                getMarketPrice: vi.fn(),
                findLargestTradeSize: vi.fn(),
            },
            appOptions: { route: "multi" },
            gasManager: {
                gasPrice: 1000n,
                l1GasPrice: 0n,
                gasPriceMultiplier: 123,
                isWatchingGasPrice: true,
                watchGasPrice: vi.fn(),
                unwatchGasPrice: vi.fn(),
            },
        };
        sharedState = new SharedState(config);
    });

    describe("Test initialization event and properties", () => {
        it("should initialize properties from config", () => {
            expect(sharedState.contracts.v5?.dispair).toEqual(config.contracts.v5.dispair);
            expect(sharedState.walletConfig).toEqual({ key: "0xkey" });
            expect(sharedState.chainConfig).toEqual(config.chainConfig);
            expect(sharedState.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
            expect(sharedState.gasPriceMultiplier).toBe(123);
            expect(sharedState.gasPrice).toBe(1000n);
            expect(sharedState.l1GasPrice).toBe(0n);
            expect(sharedState.rpc).toBe(config.rpcState);
            expect(sharedState.writeRpc).toBe(config.writeRpcState);
            expect(sharedState.isWatchingGasPrice).toBe(true);
        });

        it("should watch gas price", async () => {
            sharedState.watchGasPrice(10);
            expect(sharedState.gasManager.watchGasPrice).toHaveBeenCalledTimes(1);
            expect(sharedState.gasManager.watchGasPrice).toHaveBeenCalledWith(10);
        });

        it("should unwatch gas price", () => {
            sharedState.unwatchGasPrice();
            expect(sharedState.gasManager.unwatchGasPrice).toHaveBeenCalledTimes(1);
        });

        it("should watch tokens", () => {
            const token1: TokenDetails = { address: "0xABC", symbol: "TKN", decimals: 18 };
            const token2: TokenDetails = { address: "0xDEF", symbol: "TKN2", decimals: 18 };
            sharedState.watchToken(token1);
            sharedState.watchToken(token2);

            expect(sharedState.watchedTokens.get("0xabc")).toBe(token1);
            expect(sharedState.watchedTokens.get("0xdef")).toBe(token2);
            expect(Array.from(sharedState.watchedTokens).length).toBe(2);

            // should not duplicate
            sharedState.watchToken(token2);
            expect(Array.from(sharedState.watchedTokens).length).toBe(2);
        });
    });

    describe("Test block number watcher", () => {
        beforeEach(() => {
            vi.useFakeTimers();
            config.client.getBlockNumber = vi.fn().mockResolvedValue(100n);
            sharedState = new SharedState(config);
        });

        afterEach(() => {
            sharedState.unwatchBlockNumber();
            vi.useRealTimers();
        });

        it("should update block number from rpc", async () => {
            expect(sharedState.blockNumber).toBe(0n);
            expect(sharedState.canonicalBlockNumber).toBe(0n);
            await sharedState.updateBlockNumber();
            // a read block number is a sealed one
            expect(sharedState.blockNumber).toBe(100n);
            expect(sharedState.canonicalBlockNumber).toBe(100n);
        });

        it("should keep previous block number when the call fails", async () => {
            await sharedState.updateBlockNumber();
            expect(sharedState.blockNumber).toBe(100n);

            (config.client.getBlockNumber as Mock).mockRejectedValue(new Error("rpc failed"));
            await sharedState.updateBlockNumber();
            expect(sharedState.blockNumber).toBe(100n);
        });

        it("should not move block number backwards", async () => {
            await sharedState.updateBlockNumber();
            expect(sharedState.blockNumber).toBe(100n);

            (config.client.getBlockNumber as Mock).mockResolvedValue(90n);
            await sharedState.updateBlockNumber();
            expect(sharedState.blockNumber).toBe(100n);

            (config.client.getBlockNumber as Mock).mockResolvedValue(110n);
            await sharedState.updateBlockNumber();
            expect(sharedState.blockNumber).toBe(110n);
        });

        it("should watch block number with an immediate update and periodic updates", async () => {
            expect(sharedState.isWatchingBlockNumber).toBe(false);
            sharedState.watchBlockNumber(5000);
            expect(sharedState.isWatchingBlockNumber).toBe(true);

            // immediate update on start
            await vi.advanceTimersByTimeAsync(0);
            expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
            expect(sharedState.blockNumber).toBe(100n);

            // periodic updates
            (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
            await vi.advanceTimersByTimeAsync(5000);
            expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);
            expect(sharedState.blockNumber).toBe(101n);

            // should not start a second watcher
            sharedState.watchBlockNumber(5000);
            await vi.advanceTimersByTimeAsync(5000);
            expect(config.client.getBlockNumber).toHaveBeenCalledTimes(3);
        });

        it("should unwatch block number", async () => {
            sharedState.watchBlockNumber(5000);
            await vi.advanceTimersByTimeAsync(0);
            expect(sharedState.isWatchingBlockNumber).toBe(true);

            sharedState.unwatchBlockNumber();
            expect(sharedState.isWatchingBlockNumber).toBe(false);

            // no more updates after unwatch
            await vi.advanceTimersByTimeAsync(15000);
            expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
        });

        describe("websocket new heads subscription", () => {
            let onBlockNumber: (blockNumber: bigint) => void;
            let onError: (error: Error) => void;
            let wsUnwatch: Mock;
            let watchBlockNumberSpy: Mock;

            beforeEach(() => {
                config.appOptions.wsRpc = "wss://ws-rpc.example.com";
                wsUnwatch = vi.fn();
                watchBlockNumberSpy = vi.fn().mockImplementation((args: any) => {
                    onBlockNumber = args.onBlockNumber;
                    onError = args.onError;
                    return wsUnwatch;
                });
                (createPublicClient as Mock).mockReturnValue({
                    watchBlockNumber: watchBlockNumberSpy,
                });
                sharedState = new SharedState(config);
            });

            it("should subscribe to new heads and update block number", async () => {
                sharedState.watchBlockNumber(5000);
                expect(sharedState.isWatchingBlockNumber).toBe(true);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);

                // immediate update over http on start
                await vi.advanceTimersByTimeAsync(0);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
                expect(sharedState.blockNumber).toBe(100n);

                // new heads push updates the block number, a new head is sealed
                onBlockNumber(105n);
                expect(sharedState.blockNumber).toBe(105n);
                expect(sharedState.canonicalBlockNumber).toBe(105n);

                // should not move backwards
                onBlockNumber(101n);
                expect(sharedState.blockNumber).toBe(105n);
                expect(sharedState.canonicalBlockNumber).toBe(105n);

                // no polling should be active
                await vi.advanceTimersByTimeAsync(15000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
            });

            it("should fall back to polling on subscription error and stop it on recovery", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);

                // subscription error starts the polling fallback
                onError(new Error("ws failed"));
                (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
                await vi.advanceTimersByTimeAsync(5000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);
                expect(sharedState.blockNumber).toBe(101n);

                // subscription recovery stops the polling fallback
                onBlockNumber(102n);
                expect(sharedState.blockNumber).toBe(102n);
                await vi.advanceTimersByTimeAsync(15000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);
            });

            it("should not start a second subscription when already watching", async () => {
                sharedState.watchBlockNumber(5000);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);

                sharedState.watchBlockNumber(5000);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);
            });

            it("should not start a second polling fallback on repeated subscription errors", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);

                // repeated errors should keep a single poller
                onError(new Error("ws failed"));
                onError(new Error("ws failed again"));
                await vi.advanceTimersByTimeAsync(5000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);
            });

            it("should re-establish the subscription after the resubscribe delay", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);

                // subscription error schedules a fresh subscription
                onError(new Error("ws failed"));
                await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                expect(wsUnwatch).toHaveBeenCalledTimes(1); // old subscription is unwatched
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(2); // fresh subscription

                // the fresh subscription pushes and stops the polling fallback
                onBlockNumber(200n);
                expect(sharedState.blockNumber).toBe(200n);
                const callCount = (config.client.getBlockNumber as Mock).mock.calls.length;
                await vi.advanceTimersByTimeAsync(15000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(callCount);
            });

            it("should schedule a single resubscribe for repeated subscription errors", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);

                onError(new Error("ws failed"));
                onError(new Error("ws failed again"));
                await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(2);
            });

            it("should cancel the pending resubscribe when the subscription recovers", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);

                onError(new Error("ws failed"));
                onBlockNumber(101n); // recovery before the resubscribe delay passes

                await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                expect(wsUnwatch).not.toHaveBeenCalled();
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);
            });

            it("should cancel the pending resubscribe on unwatch", async () => {
                sharedState.watchBlockNumber(5000);
                await vi.advanceTimersByTimeAsync(0);

                onError(new Error("ws failed"));
                sharedState.unwatchBlockNumber();

                await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                expect(watchBlockNumberSpy).toHaveBeenCalledTimes(1);
            });

            it("should unwatch the subscription and the polling fallback", async () => {
                sharedState.watchBlockNumber(5000);
                onError(new Error("ws failed")); // start polling fallback too
                expect(sharedState.isWatchingBlockNumber).toBe(true);

                sharedState.unwatchBlockNumber();
                expect(wsUnwatch).toHaveBeenCalledTimes(1);
                expect(sharedState.isWatchingBlockNumber).toBe(false);

                // no more polling after unwatch
                await vi.advanceTimersByTimeAsync(0);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(15000);
                expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
            });

            describe("flashblocks", () => {
                let onData: (data: any) => void;
                let onSubError: (error: Error) => void;
                let unsubscribe: Mock;
                let subscribeSpy: Mock;
                let resolveSubscription: () => void;
                let rejectSubscription: (error: Error) => void;

                beforeEach(() => {
                    config.appOptions.flashblocks = true;
                    unsubscribe = vi.fn().mockResolvedValue(true);
                    subscribeSpy = vi.fn().mockImplementation((args: any) => {
                        onData = args.onData;
                        onSubError = args.onError;
                        return new Promise((resolve, reject) => {
                            resolveSubscription = () =>
                                resolve({ subscriptionId: "0x1", unsubscribe });
                            rejectSubscription = reject;
                        });
                    });
                    (createPublicClient as Mock).mockReturnValue({
                        watchBlockNumber: watchBlockNumberSpy,
                        transport: { subscribe: subscribeSpy },
                    });
                    sharedState = new SharedState(config);
                });

                afterEach(() => {
                    config.appOptions.flashblocks = false;
                });

                it("should subscribe to newFlashblocks instead of new heads and update block number", async () => {
                    sharedState.watchBlockNumber(5000);
                    expect(sharedState.isWatchingBlockNumber).toBe(true);
                    expect(watchBlockNumberSpy).not.toHaveBeenCalled();
                    expect(subscribeSpy).toHaveBeenCalledTimes(1);
                    expect(subscribeSpy).toHaveBeenCalledWith(
                        expect.objectContaining({ params: ["newFlashblocks"] }),
                    );
                    resolveSubscription();

                    // immediate update over http on start
                    await vi.advanceTimersByTimeAsync(0);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
                    expect(sharedState.blockNumber).toBe(100n);

                    // flashblock heads push updates the block number from the hex
                    // number, the sealed block is the one below the block being built
                    onData({ result: { number: "0x69" } });
                    expect(sharedState.blockNumber).toBe(105n);
                    expect(sharedState.canonicalBlockNumber).toBe(104n);

                    // should not move backwards
                    onData({ result: { number: "0x65" } });
                    expect(sharedState.blockNumber).toBe(105n);
                    expect(sharedState.canonicalBlockNumber).toBe(104n);

                    // no polling should be active
                    await vi.advanceTimersByTimeAsync(15000);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
                });

                it("should fall back to polling on subscription error and resubscribe after the delay", async () => {
                    sharedState.watchBlockNumber(5000);
                    resolveSubscription();
                    await vi.advanceTimersByTimeAsync(0);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);

                    // subscription error starts the polling fallback, a polled
                    // block number is a sealed one
                    onSubError(new Error("ws failed"));
                    (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
                    await vi.advanceTimersByTimeAsync(5000);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);
                    expect(sharedState.blockNumber).toBe(101n);
                    expect(sharedState.canonicalBlockNumber).toBe(101n);

                    // a fresh flashblocks subscription is established after the delay
                    await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                    expect(unsubscribe).toHaveBeenCalledTimes(1);
                    expect(subscribeSpy).toHaveBeenCalledTimes(2);
                    expect(watchBlockNumberSpy).not.toHaveBeenCalled();
                    resolveSubscription();

                    // the fresh subscription pushes and stops the polling fallback
                    onData({ result: { number: "0xc8" } });
                    expect(sharedState.blockNumber).toBe(200n);
                    const callCount = (config.client.getBlockNumber as Mock).mock.calls.length;
                    await vi.advanceTimersByTimeAsync(15000);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(callCount);
                });

                it("should fall back to polling when the subscription request fails", async () => {
                    sharedState.watchBlockNumber(5000);
                    rejectSubscription(new Error("unsupported subscription"));
                    await vi.advanceTimersByTimeAsync(0);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);

                    // polling fallback runs
                    await vi.advanceTimersByTimeAsync(5000);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(2);

                    // and a fresh subscription is attempted after the delay
                    await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                    expect(subscribeSpy).toHaveBeenCalledTimes(2);
                });

                it("should unsubscribe on unwatch", async () => {
                    sharedState.watchBlockNumber(5000);
                    resolveSubscription();
                    await vi.advanceTimersByTimeAsync(0);

                    sharedState.unwatchBlockNumber();
                    expect(unsubscribe).toHaveBeenCalledTimes(1);
                    expect(sharedState.isWatchingBlockNumber).toBe(false);
                });

                it("should unsubscribe once established when unwatched before that", async () => {
                    sharedState.watchBlockNumber(5000);
                    sharedState.unwatchBlockNumber();
                    expect(unsubscribe).not.toHaveBeenCalled();

                    // the late established subscription gets dropped right away
                    resolveSubscription();
                    await vi.advanceTimersByTimeAsync(0);
                    expect(unsubscribe).toHaveBeenCalledTimes(1);
                });

                it("should ignore a failed subscription request after unwatch", async () => {
                    sharedState.watchBlockNumber(5000);
                    sharedState.unwatchBlockNumber();
                    rejectSubscription(new Error("ws failed"));
                    await vi.advanceTimersByTimeAsync(0);

                    // no polling fallback or resubscribe after unwatch
                    await vi.advanceTimersByTimeAsync(WS_RESUBSCRIBE_DELAY);
                    expect(config.client.getBlockNumber).toHaveBeenCalledTimes(1);
                    expect(subscribeSpy).toHaveBeenCalledTimes(1);
                });
            });
        });
    });

    describe("Test subscribeToFlashblocks", () => {
        let onData: (data: any) => void;
        let onSubError: (error: any) => void;
        let onBlockNumber: Mock;
        let onError: Mock;
        let unsubscribe: Mock;
        let resolveSubscription: () => void;
        let rejectSubscription: (error: Error) => void;
        let wsClient: any;

        beforeEach(() => {
            onBlockNumber = vi.fn();
            onError = vi.fn();
            unsubscribe = vi.fn().mockResolvedValue(true);
            wsClient = {
                transport: {
                    subscribe: vi.fn().mockImplementation((args: any) => {
                        onData = args.onData;
                        onSubError = args.onError;
                        return new Promise((resolve, reject) => {
                            resolveSubscription = () =>
                                resolve({ subscriptionId: "0x1", unsubscribe });
                            rejectSubscription = reject;
                        });
                    }),
                },
            };
        });

        it("should parse well formed hex heads and ignore malformed ones", async () => {
            subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            resolveSubscription();
            await Promise.resolve();

            onData({ result: { number: "0x69" } });
            onData({ result: { number: "0xFF" } });
            expect(onBlockNumber).toHaveBeenNthCalledWith(1, 105n);
            expect(onBlockNumber).toHaveBeenNthCalledWith(2, 255n);

            // none of these throw, as a throw here would reach the socket
            // message listener uncaught, nor do they reach the callback
            onData({ result: { number: "0x" } });
            onData({ result: { number: "0xzz" } });
            onData({ result: { number: "105" } });
            onData({ result: { number: 105 } });
            onData({ result: {} });
            onData({});
            onData(undefined);
            expect(onBlockNumber).toHaveBeenCalledTimes(2);
            expect(onError).not.toHaveBeenCalled();
        });

        it("should ignore heads and errors after unsubscribing", async () => {
            const unwatch = subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            resolveSubscription();
            await Promise.resolve();

            unwatch();
            expect(unsubscribe).toHaveBeenCalledTimes(1);

            onData({ result: { number: "0x69" } });
            onSubError(new Error("socket closed"));
            expect(onBlockNumber).not.toHaveBeenCalled();
            expect(onError).not.toHaveBeenCalled();
        });

        it("should report a failed subscribe request through both viem paths", async () => {
            subscribeToFlashblocks(wsClient, onBlockNumber, onError);

            // viem reports a rejected subscribe through both the callback
            // and the rejected promise, both reach the caller as is
            const error = new Error("unsupported");
            onSubError(error);
            rejectSubscription(error);
            await Promise.resolve();
            await Promise.resolve();

            expect(onError).toHaveBeenCalledTimes(2);
            expect(onError).toHaveBeenCalledWith(error);
        });

        it("should keep reporting errors of a live subscription", async () => {
            subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            resolveSubscription();
            await Promise.resolve();

            onSubError(new Error("first"));
            onData({ result: { number: "0x69" } });
            onSubError(new Error("second"));
            expect(onError).toHaveBeenCalledTimes(2);
            expect(onBlockNumber).toHaveBeenCalledWith(105n);
        });

        it("should report a rejected subscribe request that had no error callback", async () => {
            subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            const error = new Error("connection failed");
            rejectSubscription(error);
            await Promise.resolve();
            await Promise.resolve();

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError).toHaveBeenCalledWith(error);
        });

        it("should not report a rejected subscribe request after unsubscribing", async () => {
            const unwatch = subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            unwatch();
            rejectSubscription(new Error("connection failed"));
            await Promise.resolve();
            await Promise.resolve();

            expect(onError).not.toHaveBeenCalled();
            expect(unsubscribe).not.toHaveBeenCalled();
        });

        it("should unsubscribe once established when unsubscribed before that", async () => {
            const unwatch = subscribeToFlashblocks(wsClient, onBlockNumber, onError);
            unwatch();
            expect(unsubscribe).not.toHaveBeenCalled();

            resolveSubscription();
            await Promise.resolve();
            expect(unsubscribe).toHaveBeenCalledTimes(1);
        });
    });

    describe("Test pool updates on new blocks", () => {
        let update: Mock;

        beforeEach(() => {
            update = vi.fn().mockResolvedValue(false);
            config.router.sushi = { update };
            config.client.getBlockNumber = vi.fn().mockResolvedValue(100n);
        });

        afterEach(() => {
            delete config.router.sushi;
        });

        it("should update the pools up to the canonical block on every advance", async () => {
            const state = new SharedState(config);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(1);
            expect(update).toHaveBeenCalledWith(100n);
            expect(state.newPoolCreated).toBe(false);

            // the same block again is not an advance, neither is a lower one
            await state.updateBlockNumber();
            (config.client.getBlockNumber as Mock).mockResolvedValue(90n);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(1);

            // a newly created pool raises the flag for the consumer
            update.mockResolvedValue(true);
            (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(2);
            expect(update).toHaveBeenLastCalledWith(101n);
            expect(state.newPoolCreated).toBe(true);
        });

        it("should not start another update while one is in flight", async () => {
            let finish: (value: boolean) => void = () => {};
            update.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
            const state = new SharedState(config);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(1);

            // blocks advance while the update runs, none starts another one
            (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
            await state.updateBlockNumber();
            (config.client.getBlockNumber as Mock).mockResolvedValue(102n);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(1);

            // once done, the next block picks the gap up
            finish(false);
            await Promise.resolve();
            (config.client.getBlockNumber as Mock).mockResolvedValue(103n);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(2);
            expect(update).toHaveBeenLastCalledWith(103n);
        });

        it("should drop a failed update and try again on the next block", async () => {
            update.mockRejectedValueOnce(new Error("rpc failed"));
            const state = new SharedState(config);
            await state.updateBlockNumber();
            await Promise.resolve();
            expect(update).toHaveBeenCalledTimes(1);
            expect(state.newPoolCreated).toBe(false);

            (config.client.getBlockNumber as Mock).mockResolvedValue(101n);
            await state.updateBlockNumber();
            expect(update).toHaveBeenCalledTimes(2);
        });

        it("should do nothing without a sushi router", async () => {
            delete config.router.sushi;
            const state = new SharedState(config);
            await state.updateBlockNumber();
            expect(state.canonicalBlockNumber).toBe(100n);
            expect(update).not.toHaveBeenCalled();
        });
    });

    describe("Test avgGasCost", () => {
        it("should return 0 when gasCosts array is empty", () => {
            const state = new SharedState(config);
            expect(state.avgGasCost).toBe(0n);
        });

        it("should calculate average correctly for single gas cost", () => {
            const state = new SharedState(config);
            state.gasCosts = [100n];
            expect(state.avgGasCost).toBe(100n);
        });

        it("should calculate average correctly for multiple gas costs", () => {
            const state = new SharedState(config);
            state.gasCosts = [100n, 200n, 300n];
            // (100 + 200 + 300) / 3 = 200
            expect(state.avgGasCost).toBe(200n);
        });
    });

    describe("Test updateGasTokenUsdPrice method", () => {
        it("should update the gas token dollar price", async () => {
            (sharedState.chainConfig as any).nativeWrappedToken = { symbol: "WETH" };
            (sharedState.chainConfig as any).usdToken = { symbol: "USDC" };
            const getMarketPriceSpy = vi
                .spyOn(sharedState, "getMarketPrice")
                .mockResolvedValueOnce(Result.ok({ price: "3500.25" }) as any);

            await sharedState.updateGasTokenUsdPrice(123n);

            expect(sharedState.gasTokenUsdPrice).toBe("3500.25");
            expect(getMarketPriceSpy).toHaveBeenCalledTimes(1);
            expect(getMarketPriceSpy).toHaveBeenCalledWith(
                sharedState.chainConfig.nativeWrappedToken,
                sharedState.chainConfig.usdToken,
                123n,
                true,
            );

            getMarketPriceSpy.mockRestore();
        });

        it("should keep the previous price when the quote fails", async () => {
            (sharedState.chainConfig as any).nativeWrappedToken = { symbol: "WETH" };
            (sharedState.chainConfig as any).usdToken = { symbol: "USDC" };
            sharedState.gasTokenUsdPrice = "1000";
            const getMarketPriceSpy = vi
                .spyOn(sharedState, "getMarketPrice")
                .mockResolvedValueOnce(Result.err(new Error("no way")) as any);

            await sharedState.updateGasTokenUsdPrice(123n);

            expect(sharedState.gasTokenUsdPrice).toBe("1000");

            getMarketPriceSpy.mockRestore();
        });

        it("should do nothing when the chain has no dollar token", async () => {
            const getMarketPriceSpy = vi.spyOn(sharedState, "getMarketPrice");

            await sharedState.updateGasTokenUsdPrice(123n);

            expect(sharedState.gasTokenUsdPrice).toBeUndefined();
            expect(getMarketPriceSpy).not.toHaveBeenCalled();

            getMarketPriceSpy.mockRestore();
        });
    });

    describe("Test getMarketPrice method", () => {
        const token1 = new Token({
            chainId: 1,
            address: `0x${"1".repeat(40)}`,
            symbol: "TKN1",
            decimals: 18,
        });
        const token2 = new Token({
            chainId: 1,
            address: `0x${"2".repeat(40)}`,
            symbol: "TKN2",
            decimals: 18,
        });

        it("should call getMarketPrice with correct params for 1 unit size happy", async () => {
            (sharedState.router.getMarketPrice as Mock).mockResolvedValueOnce(
                Result.ok({ price: 1n }),
            );
            const result = await sharedState.getMarketPrice(token1, token2, 12345n);

            assert(result.isOk());
            expect(result.value).toEqual({ price: 1n });
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledTimes(1);
            expect(sharedState.router.findLargestTradeSize).not.toHaveBeenCalled();
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledWith({
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 1000000000000000000n,
                sushiRouteType: sharedState.appOptions.route,
            });
        });

        it("should call getMarketPrice with correct params for partial size unhappy", async () => {
            (sharedState.router.getMarketPrice as Mock).mockResolvedValueOnce(Result.err("error"));
            (sharedState.router.findLargestTradeSize as Mock).mockReturnValueOnce({
                status: TradeSizeStatus.NoWay,
            });
            const result = await sharedState.getMarketPrice(token1, token2, 12345n);

            assert(result.isErr());
            expect(result.error).toBe("error");
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledTimes(1);
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledTimes(1);
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledWith({
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 1000000000000000000n,
                sushiRouteType: sharedState.appOptions.route,
            });
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledWith(
                { takeOrder: { quote: { ratio: 0n } } } as any,
                token2,
                token1,
                1000000000000000000n,
                sharedState.gasPrice,
                sharedState.appOptions.route,
                true,
            );
        });

        it("should call getMarketPrice with correct params for partial size happy", async () => {
            (sharedState.router.getMarketPrice as Mock).mockResolvedValueOnce(Result.err("error"));
            const mockRoute = { legs: [] };
            (sharedState.router.findLargestTradeSize as Mock).mockReturnValueOnce({
                status: TradeSizeStatus.Found,
                size: 500000000000000000n,
                quote: {
                    price: 500000000000000000n, // 0.5 in 18 decimals
                    amountOut: 250000000000000000n,
                    route: { route: mockRoute, pcMap: new Map() },
                },
            });
            const result = await sharedState.getMarketPrice(token1, token2, 12345n);

            // the partial price is built directly from the size search winning
            // probe quote, so only the initial full size market price call runs
            assert(result.isOk());
            expect(result.value).toEqual({ price: "0.5", route: mockRoute });
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledTimes(1);
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledTimes(1);
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledWith({
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 1000000000000000000n,
                sushiRouteType: sharedState.appOptions.route,
            });
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledWith(
                { takeOrder: { quote: { ratio: 0n } } } as any,
                token2,
                token1,
                1000000000000000000n,
                sharedState.gasPrice,
                sharedState.appOptions.route,
                true,
            );
        });
    });
});
