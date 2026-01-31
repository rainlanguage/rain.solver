import { GasManager } from "../gas";
import { SushiRouter } from "../router";
import { Token } from "sushi/currency";
import { getChainConfig } from "./chain";
import { createPublicClient } from "viem";
import { LiquidityProviders } from "sushi";
import { SolverContracts } from "./contracts";
import { RainSolverRouter } from "../router/router";
import { Result, TokenDetails } from "../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { SharedState, SharedStateConfig, SharedStateErrorType } from ".";

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
            (sharedState.router.findLargestTradeSize as Mock).mockReturnValueOnce(undefined);
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
            (sharedState.router.getMarketPrice as Mock)
                .mockResolvedValueOnce(Result.err("error"))
                .mockResolvedValueOnce(Result.ok({ price: 1n }));
            (sharedState.router.findLargestTradeSize as Mock).mockReturnValueOnce(
                500000000000000000n,
            );
            const result = await sharedState.getMarketPrice(token1, token2, 12345n);

            assert(result.isOk());
            expect(result.value).toEqual({ price: 1n });
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledTimes(2);
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledTimes(1);
            expect(sharedState.router.getMarketPrice).toHaveBeenNthCalledWith(1, {
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 1000000000000000000n,
                sushiRouteType: sharedState.appOptions.route,
            });
            expect(sharedState.router.getMarketPrice).toHaveBeenNthCalledWith(2, {
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 500000000000000000n,
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

        it("should call getMarketPrice with correct params for partial size uhappy all", async () => {
            (sharedState.router.getMarketPrice as Mock)
                .mockResolvedValueOnce(Result.err("error1"))
                .mockResolvedValueOnce(Result.err("error2"));
            (sharedState.router.findLargestTradeSize as Mock).mockReturnValueOnce(
                500000000000000000n,
            );
            const result = await sharedState.getMarketPrice(token1, token2, 12345n);

            assert(result.isErr());
            expect(result.error).toBe("error1");
            expect(sharedState.router.getMarketPrice).toHaveBeenCalledTimes(2);
            expect(sharedState.router.findLargestTradeSize).toHaveBeenCalledTimes(1);
            expect(sharedState.router.getMarketPrice).toHaveBeenNthCalledWith(1, {
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 1000000000000000000n,
                sushiRouteType: sharedState.appOptions.route,
            });
            expect(sharedState.router.getMarketPrice).toHaveBeenNthCalledWith(2, {
                fromToken: token1,
                toToken: token2,
                blockNumber: 12345n,
                skipFetch: false,
                gasPrice: sharedState.gasPrice,
                amountIn: 500000000000000000n,
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
