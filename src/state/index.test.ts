import { SushiRouter } from "../router";
import { Token } from "sushi/currency";
import { getGasPrice } from "./gasPrice";
import { getChainConfig } from "./chain";
import { createPublicClient } from "viem";
import { LiquidityProviders } from "sushi";
import { RainSolverRouter } from "../router/router";
import { Result, sleep, TokenDetails } from "../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { SharedState, SharedStateConfig, SharedStateErrorType } from ".";

vi.mock("./gasPrice", () => ({
    getGasPrice: vi.fn().mockResolvedValue({
        gasPrice: { value: 1000n },
        l1GasPrice: { value: 0n },
    }),
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

describe("Test SharedStateConfig tryFromAppOptions", () => {
    let options: any;
    let mockClient: any;

    beforeEach(() => {
        options = {
            key: "0xkey",
            rpc: [{ url: "http://example.com" }],
            writeRpc: undefined,
            dispair: "0xdispair",
            gasPriceMultiplier: 123,
            liquidityProviders: ["UniswapV2"],
            timeout: 1000,
            txGas: "120%",
            botMinBalance: "0.0000000001",
            balancerArbAddress: "0xbalancerArb",
        };
        mockClient = {
            getChainId: vi.fn().mockResolvedValue(1),
            getBlockNumber: vi.fn().mockResolvedValue(123),
            readContract: vi
                .fn()
                .mockImplementationOnce(() => Promise.resolve("0xinterpreter"))
                .mockImplementationOnce(() => Promise.resolve("0xstore")),
        };
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
        const configResult = await SharedStateConfig.tryFromAppOptions(options);
        assert(configResult.isOk());
        const config = configResult.value;
        expect(config.walletConfig).toEqual({ key: "0xkey", minBalance: 100_000_000n, type: 1 });
        expect(config.gasPriceMultiplier).toBe(123);
        expect(config.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
        expect(config.client).toBeDefined();
        expect(config.chainConfig.id).toBe(1);
        expect(config.dispair).toEqual({
            interpreter: "0xinterpreter",
            store: "0xstore",
            deployer: "0xdispair",
        });
        expect(config.initGasPrice).toBe(1000n);
        expect(config.initL1GasPrice).toBe(0n);
        expect(config.transactionGas).toBe("120%");
        expect(config.rainSolverTransportConfig).toMatchObject({ timeout: 1000 });
        expect(config.router).toBeDefined();
        expect(config.router.balancer).toBeDefined();
        expect(config.router.sushi).toBeDefined();
        expect(spy).toHaveBeenCalledWith({
            chainId: 1,
            client: mockClient,
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

    it("should throw if iInterpreter contract call fails", async () => {
        mockClient.readContract = vi
            .fn()
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValueOnce("0xstore");
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isErr());
        expect(result.error.type).toBe(SharedStateErrorType.FailedToGetDispairInterpreterAddress);
    });

    it("should throw if iStore contract call fails", async () => {
        mockClient.readContract = vi
            .fn()
            .mockResolvedValueOnce("0xinterpreter")
            .mockRejectedValueOnce(new Error("fail"));
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isErr());
        expect(result.error.type).toBe(SharedStateErrorType.FailedToGetDispairStoreAddress);
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
        options.balancerArbAddress = undefined;
        const spy = vi.spyOn(RainSolverRouter, "create");
        const result = await SharedStateConfig.tryFromAppOptions(options);
        assert(result.isOk());
        expect(spy).toHaveBeenCalledWith({
            chainId: 1,
            client: mockClient,
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            undefined,
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
            sushiRouterConfig: {
                liquidityProviders: [LiquidityProviders.UniswapV2],
                sushiRouteProcessor4Address: "0xrouteProcessor",
            },
            undefined,
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
            },
            appOptions: { route: "multi" },
        };
        sharedState = new SharedState(config);
    });

    describe("Test initialization event and properties", () => {
        it("should initialize properties from config", () => {
            expect(sharedState.dispair).toEqual(config.dispair);
            expect(sharedState.walletConfig).toEqual({ key: "0xkey" });
            expect(sharedState.chainConfig).toEqual(config.chainConfig);
            expect(sharedState.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
            expect(sharedState.gasPriceMultiplier).toBe(123);
            expect(sharedState.gasPrice).toBe(1000n);
            expect(sharedState.l1GasPrice).toBe(0n);
            expect(sharedState.rpc).toBe(config.rpcState);
            expect(sharedState.writeRpc).toBe(config.writeRpcState);
        });

        it("should start watching gas price", () => {
            expect(sharedState.isWatchingGasPrice).toBe(true);
            sharedState.unwatchGasPrice();
            expect(sharedState.isWatchingGasPrice).toBe(false);
        });

        it("should update gas prices on interval if getGasPrices resolve", async () => {
            // patch getGasPrice to return new values
            (getGasPrice as any).mockResolvedValue({
                gasPrice: { value: 5555n },
                l1GasPrice: { value: 8888n },
            });
            // watchGasPrice with a short interval for test
            sharedState.unwatchGasPrice();
            sharedState.watchGasPrice(10);
            await sleep(100); // wait for new gas prices to be fetched

            expect(sharedState.gasPrice).toBe(5555n);
            expect(sharedState.l1GasPrice).toBe(8888n);

            sharedState.unwatchGasPrice();
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
        it("should call getMarketPrice with correct params", () => {
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
            sharedState.getMarketPrice(token1, token2, 12345n);
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
    });
});
