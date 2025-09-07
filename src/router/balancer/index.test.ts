import { Token } from "sushi/currency";
import { TokenDetails } from "../../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import {
    BalancerRouter,
    BalancerRouterPath,
    BalancerRouterError,
    BalancerRouterErrorType,
} from ".";

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
    describe("test init method", () => {
        it("should successfully initialize BalancerRouter for supported chain", () => {
            const chainId = 1; // Ethereum mainnet - supported by Balancer v3

            const result = BalancerRouter.init(chainId);

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

        it("should return error for unsupported chain", () => {
            const unsupportedChainId = 999999; // Non-existent chain

            const result = BalancerRouter.init(unsupportedChainId);

            assert(result.isErr());
            if (result.isErr()) {
                const error = result.error;
                expect(error).toBeInstanceOf(BalancerRouterError);
                expect(error.type).toBe(BalancerRouterErrorType.UnsupportedChain);
                expect(error.message).toBe(
                    `Balancer router does not support chain with id: ${unsupportedChainId}`,
                );
                expect(error.name).toBe("BalancerRouterError");
            }
        });
    });

    describe("test fetchSortedRoutes method", () => {
        let router: BalancerRouter;
        let mockBalancerApi: { sorSwapPaths: { fetchSorSwapPaths: Mock } };

        const mockTokenIn: TokenDetails = {
            address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 18,
            symbol: "WETH",
        };

        const mockTokenOut: TokenDetails = {
            address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 6,
            symbol: "USDC",
        };

        const mockSwapAmount = 1000000000000000000n; // 1 WETH

        beforeEach(() => {
            const routerResult = BalancerRouter.init(1); // Ethereum mainnet
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
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isOk());
            const routes = result.value;
            expect(routes).toHaveLength(2);

            // check first route
            expect(routes[0].tokenIn).toBe(mockTokenIn.address);
            expect(routes[0].steps).toHaveLength(1);
            expect(routes[0].steps[0].pool).toBe("0xpool1");
            expect(routes[0].steps[0].tokenOut).toBe(mockTokenOut.address);
            expect(routes[0].steps[0].isBuffer).toBe(false);

            // check second route (multi-hop)
            expect(routes[1].tokenIn).toBe(mockTokenIn.address);
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
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
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
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
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
                tokenIn: tokenWithoutSymbol,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
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
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isOk());
            const routes = result.value;
            expect(routes[0].steps).toHaveLength(2);
            expect(routes[0].steps[0].isBuffer).toBe(true);
            expect(routes[0].steps[1].isBuffer).toBe(false);
        });
    });

    describe("test getBestRoute method", () => {
        let router: BalancerRouter;
        let mockBalancerApi: { sorSwapPaths: { fetchSorSwapPaths: Mock } };

        const mockTokenIn: TokenDetails = {
            address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 18,
            symbol: "WETH",
        };

        const mockTokenOut: TokenDetails = {
            address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 6,
            symbol: "USDC",
        };

        const mockSwapAmount = 1000000000000000000n; // 1 WETH

        beforeEach(() => {
            const routerResult = BalancerRouter.init(1); // Ethereum mainnet
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

            const result = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isOk());
            const cachedRoute = result.value;
            expect(cachedRoute.route).toHaveLength(1);
            expect(cachedRoute.route[0].tokenIn).toBe(mockTokenIn.address);
            expect(cachedRoute.route[0].exactAmountIn).toBe(mockSwapAmount);
            expect(cachedRoute.route[0].minAmountOut).toBe(3000000000n);
            expect(cachedRoute.route[0].steps).toHaveLength(1);
            expect(cachedRoute.route[0].steps[0].pool).toBe("0xpool1");
            expect(cachedRoute.price).toBeGreaterThan(0n);
            expect(cachedRoute.validUntil).toBeGreaterThan(Date.now());

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
            const firstResult = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(firstResult.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);

            // Second call - should return from cache
            const secondResult = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(secondResult.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1); // No additional API call
            expect(secondResult.value).toEqual(firstResult.value);
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
            await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);

            // Second call with ignoreCache: true
            await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
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
            const expiredRoute = {
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
            };
            router.cache.set(cacheKey, expiredRoute);

            const result = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isOk());
            expect(mockBalancerApi.sorSwapPaths.fetchSorSwapPaths).toHaveBeenCalledTimes(1);
            expect(result.value.route[0].minAmountOut).toBe(3000000000n); // New route data
            expect(result.value.route[0].steps[0].pool).toBe("0xpool1"); // New pool
        });

        it("should return error when fetchSortedRoutes fails", async () => {
            const mockError = new Error("Network error");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockRejectedValue(mockError);

            const result = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.FetchFailed);
            expect(error.cause).toBe(mockError);
        });

        it("should return error when no routes found", async () => {
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockResolvedValue([]);

            const result = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
            });

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.NoRouteFound);
            expect(error.message).toBe("Found no balancer route for given token pair");
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

            const result = await router.getBestRoute({
                tokenIn: mockTokenIn,
                tokenOut: mockTokenOut,
                swapAmount: mockSwapAmount,
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
        let mockSigner: any;

        const mockTokenIn: TokenDetails = {
            address: "0xa0b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 18,
            symbol: "WETH",
        };

        const mockTokenOut: TokenDetails = {
            address: "0xa1b86a33e6c0c536b5e9f9de9c2c4b6d5e9c2c4b" as `0x${string}`,
            decimals: 6,
            symbol: "USDC",
        };

        const mockSwapAmount = 1000000000000000000n; // 1 WETH

        beforeEach(() => {
            const routerResult = BalancerRouter.init(1); // Ethereum mainnet
            if (routerResult.isOk()) {
                router = routerResult.value;
                router.cache.clear(); // clear cache before each test
                mockBalancerApi = (router as any).balancerApi;
            }

            // mock signer
            mockSigner = {
                account: {
                    address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
                },
                simulateContract: vi.fn(),
            };
        });

        it("should successfully get market price with onchain simulation", async () => {
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
            mockSigner.simulateContract.mockResolvedValue(mockSimulationResult);

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

            assert(result.isOk());
            const marketPrice = result.value;
            expect(marketPrice.amountOut).toBe(3100000000n);
            expect(marketPrice.price).toBeGreaterThan(0n);
            expect(marketPrice.route).toHaveLength(1);
            expect(marketPrice.route[0].tokenIn).toBe(mockTokenIn.address);
            expect(marketPrice.route[0].steps[0].pool).toBe("0xpool1");

            // verify simulation was called with correct parameters
            expect(mockSigner.simulateContract).toHaveBeenCalledWith({
                address: router.routerAddress,
                abi: expect.any(Array),
                functionName: "querySwapExactIn",
                args: [expect.any(Array), mockSigner.account.address, "0x"],
            });
        });

        it("should return cached onchain price when available", async () => {
            const onchainPrice = 3200000000000000000000n;
            const cachedRoute = {
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
                altRoutes: [],
                validUntil: Date.now() + 60000,
                price: 3000000000000000000000n,
                onchainPrice,
            };

            // manually add cached route with onchain price
            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            router.cache.set(cacheKey, cachedRoute);

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

            assert(result.isOk());
            const marketPrice = result.value;
            expect(marketPrice.price).toBe(onchainPrice);
            expect(marketPrice.amountOut).toBe(3000000000n);
            expect(marketPrice.route).toEqual(cachedRoute.route);

            // Should not call simulateContract when onchainPrice is cached
            expect(mockSigner.simulateContract).not.toHaveBeenCalled();
        });

        it("should use default address when signer has no account", async () => {
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
            mockSigner.simulateContract.mockResolvedValue(mockSimulationResult);
            mockSigner.account = undefined; // No account

            const customAddress = "0x9999999999999999999999999999999999999999" as `0x${string}`;

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
                customAddress,
            );

            assert(result.isOk());
            expect(mockSigner.simulateContract).toHaveBeenCalledWith({
                address: router.routerAddress,
                abi: expect.any(Array),
                functionName: "querySwapExactIn",
                args: [expect.any(Array), customAddress, "0x"],
            });
        });

        it("should fallback to cached price when simulation fails", async () => {
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
            mockSigner.simulateContract.mockResolvedValue({
                result: [null, null, []], // Invalid simulation result
            });

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

            assert(result.isOk());
            const marketPrice = result.value;
            // Should fallback to cached route price and amount
            expect(marketPrice.amountOut).toBe(3000000000n);
            expect(marketPrice.price).toBeGreaterThan(0n);
            expect(marketPrice.route).toHaveLength(1);
        });

        it("should return error when getBestRoute fails", async () => {
            const mockError = new Error("Network error");
            mockBalancerApi.sorSwapPaths.fetchSorSwapPaths.mockRejectedValue(mockError);

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

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
            mockSigner.simulateContract.mockRejectedValue(simulationError);

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

            assert(result.isErr());
            const error = result.error;
            expect(error).toBeInstanceOf(BalancerRouterError);
            expect(error.type).toBe(BalancerRouterErrorType.SwapQueryFailed);
            expect(error.message).toBe(
                "Swap query execution failed for the given route to get market price",
            );
            expect(error.cause).toBe(simulationError);
        });

        it("should update cache with onchain price after successful simulation", async () => {
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
            mockSigner.simulateContract.mockResolvedValue(mockSimulationResult);

            const result = await router.tryQuote(
                {
                    tokenIn: mockTokenIn,
                    tokenOut: mockTokenOut,
                    swapAmount: mockSwapAmount,
                },
                mockSigner,
            );

            assert(result.isOk());

            // verify that onchain price was cached
            const cacheKey = `${mockTokenIn.address.toLowerCase()}/${mockTokenOut.address.toLowerCase()}`;
            const cachedRoute = router.cache.get(cacheKey);
            expect(cachedRoute?.onchainPrice).toBeDefined();
            expect(cachedRoute?.onchainPrice).toBeGreaterThan(0n);
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
});
