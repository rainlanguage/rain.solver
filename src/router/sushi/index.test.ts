import { ONE18 } from "../../math";
import { Order } from "../../order";
import { Dispair, Result } from "../../common";
import { RouteLeg } from "sushi/tines";
import { Token } from "sushi/currency";
import { SharedState } from "../../state";
import { maxUint256, PublicClient } from "viem";
import { RouterType, RouteStatus } from "../types";
import { LiquidityProviders, RainDataFetcher, Router } from "sushi";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    SushiRouter,
    SushiQuoteParams,
    SushiRouterError,
    SushiRouterErrorType,
    ExcludedLiquidityProviders,
} from ".";

// mock the sushi dependencies
vi.mock("sushi", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        RainDataFetcher: {
            init: vi.fn(),
        },
        Router: {
            findBestRoute: vi.fn(),
            routeProcessor4Params: vi.fn(),
        },
    };
});

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeAbiParameters: vi.fn().mockReturnValue("0xencodedData"),
}));

describe("test SushiRouter methods", () => {
    let router: SushiRouter;
    let mockSharedState: SharedState;
    let mockDataFetcher: RainDataFetcher;
    let mockClient: PublicClient;
    let dispair: Dispair;
    let destination: `0x${string}`;

    const chainId = 1;
    const routerAddress = "0xsushiRouter" as `0x${string}`;
    const gasPrice = 20000000000n;
    const mockTokenIn = new Token({
        address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
        decimals: 18,
        chainId: 1,
        symbol: "WETH",
    });

    const mockTokenOut = new Token({
        address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
        decimals: 6,
        chainId: 1,
        symbol: "USDC",
    });

    const mockSwapAmount = 1000000000000000000n; // 1 WETH

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";
        mockClient = {} as any;

        // Mock SharedState
        mockSharedState = {
            chainConfig: {
                id: 1,
                routeProcessors: {
                    "4": "0x123456789" as `0x${string}`,
                },
            },
            gasPrice: 20000000000n,
            client: {},
            appOptions: {
                liquidityProviders: ["lp1"],
            },
            contracts: {
                getAddressesForTrade: vi.fn().mockReturnValue({
                    dispair,
                    destination,
                }),
            },
        } as any;

        // Mock DataFetcher
        mockDataFetcher = {
            fetchPoolsForToken: vi.fn(),
            getCurrentPoolCodeMap: vi.fn(),
            updatePools: vi.fn(),
            providers: [
                { getPoolProviderName: () => "UniswapV2" },
                { getPoolProviderName: () => "UniswapV3" },
            ],
        } as any;

        router = new SushiRouter(chainId, mockClient, mockDataFetcher, routerAddress, [
            LiquidityProviders.UniswapV2,
        ]);
    });

    describe("test create static method", () => {
        it("should return a valid instance from shared state", async () => {
            (RainDataFetcher.init as Mock).mockResolvedValue(mockDataFetcher);

            const result = await SushiRouter.create(chainId, mockClient, routerAddress, [
                LiquidityProviders.UniswapV2,
            ]);
            assert(result.isOk());
            expect(result.value).toBeInstanceOf(SushiRouter);
            expect(RainDataFetcher.init).toHaveBeenCalledWith(chainId, mockClient, [
                LiquidityProviders.UniswapV2,
            ]);
        });

        it("should return error when RainDataFetcher.init fails", async () => {
            (RainDataFetcher.init as Mock).mockRejectedValue(new Error("Failed to initialize"));

            const result = await SushiRouter.create(chainId, mockClient, routerAddress, [
                LiquidityProviders.UniswapV2,
            ]);
            assert(result.isErr());
            expect(result.error).toBeInstanceOf(SushiRouterError);
            expect(RainDataFetcher.init).toHaveBeenCalledWith(chainId, mockClient, [
                LiquidityProviders.UniswapV2,
            ]);
        });

        it("should have correct router properties", () => {
            expect(router.routerAddress).toBe("0xsushiRouter");
            expect(router.protocolVersion).toBe(4);
            expect(router.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
            expect(router.dataFetcher).toBe(mockDataFetcher);
        });

        it("should handle undefined liquidity providers", () => {
            const routerWithoutLP = new SushiRouter(
                chainId,
                mockClient,
                mockDataFetcher,
                routerAddress,
            );

            expect(routerWithoutLP.liquidityProviders).toBeUndefined();
        });
    });

    describe("test getMarketPrice method", () => {
        it("should return price of 1 for same tokens", async () => {
            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenIn, // Same token
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.getMarketPrice(params);

            assert(result.isOk());
            expect(result.value.price).toBe("1");
        });

        it("should successfully get market price for different tokens", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: 3000000000n, // 3000 USDC
            };

            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");
            findBestRouteSpy.mockResolvedValue(
                Result.ok({
                    price: 3000000000000000000000n, // 3000 * 10^18
                    route: { route: mockRoute, pcMap: new Map() },
                    amountOut: 3000000000n,
                } as any),
            );

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.getMarketPrice(params);

            assert(result.isOk());
            expect(result.value.price).toBe("3000"); // formatUnits(3000 * 10^18, 18)
            expect(findBestRouteSpy).toHaveBeenCalledWith(params);

            findBestRouteSpy.mockRestore();
        });

        it("should return error when findBestRoute fails", async () => {
            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");
            findBestRouteSpy.mockResolvedValue(
                Result.err(
                    new SushiRouterError("No route found", SushiRouterErrorType.NoRouteFound),
                ),
            );

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.getMarketPrice(params);

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(SushiRouterError);
            expect(result.error.type).toBe(SushiRouterErrorType.NoRouteFound);

            findBestRouteSpy.mockRestore();
        });
    });

    describe("test tryQuote method", () => {
        it("should successfully return quote", async () => {
            const mockQuote = {
                price: 3000000000000000000000n,
                route: { route: {}, pcMap: new Map() },
                amountOut: 3000000000n,
                status: RouteStatus.Success,
            };

            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");
            findBestRouteSpy.mockResolvedValue(Result.ok(mockQuote as any));

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.tryQuote(params);

            assert(result.isOk());
            expect(result.value).toEqual(mockQuote);
            expect(findBestRouteSpy).toHaveBeenCalledWith(params);

            findBestRouteSpy.mockRestore();
        });

        it("should return error when findBestRoute fails", async () => {
            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");
            findBestRouteSpy.mockResolvedValue(
                Result.err(new SushiRouterError("Fetch failed", SushiRouterErrorType.FetchFailed)),
            );

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.tryQuote(params);

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(SushiRouterError);
            expect(result.error.type).toBe(SushiRouterErrorType.FetchFailed);

            findBestRouteSpy.mockRestore();
        });
    });

    describe("test findBestRoute method", () => {
        it("should successfully find best route without fetching", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: 2000000000n,
            };
            const mockPcMap = new Map();

            (mockDataFetcher.getCurrentPoolCodeMap as Mock).mockReturnValue(mockPcMap);
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute);

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                skipFetch: true,
                gasPrice,
            };

            const result = await router.findBestRoute(params);

            assert(result.isOk());
            expect(result.value.price).toBe(2000000000000000000000n);
            expect(result.value.route.route).toBe(mockRoute);
            expect(result.value.route.pcMap).toBe(mockPcMap);
            expect(result.value.amountOut).toBe(2000000000n);
            expect(result.value.status).toBe(RouteStatus.Success);

            expect(mockDataFetcher.fetchPoolsForToken).not.toHaveBeenCalled();
            expect(mockDataFetcher.getCurrentPoolCodeMap).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
            );
        });

        it("should successfully find best route with fetching", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: 2000000000n,
            };
            const mockPcMap = new Map();

            (mockDataFetcher.fetchPoolsForToken as Mock).mockResolvedValue(undefined);
            (mockDataFetcher.getCurrentPoolCodeMap as Mock).mockReturnValue(mockPcMap);
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute);

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                blockNumber: 18000000n,
                ignoreCache: true,
                gasPrice,
            };

            const result = await router.findBestRoute(params);

            assert(result.isOk());
            expect(result.value.price).toBe(2000000000000000000000n);
            expect(result.value.amountOut).toBe(2000000000n);
            expect(result.value.status).toBe(RouteStatus.Success);

            expect(mockDataFetcher.fetchPoolsForToken).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
                expect.any(Set), // BlackListSet
                {
                    blockNumber: 18000000n,
                    ignoreCache: true,
                },
            );

            delete params.ignoreCache;
            const result2 = await router.findBestRoute(params);

            assert(result2.isOk());
            expect(result2.value.price).toBe(2000000000000000000000n);
            expect(result2.value.amountOut).toBe(2000000000n);
            expect(result2.value.status).toBe(RouteStatus.Success);

            expect(mockDataFetcher.fetchPoolsForToken).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
                expect.any(Set), // BlackListSet
                {
                    blockNumber: 18000000n,
                    ignoreCache: undefined,
                },
            );
        });

        it("should return NoRouteFound error when router finds no way", async () => {
            const mockRoute = {
                status: "NoWay",
            };

            (mockDataFetcher.getCurrentPoolCodeMap as Mock).mockReturnValue(new Map());
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute);

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                skipFetch: true,
                gasPrice,
            };

            const result = await router.findBestRoute(params);

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(SushiRouterError);
            expect(result.error.type).toBe(SushiRouterErrorType.NoRouteFound);
            expect(result.error.message).toBe(
                "Sushi router found no route for the given token pair",
            );
        });

        it("should return FetchFailed error when fetching pools throws", async () => {
            const mockError = new Error("Network error");
            (mockDataFetcher.fetchPoolsForToken as Mock).mockRejectedValue(mockError);

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.findBestRoute(params);

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(SushiRouterError);
            expect(result.error.type).toBe(SushiRouterErrorType.FetchFailed);
            expect(result.error.message).toBe(
                "Failed to get sushi router pool data for the given token pair",
            );
            expect(result.error.cause).toBe(mockError);
        });

        it("should use default parameters when not provided", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: 3000000000n,
            };

            (mockDataFetcher.fetchPoolsForToken as Mock).mockResolvedValue(undefined);
            (mockDataFetcher.getCurrentPoolCodeMap as Mock).mockReturnValue(new Map());
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute);

            const params: SushiQuoteParams = {
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            };

            const result = await router.findBestRoute(params);

            assert(result.isOk());
            expect(mockDataFetcher.fetchPoolsForToken).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
                expect.any(Set),
                {
                    blockNumber: undefined,
                    ignoreCache: undefined,
                },
            );
        });
    });

    describe("test update method", () => {
        it("should update pools without block number", async () => {
            (mockDataFetcher.updatePools as Mock).mockResolvedValue(undefined);

            await router.update();

            expect(mockDataFetcher.updatePools).toHaveBeenCalledWith(undefined);
        });

        it("should update pools with specific block number", async () => {
            const blockNumber = 18000000n;
            (mockDataFetcher.updatePools as Mock).mockResolvedValue(undefined);

            await router.update(blockNumber);

            expect(mockDataFetcher.updatePools).toHaveBeenCalledWith(blockNumber);
        });
    });

    describe("test reset method", () => {
        it("should reset data fetcher successfully", async () => {
            const newMockDataFetcher = {
                fetchPoolsForToken: vi.fn(),
                getCurrentPoolCodeMap: vi.fn(),
                updatePools: vi.fn(),
                providers: [],
            };

            (RainDataFetcher.init as Mock).mockResolvedValue(newMockDataFetcher);

            await router.reset();

            expect(RainDataFetcher.init).toHaveBeenCalledWith(
                1, // chainConfig.id
                mockSharedState.client,
                [LiquidityProviders.UniswapV2], // liquidityProviders
            );
            expect(router.dataFetcher).toBe(newMockDataFetcher);
        });

        it("should handle reset failure silently", async () => {
            const originalDataFetcher = router.dataFetcher;
            (RainDataFetcher.init as Mock).mockRejectedValue(new Error("Init failed"));

            await router.reset();

            // Should not throw and keep original data fetcher
            expect(router.dataFetcher).toBe(originalDataFetcher);
        });
    });

    describe("test getLiquidityProvidersList method", () => {
        it("should return list of liquidity provider names", () => {
            const result = router.getLiquidityProvidersList();

            expect(result).toEqual(["UniswapV2", "UniswapV3"]);
            expect(result).toHaveLength(2);
        });

        it("should return empty list when no providers", () => {
            router.dataFetcher.providers = [];

            const result = router.getLiquidityProvidersList();

            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });
    });

    describe("Test processLiquidityProviders", () => {
        it("should return all providers except excluded when input is undefined", () => {
            const result = SushiRouter.processLiquidityProviders();
            ExcludedLiquidityProviders.forEach((lp) => {
                expect(result).not.toContain(lp);
            });
            // should contain at least one included provider
            expect(result.length).toBeGreaterThan(0);
        });

        it("should return all providers except excluded when input is empty", () => {
            const result = SushiRouter.processLiquidityProviders([]);
            ExcludedLiquidityProviders.forEach((lp) => {
                expect(result).not.toContain(lp);
            });
            expect(result.length).toBeGreaterThan(0);
        });

        it("should return only valid providers from input (case-insensitive)", () => {
            const input = ["UniswapV2", "uniswapv3", "curveSwap", "camelot", "notAProvider"];
            const result = SushiRouter.processLiquidityProviders(input);
            expect(result).toContain(LiquidityProviders.UniswapV2);
            expect(result).toContain(LiquidityProviders.UniswapV3);
            expect(result).toContain(LiquidityProviders.CurveSwap);
            expect(result).toContain(LiquidityProviders.Camelot);
            expect(result).not.toContain("notAProvider" as any);
        });

        it("should ignore invalid providers and return filtered list", () => {
            const input = ["notAProvider", "anotherFake"];
            const result = SushiRouter.processLiquidityProviders(input);
            ExcludedLiquidityProviders.forEach((lp) => {
                expect(result).not.toContain(lp);
            });
            expect(result.length).toBeGreaterThan(0);
        });

        it("should not include duplicates", () => {
            const input = ["UniswapV2", "uniswapv2", "UNISWAPV2"];
            const result = SushiRouter.processLiquidityProviders(input);
            const count = result.filter((lp) => lp === LiquidityProviders.UniswapV2).length;
            expect(count).toBe(1);
        });
    });

    describe("Test visualizeRoute", () => {
        function makeToken(address: string, symbol: string): Token {
            return { address, symbol, decimals: 18 } as any;
        }

        function makeLeg(
            from: any,
            to: any,
            poolAddress: string,
            poolName: string,
            absolutePortion: number,
        ): RouteLeg {
            return {
                tokenFrom: from,
                tokenTo: to,
                poolAddress,
                poolName,
                absolutePortion,
            } as any;
        }
        const tokenA = makeToken("0xA", "A");
        const tokenB = makeToken("0xB", "B");
        const tokenC = makeToken("0xC", "C");

        it("should return direct route string", () => {
            const legs = [makeLeg(tokenA, tokenB, "0xPool1", "Pool1", 0.8)];
            const result = SushiRouter.visualizeRoute(tokenA, tokenB, legs);
            expect(result.length).toBe(1);
            expect(result[0]).toContain("80.00%");
            expect(result[0]).toContain("B/A (Pool1 0xPool1)");
        });

        it("should return indirect route string", () => {
            const legs = [
                makeLeg(tokenA, tokenC, "0xPool1", "Pool1", 0.5),
                makeLeg(tokenC, tokenB, "0xPool2", "Pool2", 0.5),
            ];
            const result = SushiRouter.visualizeRoute(tokenA, tokenB, legs);
            expect(result.length).toBe(1);
            expect(result[0]).toContain("50.00%");
            expect(result[0]).toContain("C/A (Pool1 0xPool1) >> B/C (Pool2 0xPool2)");
        });

        it("should sort routes by absolutePortion descending", () => {
            const legs = [
                makeLeg(tokenA, tokenB, "0xPool1", "Pool1", 0.2),
                makeLeg(tokenA, tokenC, "0xPool2", "Pool2", 0.7),
                makeLeg(tokenC, tokenB, "0xPool3", "Pool3", 0.7),
            ];
            const result = SushiRouter.visualizeRoute(tokenA, tokenB, legs);
            expect(result.length).toBe(2);
            // First route should be the one with 0.7 portion
            expect(result[0]).toContain("70.00%");
            expect(result[1]).toContain("20.00%");
        });

        it("should handle unknown symbols gracefully", () => {
            const tokenUnknown = { address: "0xD" }; // no symbol
            const legs = [
                makeLeg(tokenA, tokenUnknown, "0xPool1", "Pool1", 0.6),
                makeLeg(tokenUnknown, tokenB, "0xPool2", "Pool2", 0.6),
            ];
            const result = SushiRouter.visualizeRoute(tokenA, tokenB, legs);
            expect(result[0]).toContain("unknownSymbol");
        });

        it("should return empty array if no valid routes", () => {
            const legs = [makeLeg(tokenC, tokenA, "0xPool1", "Pool1", 0.5)];
            const result = SushiRouter.visualizeRoute(tokenA, tokenB, legs);
            expect(result).toEqual([]);
        });
    });

    describe("test getTradeParams method", () => {
        let mockOrderDetails: any;
        let mockGetTradeParamsArgs: any;

        beforeEach(() => {
            // Mock order details
            mockOrderDetails = {
                takeOrder: {
                    struct: {
                        order: { type: Order.Type.V3 },
                        inputIOIndex: 0,
                        outputIOIndex: 0,
                        signedContext: [],
                    },
                    quote: {
                        ratio: 3000n * ONE18, // 3000 price ratio
                    },
                },
            };

            // Mock GetTradeParamsArgs
            mockGetTradeParamsArgs = {
                state: {
                    gasPrice: gasPrice,
                    appOptions: {
                        maxRatio: true,
                    },
                    contracts: {
                        getAddressesForTrade: vi.fn().mockReturnValue({
                            dispair,
                            destination,
                        }),
                    },
                    chainConfig: {
                        routeProcessors: {
                            "4": "0xrouteProcessor4" as `0x${string}`,
                        },
                    },
                },
                maximumInput: mockSwapAmount,
                orderDetails: mockOrderDetails,
                toToken: mockTokenOut,
                fromToken: mockTokenIn,
                blockNumber: 18000000n,
                isPartial: false,
            };
        });

        it("should successfully return trade params for full trade", async () => {
            const mockQuote = {
                type: RouterType.Sushi as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: {
                    route: {
                        status: "Success",
                        legs: [
                            {
                                tokenFrom: mockTokenIn,
                                tokenTo: mockTokenOut,
                                poolAddress: "0xpool1",
                                poolName: "UniswapV3",
                                absolutePortion: 1.0,
                            } as any as RouteLeg,
                        ],
                    },
                    pcMap: new Map(),
                } as any,
                amountOut: 3000000000n,
            };

            const mockRpParams = {
                routeCode: "0xrouteCode" as `0x${string}`,
            };

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visSpy = vi.spyOn(SushiRouter, "visualizeRoute");
            visSpy.mockReturnValue(["some route"]);

            const routeProcessor4ParamsSpy = vi.spyOn(Router, "routeProcessor4Params");
            routeProcessor4ParamsSpy.mockReturnValue(mockRpParams as any);

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Sushi);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual(["some route"]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(visSpy).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
                mockQuote.route.route.legs,
            );
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice: gasPrice,
                blockNumber: 18000000n,
                skipFetch: true,
            });
            expect(routeProcessor4ParamsSpy).toHaveBeenCalledWith(
                mockQuote.route.pcMap,
                mockQuote.route.route,
                mockTokenIn,
                mockTokenOut,
                "0xdestination",
                "0xrouteProcessor4",
            );

            visSpy.mockRestore();
            tryQuoteSpy.mockRestore();
            routeProcessor4ParamsSpy.mockRestore();
        });

        it("should successfully return trade params for partial trade size and maxRatio false", async () => {
            const mockQuote = {
                type: RouterType.Sushi as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: {
                    route: { status: "Success", legs: [] },
                    pcMap: new Map(),
                } as any,
                amountOut: 3000000000n,
            };

            const mockRpParams = {
                routeCode: "0xrouteCode" as `0x${string}`,
            };

            mockGetTradeParamsArgs.isPartial = true;
            mockGetTradeParamsArgs.state.appOptions.maxRatio = false;

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visSpy = vi.spyOn(SushiRouter, "visualizeRoute");
            visSpy.mockReturnValue(["some route"]);

            const routeProcessor4ParamsSpy = vi.spyOn(Router, "routeProcessor4Params");
            routeProcessor4ParamsSpy.mockReturnValue(mockRpParams as any);

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Sushi);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual(["some route"]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(mockSwapAmount);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(3000n * ONE18);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(visSpy).toHaveBeenCalledWith(
                mockTokenIn,
                mockTokenOut,
                mockQuote.route.route.legs,
            );
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice: gasPrice,
                blockNumber: 18000000n,
                skipFetch: true,
            });
            expect(routeProcessor4ParamsSpy).toHaveBeenCalledWith(
                mockQuote.route.pcMap,
                mockQuote.route.route,
                mockTokenIn,
                mockTokenOut,
                "0xdestination",
                "0xrouteProcessor4",
            );

            visSpy.mockRestore();
            tryQuoteSpy.mockRestore();
            routeProcessor4ParamsSpy.mockRestore();
        });

        it("should return error when tryQuote fails", async () => {
            const mockError = new SushiRouterError(
                "No route found",
                SushiRouterErrorType.NoRouteFound,
            );

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.err(mockError));

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());
            expect(result.error).toBe(mockError);
            expect(result.error.type).toBe(SushiRouterErrorType.NoRouteFound);

            tryQuoteSpy.mockRestore();
        });

        it("should return error when fails to get trade addresses", async () => {
            (
                mockGetTradeParamsArgs.state.contracts.getAddressesForTrade as Mock
            ).mockReturnValueOnce(undefined);

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());
            expect(result.error.message).toContain(
                "Sushi RouterProcessor contract not configured for trading order",
            );
            expect(result.error.type).toBe(SushiRouterErrorType.UndefinedTradeDestinationAddress);
        });

        it("should return error when getTakeOrdersConfig fails", async () => {
            const mockQuote = {
                type: RouterType.Sushi as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: {
                    route: {
                        status: "Success",
                        legs: [
                            {
                                tokenFrom: mockTokenIn,
                                tokenTo: mockTokenOut,
                                poolAddress: "0xpool1",
                                poolName: "UniswapV3",
                                absolutePortion: 1.0,
                            } as any as RouteLeg,
                        ],
                    },
                    pcMap: new Map(),
                } as any,
                amountOut: 3000000000n,
            };

            const mockRpParams = {
                routeCode: "0xrouteCode" as `0x${string}`,
            };

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visSpy = vi.spyOn(SushiRouter, "visualizeRoute");
            visSpy.mockReturnValue(["some route"]);

            const routeProcessor4ParamsSpy = vi.spyOn(Router, "routeProcessor4Params");
            routeProcessor4ParamsSpy.mockReturnValue(mockRpParams as any);

            const getTakeOrdersConfigSpy = vi.spyOn(router, "getTakeOrdersConfig");
            getTakeOrdersConfigSpy.mockReturnValue(
                Result.err({ msg: "", readableMsg: "some error" }),
            );

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());

            expect(result.error.message).toContain("Failed to build TakeOrdersConfig struct");
            expect(result.error.type).toBe(SushiRouterErrorType.WasmEncodedError);
            expect(result.error.cause).toEqual({ msg: "", readableMsg: "some error" });
            expect(getTakeOrdersConfigSpy).toHaveBeenCalledWith(
                mockGetTradeParamsArgs.orderDetails,
                mockGetTradeParamsArgs.maximumInput,
                mockQuote.price,
                "0xencodedData",
                mockGetTradeParamsArgs.state.appOptions.maxRatio,
                mockGetTradeParamsArgs.isPartial,
            );

            visSpy.mockRestore();
            tryQuoteSpy.mockRestore();
            routeProcessor4ParamsSpy.mockRestore();
            getTakeOrdersConfigSpy.mockRestore();
        });
    });

    describe("Test findLargestTradeSize", () => {
        let fromToken: Token;
        let toToken: Token;
        let maximumInputFixed: bigint;

        function makeOrderDetails(ratio = 1n * ONE18): any {
            return {
                orderbook: "0xorderbook",
                sellTokenDecimals: 18,
                buyTokenDecimals: 18,
                takeOrder: { struct: {}, quote: { ratio } },
            } as any;
        }

        beforeEach(() => {
            vi.clearAllMocks();
            fromToken = { address: "0xFrom", decimals: 18 } as any;
            toToken = { address: "0xTo", decimals: 18 } as any;
            maximumInputFixed = 10n * ONE18;
        });

        it("should return undefined if no valid trade size found (all NoWay)", () => {
            (Router.findBestRoute as Mock).mockReturnValue({ status: "NoWay" });

            const result = router.findLargestTradeSize(
                makeOrderDetails(1n * ONE18),
                toToken,
                fromToken,
                maximumInputFixed,
                gasPrice,
            );

            expect(result).toBeUndefined();
        });

        it("should return the largest valid trade size when some routes are valid", () => {
            (Router.findBestRoute as Mock).mockImplementation(() => {
                return { status: "OK", amountOutBI: 4n * ONE18 };
            });

            const orderDetails = makeOrderDetails(1n * ONE18);

            const result = router.findLargestTradeSize(
                orderDetails,
                toToken,
                fromToken,
                maximumInputFixed,
                gasPrice,
            );

            expect(typeof result).toBe("bigint");
            expect(result).toBe(3999999761581420898n);
        });

        it("should return undefined if all OK routes have price < ratio", () => {
            (Router.findBestRoute as Mock).mockImplementation(() => ({
                status: "OK",
                amountOutBI: 1n, // price = 1
            }));
            const orderDetails = makeOrderDetails(2n * ONE18); // ratio = 2

            const result = router.findLargestTradeSize(
                orderDetails,
                toToken,
                fromToken,
                maximumInputFixed,
                gasPrice,
            );

            expect(result).toBeUndefined();
        });

        it("should handle fromToken decimals other than 18", () => {
            fromToken = { address: "0xFrom", decimals: 6 } as any;
            (Router.findBestRoute as Mock).mockReturnValue({
                status: "OK",
                amountOutBI: 2n * ONE18,
            });
            const orderDetails = makeOrderDetails(1n * ONE18);

            const result = router.findLargestTradeSize(
                orderDetails,
                toToken,
                fromToken,
                maximumInputFixed,
                gasPrice,
            );

            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
        });
    });
});
