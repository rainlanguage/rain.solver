import { ONE18 } from "../../math";
import { Order } from "../../order";
import { Token } from "sushi/currency";
import { AddressProvider } from "@balancer/sdk";
import { RouterType, RouteStatus } from "../types";
import { Result, TokenDetails } from "../../common";
import { encodeAbiParameters, maxUint256, PublicClient } from "viem";
import { BalancerRouterError, BalancerRouterErrorType } from "../error";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { BalancerRouter, BalancerRouterPath, BalancerCachedRoute } from ".";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeAbiParameters: vi.fn().mockReturnValue("0xencodedData"),
}));

vi.mock("@balancer/sdk", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        BalancerApi: vi.fn().mockImplementation(() => ({
            sorSwapPaths: {
                fetchSorSwapPaths: vi.fn(),
            },
        })),
    };
});

describe("test BalancerRouter", () => {
    let mockClient: PublicClient;
    const chainId = 1;
    const mockTokenIn = new Token({
        chainId: 1,
        address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
        decimals: 18,
        symbol: "WETH",
    });

    const mockTokenOut = new Token({
        chainId: 1,
        address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
        decimals: 6,
        symbol: "USDC",
    });

    const mockSwapAmount = 1000000000000000000n; // 1 WETH
    const routerAddress = AddressProvider.BatchRouter(chainId);

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            simulateContract: vi.fn(),
        } as any;
    });

    describe("test init method", () => {
        it("should successfully initialize BalancerRouter for supported chain", async () => {
            const chainId = 1; // Ethereum mainnet - supported by Balancer v3

            const result = await BalancerRouter.create(chainId, mockClient, routerAddress);

            assert(result.isOk());
            if (result.isOk()) {
                const router = result.value;
                expect(router).toBeInstanceOf(BalancerRouter);
                expect(router.chainId).toBe(chainId);
                expect(router.protocolVersion).toBe(3);
                expect(router.routeTime).toBe(300_000);
                expect(router.routerAddress).toBeDefined();
                expect(router.balancerApi).toBeDefined();
                expect(router.cache).toBeInstanceOf(Map);
                expect(router.cache.size).toBe(0);
            }
        });
    });

    describe("test fetchSortedRoutes method", () => {
        let router: BalancerRouter;
        let mockBalancerApi: { sorSwapPaths: { fetchSorSwapPaths: Mock } };

        beforeEach(async () => {
            const routerResult = await BalancerRouter.create(chainId, mockClient, routerAddress);
            if (routerResult.isOk()) {
                router = routerResult.value;
                mockBalancerApi = (router as any).balancerApi;
            }
        });

        it("should successfully fetch sorted routes", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n, // 3000 USDC
                    isBuffer: [false],
                },
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: "0xintermediatetoken", decimals: 6 },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool2", "0xpool3"],
                    inputAmountRaw: mockSwapAmount / 2n,
                    outputAmountRaw: 1500000000n, // 1500 USDC
                    isBuffer: [false, false],
                },
            ];
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            const result = await router.fetchSortedRoutes({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            const routes = result.value;
            expect(routes).toHaveLength(2);

            // check first route
            expect(routes[0].tokenIn).toBe(mockTokenIn.address.toLowerCase());
            expect(routes[0].steps).toHaveLength(1);
            expect(routes[0].steps[0].pool).toBe("0xpool1");
            expect(routes[0].steps[0].tokenOut).toBe(mockTokenOut.address);
            expect(routes[0].steps[0].isBuffer).toBe(false);

            // check second route (multi-hop)
            expect(routes[1].tokenIn).toBe(mockTokenIn.address.toLowerCase());
            expect(routes[1].steps).toHaveLength(2);
            expect(routes[1].steps[0].pool).toBe("0xpool2");
            expect(routes[1].steps[0].tokenOut).toBe("0xintermediatetoken");
            expect(routes[1].steps[1].pool).toBe("0xpool3");
            expect(routes[1].steps[1].tokenOut).toBe(mockTokenOut.address);

            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledWith({
                chainId: 1,
                tokenIn: mockTokenIn.address.toLowerCase(),
                tokenOut: mockTokenOut.address.toLowerCase(),
                swapKind: 0, // SwapKind.GivenIn
                swapAmount: expect.any(Object), // TokenAmount instance
                useProtocolVersion: 3,
            });
        });

        it("should return NoRouteFound error when no routes available", async () => {
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue([]);

            const result = await router.fetchSortedRoutes({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.NoRouteFound);
            expect(error.message).toBe("Found no balancer route for given token pair");
        });

        it("should return FetchFailed error when API call throws", async () => {
            const mockError = new Error("Network error");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockRejectedValue(mockError);

            const result = await router.fetchSortedRoutes({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.FetchFailed);
            expect(error.message).toBe("Failed to fetch balancer routes");
            expect(error.cause).toBe(mockError);
        });

        it("should handle tokens without symbols", async () => {
            const tokenWithoutSymbol = new Token({
                address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                decimals: 18,
                chainId: 1,
                // no symbol property
            });

            const mockSorPaths = [
                {
                    tokens: [
                        {
                            address: tokenWithoutSymbol.address,
                            decimals: tokenWithoutSymbol.decimals,
                        },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            const result = await router.fetchSortedRoutes({
                fromToken: tokenWithoutSymbol,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            expect(result.value).toHaveLength(1);

            // verify that the Token constructor was called with "unknownSymbol"
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledWith(
                expect.objectContaining({
                    tokenIn: tokenWithoutSymbol.address.toLowerCase(),
                    tokenOut: mockTokenOut.address.toLowerCase(),
                }),
            );
        });

        it("should handle buffer pools correctly", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: "0xbufferedtoken", decimals: 6 },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xbufferpool", "0xregularpool"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [true, false], // First pool is buffer
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            const result = await router.fetchSortedRoutes({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            const routes = result.value;
            expect(routes[0].steps).toHaveLength(2);
            expect(routes[0].steps[0].isBuffer).toBe(true);
            expect(routes[0].steps[1].isBuffer).toBe(false);
        });
    });

    describe("test findBestRoute method", () => {
        let router: BalancerRouter;
        let mockBalancerApi: { sorSwapPaths: { fetchSorSwapPaths: Mock } };

        beforeEach(async () => {
            const routerResult = await BalancerRouter.create(chainId, mockClient, routerAddress);
            if (routerResult.isOk()) {
                router = routerResult.value;
                router.cache.clear(); // clear cache before each test
                mockBalancerApi = (router as any).balancerApi;
            }
        });

        it("should successfully get best route and cache it", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n, // 3000 USDC
                    isBuffer: [false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            const cachedRoute = result.value;
            expect(cachedRoute.route).toHaveLength(1);
            expect(cachedRoute.route[0].tokenIn).toBe(mockTokenIn.address.toLowerCase());
            expect(cachedRoute.route[0].exactAmountIn).toBe(mockSwapAmount);
            expect(cachedRoute.route[0].minAmountOut).toBe(3000000000n);
            expect(cachedRoute.route[0].steps).toHaveLength(1);
            expect(cachedRoute.route[0].steps[0].pool).toBe("0xpool1");
            expect(cachedRoute.price).toBeGreaterThan(0n);
            expect(cachedRoute.validUntil).toBeGreaterThan(Date.now());
            expect(cachedRoute.type).toBe(RouterType.Balancer);
            expect(cachedRoute.amountOut).toBe(3000000000n);
            expect(cachedRoute.status).toBe(RouteStatus.Success);

            // verify route was cached
            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            expect(router.cache.has(cacheKey)).toBe(true);
            expect(router.cache.get(cacheKey)).toEqual(cachedRoute);
        });

        it("should return cached route when available and not expired", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            // First call - should fetch from API
            const firstResult = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(firstResult.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);

            // Second call - should return from cache
            const secondResult = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(secondResult.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1); // No additional API call
            expect(secondResult.value).toEqual(firstResult.value);
        });

        it("should return error when cached route is NoWay", async () => {
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue([]);
            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;

            // first call to populate cache with NoWay
            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });
            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.NoRouteFound);
            expect(error.message).toBe("Found no balancer route for given token pair");
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);
            expect(router.cache.has(cacheKey)).toBe(true);
            expect(router.cache.get(cacheKey)?.status).toBe(RouteStatus.NoWay);

            // second call should hit cache and return same error
            const result2 = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });
            assert(result2.isErr());
            const error2 = result2.error;
            expect(error2).toBeInstanceOf(BalancerRouterError);
            expect(error2.type).toBe(BalancerRouterErrorType.NoRouteFound);
            expect(error2.message).toBe("Found no balancer route for given token pair");
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1); // no additional call
            expect(router.cache.has(cacheKey)).toBe(true);
            expect(router.cache.get(cacheKey)?.status).toBe(RouteStatus.NoWay);
        });

        it("should ignore cache when ignoreCache is true", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            // First call
            await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);

            // Second call with ignoreCache: true
            await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: true,
            });

            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(2); // Additional API call
        });

        it("should fetch new route when cache is expired", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            // manually add expired cache entry
            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            const expiredRoute: BalancerCachedRoute = {
                type: RouterType.Balancer,
                status: RouteStatus.Success,
                route: [
                    {
                        tokenIn: mockTokenIn.address as `0x${string}`,
                        exactAmountIn: mockSwapAmount,
                        minAmountOut: 2000000000n,
                        steps: [
                            {
                                pool: "0xoldpool" as `0x${string}`,
                                tokenOut: mockTokenOut.address as `0x${string}`,
                                isBuffer: false,
                            },
                        ],
                    },
                ],
                altRoutes: [],
                validUntil: Date.now() - 1000, // Expired 1 second ago
                price: 2000000000000000000000n,
                amountOut: 2000000000n,
            };
            router.cache.set(cacheKey, expiredRoute);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);
            expect(result.value.route[0].minAmountOut).toBe(3000000000n); // New route data
            expect(result.value.route[0].steps[0].pool).toBe("0xpool1"); // New pool
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.amountOut).toBe(3000000000n);
            expect(result.value.status).toBe(RouteStatus.Success);
        });

        it("should return error when fetchSortedRoutes fails", async () => {
            const mockError = new Error("Network error");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockRejectedValue(mockError);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.FetchFailed);
            expect(error.cause).toBe(mockError);

            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            expect(router.cache.has(cacheKey)).toBe(true);
            expect(router.cache.get(cacheKey)?.status).toBe(RouteStatus.NoWay);
        });

        it("should return error when no routes found", async () => {
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue([]);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.NoRouteFound);
            expect(error.message).toBe("Found no balancer route for given token pair");

            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            expect(router.cache.has(cacheKey)).toBe(true);
            expect(router.cache.get(cacheKey)?.status).toBe(RouteStatus.NoWay);
        });

        it("should calculate price correctly for multiple routes", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount / 2n, // 0.5 WETH
                    outputAmountRaw: 1500000000n, // 1500 USDC
                    isBuffer: [false],
                },
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: "0xintermediatetoken", decimals: 6 },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool2", "0xpool3"],
                    inputAmountRaw: mockSwapAmount / 2n, // 0.5 WETH
                    outputAmountRaw: 1600000000n, // 1600 USDC
                    isBuffer: [false, false],
                },
            ];

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            const cachedRoute = result.value;

            // Should use the first route only
            expect(cachedRoute.route[0].minAmountOut).toBe(3100000000n); // 1500 + 1600 = 3100 USDC total
            expect(cachedRoute.route[0].exactAmountIn).toBe(mockSwapAmount);

            // Price should be calculated based on total output
            const expectedAmountOut18 = 3100000000000000000000n; // 3100 * 10^18 (scaled to 18 decimals)
            const expectedAmountIn18 = 1000000000000000000n; // 1 ETH in 18 decimals
            const expectedPrice = (expectedAmountOut18 * 1000000000000000000n) / expectedAmountIn18;
            expect(cachedRoute.price).toBe(expectedPrice);
        });
    });

    describe("test tryQuote method", () => {
        let router: BalancerRouter;
        let mockBalancerApi: { sorSwapPaths: { fetchSorSwapPaths: Mock } };

        beforeEach(async () => {
            const routerResult = await BalancerRouter.create(chainId, mockClient, routerAddress);
            if (routerResult.isOk()) {
                router = routerResult.value;
                router.cache.clear(); // clear cache before each test
                mockBalancerApi = (router as any).balancerApi;
            }
        });

        it("should successfully get quote with onchain simulation", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n, // 3000 USDC
                    isBuffer: [false],
                },
            ];

            const mockSimulationResult = {
                result: [null, null, [3100000000n]], // querySwapExactIn returns [,,[amountOut]]
            };

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);
            (mockClient.simulateContract as Mock).mockResolvedValue(mockSimulationResult);

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isOk());
            const quote = result.value;
            expect(quote.amountOut).toBe(3100000000n);
            expect(quote.price).toBeGreaterThan(0n);
            expect(quote.route).toHaveLength(1);
            expect(quote.route[0].tokenIn).toBe(mockTokenIn.address.toLowerCase());
            expect(quote.route[0].steps[0].pool).toBe("0xpool1");
            expect(quote.type).toBe(RouterType.Balancer);
            expect(quote.status).toBe(RouteStatus.Success);

            // verify simulation was called with correct parameters
            expect(mockClient.simulateContract).toHaveBeenCalledWith({
                address: router.routerAddress,
                abi: expect.any(Array),
                functionName: "querySwapExactIn",
                args: [expect.any(Array), `0x${"1".repeat(40)}`, "0x"],
            });
        });

        it("should use sender address when provided", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            const mockSimulationResult = {
                result: [null, null, [3100000000n]],
            };

            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);
            (mockClient.simulateContract as Mock).mockResolvedValue(mockSimulationResult);

            const customAddress = "0x9999999999999999999999999999999999999999" as `0x${string}`;

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                senderAddress: customAddress,
            });

            assert(result.isOk());
            expect(mockClient.simulateContract).toHaveBeenCalledWith({
                address: router.routerAddress,
                abi: expect.any(Array),
                functionName: "querySwapExactIn",
                args: [expect.any(Array), customAddress, "0x"],
            });
        });

        it("should return error when findBestRoute fails", async () => {
            const mockError = new Error("Network error");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockRejectedValue(mockError);

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.FetchFailed);
            expect(error.cause).toBe(mockError);
        });

        it("should return SwapQueryFailed error when simulation throws", async () => {
            const mockSorPaths = [
                {
                    tokens: [
                        { address: mockTokenIn.address, decimals: mockTokenIn.decimals },
                        { address: mockTokenOut.address, decimals: mockTokenOut.decimals },
                    ],
                    pools: ["0xpool1"],
                    inputAmountRaw: mockSwapAmount,
                    outputAmountRaw: 3000000000n,
                    isBuffer: [false],
                },
            ];

            const simulationError = new Error("Simulation failed");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue(mockSorPaths);
            (mockClient.simulateContract as Mock).mockRejectedValue(simulationError);

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.SwapQueryFailed);
            expect(error.message).toBe(
                "Swap query execution failed for the given route to get market price",
            );
            expect(error.cause).toBe(simulationError);
        });
    });

    describe("test visualizeRoute method", () => {
        const mockTokenDetails = new Map<string, TokenDetails>([
            [
                "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b",
                {
                    address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                    decimals: 18,
                    symbol: "WETH",
                },
            ],
            [
                "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b",
                {
                    address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                    decimals: 6,
                    symbol: "USDC",
                },
            ],
            [
                "0xa2b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b",
                {
                    address: "0xa2b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                    decimals: 18,
                    symbol: "DAI",
                },
            ],
        ]);

        it("should visualize multiple routes with correct percentages", () => {
            const route: BalancerRouterPath[] = [
                {
                    tokenIn: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                    exactAmountIn: 700000000000000000n, // 0.7 WETH (70%)
                    minAmountOut: 2100000000n, // 2100 USDC
                    steps: [
                        {
                            pool: "0xpool1" as `0x${string}`,
                            tokenOut: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            isBuffer: false,
                        },
                    ],
                },
                {
                    tokenIn: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                    exactAmountIn: 300000000000000000n, // 0.3 WETH (30%)
                    minAmountOut: 900000000n, // 900 USDC
                    steps: [
                        {
                            pool: "0xpool2" as `0x${string}`,
                            tokenOut: "0xa2b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`, // DAI
                            isBuffer: true,
                        },
                        {
                            pool: "0xpool3" as `0x${string}`,
                            tokenOut: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`, // USDC
                            isBuffer: false,
                        },
                    ],
                },
            ];

            const result = BalancerRouter.visualizeRoute(route, mockTokenDetails);

            expect(result).toHaveLength(2);
            expect(result[0]).toBe("70.00%   --->   USDC/WETH (pool 0xpool1)");
            expect(result[1]).toBe(
                "30.00%   --->   DAI/WETH (pool 0xpool2) >> USDC/DAI (pool 0xpool3)",
            );
        });

        it("should handle unknown tokens gracefully", () => {
            const route: BalancerRouterPath[] = [
                {
                    tokenIn: "0xunknowntoken1" as `0x${string}`,
                    exactAmountIn: 1000000000000000000n,
                    minAmountOut: 3000000000n,
                    steps: [
                        {
                            pool: "0xpool1" as `0x${string}`,
                            tokenOut: "0xunknowntoken2" as `0x${string}`,
                            isBuffer: false,
                        },
                    ],
                },
            ];

            const result = BalancerRouter.visualizeRoute(route, mockTokenDetails);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe("100.00%   --->   unknownSymbol/unknownSymbol (pool 0xpool1)");
        });
    });

    describe("test convertToRoutePaths method", () => {
        it("should convert single path to BalancerRouterPath correctly", () => {
            const mockPaths = [
                {
                    tokens: [
                        {
                            address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            decimals: 18,
                        },
                        {
                            address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            decimals: 6,
                        },
                    ],
                    pools: ["0xpool1" as `0x${string}`],
                    inputAmountRaw: 1000000000000000000n, // 1 WETH
                    outputAmountRaw: 3000000000n, // 3000 USDC
                    isBuffer: [false],
                    protocolVersion: 3 as const,
                },
            ];

            const result = BalancerRouter.convertToRoutePaths(mockPaths);

            expect(result).toHaveLength(1);
            expect(result[0].tokenIn).toBe("0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b");
            expect(result[0].exactAmountIn).toBe(1000000000000000000n);
            expect(result[0].minAmountOut).toBe(3000000000n);
            expect(result[0].steps).toHaveLength(1);
            expect(result[0].steps[0].pool).toBe("0xpool1");
            expect(result[0].steps[0].tokenOut).toBe("0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b");
            expect(result[0].steps[0].isBuffer).toBe(false);
        });

        it("should convert multi-hop path to BalancerRouterPath correctly", () => {
            const mockPaths = [
                {
                    tokens: [
                        {
                            address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            decimals: 18,
                        }, // WETH
                        {
                            address: "0xa2b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            decimals: 18,
                        }, // DAI
                        {
                            address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
                            decimals: 6,
                        }, // USDC
                    ],
                    pools: ["0xpool1" as `0x${string}`, "0xpool2" as `0x${string}`],
                    inputAmountRaw: 1000000000000000000n, // 1 WETH
                    outputAmountRaw: 3000000000n, // 3000 USDC
                    isBuffer: [false, true], // First pool normal, second is buffer
                    protocolVersion: 3 as const,
                },
            ];

            const result = BalancerRouter.convertToRoutePaths(mockPaths);

            expect(result).toHaveLength(1);
            expect(result[0].tokenIn).toBe("0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b");
            expect(result[0].exactAmountIn).toBe(1000000000000000000n);
            expect(result[0].minAmountOut).toBe(3000000000n);
            expect(result[0].steps).toHaveLength(2);

            // First step: WETH -> DAI
            expect(result[0].steps[0].pool).toBe("0xpool1");
            expect(result[0].steps[0].tokenOut).toBe("0xa2b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b");
            expect(result[0].steps[0].isBuffer).toBe(false);

            // Second step: DAI -> USDC
            expect(result[0].steps[1].pool).toBe("0xpool2");
            expect(result[0].steps[1].tokenOut).toBe("0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b");
            expect(result[0].steps[1].isBuffer).toBe(true);
        });
    });

    describe("test getMarketPrice method", () => {
        let router: BalancerRouter;

        beforeEach(async () => {
            const routerResult = await BalancerRouter.create(chainId, mockClient, routerAddress);
            if (routerResult.isOk()) {
                router = routerResult.value;
            }
        });

        it("should successfully get market price", async () => {
            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");

            // onchain price
            findBestRouteSpy.mockResolvedValueOnce(
                Result.ok({
                    type: RouterType.Balancer,
                    status: RouteStatus.Success,
                    amountOut: 3100000000n,
                    price: 3100000000000000000n,
                    route: [],
                    altRoutes: [],
                    validUntil: 1,
                }),
            );
            let result = await router.getMarketPrice({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: true,
            });
            assert(result.isOk());
            let marketPrice = result.value;
            expect(marketPrice.price).toBe("3.1");
            expect(findBestRouteSpy).toHaveBeenCalledTimes(1);
            expect(findBestRouteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: true,
            });

            // api price
            findBestRouteSpy.mockResolvedValueOnce(
                Result.ok({
                    type: RouterType.Balancer,
                    status: RouteStatus.Success,
                    amountOut: 3100000000n,
                    price: 3100000000000000000n,
                    route: [],
                    altRoutes: [],
                    validUntil: 1,
                }),
            );
            result = await router.getMarketPrice({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: false,
            });
            assert(result.isOk());
            marketPrice = result.value;
            expect(marketPrice.price).toBe("3.1");
            expect(findBestRouteSpy).toHaveBeenCalledTimes(2);
            expect(findBestRouteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: false,
            });

            findBestRouteSpy.mockRestore();
        });

        it("should return err when findBestRoute fails", async () => {
            const findBestRouteSpy = vi.spyOn(router, "findBestRoute");
            findBestRouteSpy.mockResolvedValue(
                Result.err(new BalancerRouterError("msg", BalancerRouterErrorType.FetchFailed)),
            );

            const result = await router.getMarketPrice({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: false,
            });
            assert(result.isErr());
            expect(result.error.message).toBe("msg");
            expect(findBestRouteSpy).toHaveBeenCalledTimes(1);
            expect(findBestRouteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                ignoreCache: false,
            });

            findBestRouteSpy.mockRestore();
        });
    });

    describe("test getTradeParams method", () => {
        let mockOrderDetails: any;
        let mockGetTradeParamsArgs: any;
        let router: BalancerRouter;

        beforeEach(async () => {
            vi.clearAllMocks();
            const routerResult = await BalancerRouter.create(chainId, mockClient, routerAddress);
            if (routerResult.isOk()) {
                router = routerResult.value;
            }

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
                    appOptions: {
                        maxRatio: true,
                    },
                    watchedTokens: new Map<string, TokenDetails>([
                        [
                            mockTokenIn.address.toLowerCase(),
                            {
                                address: mockTokenIn.address,
                                decimals: mockTokenIn.decimals,
                                symbol: mockTokenIn.symbol,
                            } as any,
                        ],
                        [
                            mockTokenOut.address.toLowerCase(),
                            {
                                address: mockTokenOut.address,
                                decimals: mockTokenOut.decimals,
                                symbol: mockTokenOut.symbol,
                            } as any,
                        ],
                    ]),
                },
                maximumInput: mockSwapAmount,
                orderDetails: mockOrderDetails,
                toToken: mockTokenOut,
                fromToken: mockTokenIn,
                signer: {
                    account: {
                        address: "0xsignerAddress" as `0x${string}`,
                    },
                },
                isPartial: false,
            };
        });

        it("should successfully return trade params for full trade", async () => {
            const mockQuote = {
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: [
                    {
                        tokenIn: mockTokenIn.address as `0x${string}`,
                        exactAmountIn: mockSwapAmount,
                        minAmountOut: 3000000000n,
                        steps: [
                            {
                                pool: "0xpool1" as `0x${string}`,
                                tokenOut: mockTokenOut.address as `0x${string}`,
                                isBuffer: false,
                            },
                        ],
                    },
                ],
                amountOut: 3000000000n,
            };

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visualizeSpy = vi.spyOn(BalancerRouter, "visualizeRoute");
            visualizeSpy.mockReturnValue(["some route visual"]);

            (encodeAbiParameters as Mock).mockReturnValue("0xencodedData");

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Balancer);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual(["some route visual"]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(encodeAbiParameters).toHaveBeenCalledWith(expect.any(Array), [
                router.routerAddress,
                mockQuote.route[0],
            ]);
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                senderAddress: "0xsignerAddress",
            });
            expect(visualizeSpy).toHaveBeenCalledWith(
                mockQuote.route,
                mockGetTradeParamsArgs.state.watchedTokens,
            );

            tryQuoteSpy.mockRestore();
            visualizeSpy.mockRestore();
        });

        it("should successfully return trade params for partial trade size and maxRatio false", async () => {
            const mockQuote = {
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: [
                    {
                        tokenIn: mockTokenIn.address as `0x${string}`,
                        exactAmountIn: mockSwapAmount,
                        minAmountOut: 3000000000n,
                        steps: [],
                    },
                ],
                amountOut: 3000000000n,
            };

            mockGetTradeParamsArgs.isPartial = true;
            mockGetTradeParamsArgs.state.appOptions.maxRatio = false;

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visualizeSpy = vi.spyOn(BalancerRouter, "visualizeRoute");
            visualizeSpy.mockReturnValue(["some route visual"]);

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Balancer);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual(["some route visual"]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(mockSwapAmount);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(mockQuote.price);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(encodeAbiParameters).toHaveBeenCalledWith(expect.any(Array), [
                router.routerAddress,
                mockQuote.route[0],
            ]);
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                senderAddress: "0xsignerAddress",
            });
            expect(visualizeSpy).toHaveBeenCalledWith(
                mockQuote.route,
                mockGetTradeParamsArgs.state.watchedTokens,
            );

            tryQuoteSpy.mockRestore();
            visualizeSpy.mockRestore();
        });

        it("should return error when tryQuote fails", async () => {
            const mockError = new BalancerRouterError(
                "No route found",
                BalancerRouterErrorType.NoRouteFound,
            );

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.err(mockError));

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());
            expect(result.error).toBe(mockError);
            expect(result.error.type).toBe(BalancerRouterErrorType.NoRouteFound);

            tryQuoteSpy.mockRestore();
        });

        it("should return error when getTakeOrdersConfig fails", async () => {
            const mockQuote = {
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                route: [
                    {
                        tokenIn: mockTokenIn.address as `0x${string}`,
                        exactAmountIn: mockSwapAmount,
                        minAmountOut: 3000000000n,
                        steps: [
                            {
                                pool: "0xpool1" as `0x${string}`,
                                tokenOut: mockTokenOut.address as `0x${string}`,
                                isBuffer: false,
                            },
                        ],
                    },
                ],
                amountOut: 3000000000n,
            };

            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const visualizeSpy = vi.spyOn(BalancerRouter, "visualizeRoute");
            visualizeSpy.mockReturnValue(["some route visual"]);

            (encodeAbiParameters as Mock).mockReturnValue("0xencodedData");

            const getTakeOrdersConfigSpy = vi.spyOn(router, "getTakeOrdersConfig");
            getTakeOrdersConfigSpy.mockReturnValue(
                Result.err({ msg: "", readableMsg: "some error" }),
            );

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());

            expect(result.error.message).toContain("Failed to build TakeOrdersConfig struct");
            expect(result.error.type).toBe(BalancerRouterErrorType.WasmEncodedError);
            expect(result.error.cause).toEqual({ msg: "", readableMsg: "some error" });
            expect(getTakeOrdersConfigSpy).toHaveBeenCalledWith(
                mockGetTradeParamsArgs.orderDetails,
                mockGetTradeParamsArgs.maximumInput,
                mockQuote.price,
                "0xencodedData",
                mockGetTradeParamsArgs.state.appOptions.maxRatio,
                mockGetTradeParamsArgs.isPartial,
            );

            visualizeSpy.mockRestore();
            tryQuoteSpy.mockRestore();
            getTakeOrdersConfigSpy.mockRestore();
        });
    });
});
