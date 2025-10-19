import { ONE18 } from "../../math";
import { Order } from "../../order";
import { Token } from "sushi/currency";
import { StabullConstants } from "./constants";
import { RouterType, RouteStatus } from "../types";
import { StabullRouter, StabullRouterQuote } from ".";
import { ABI, Result, TokenDetails } from "../../common";
import { encodeAbiParameters, maxUint256, PublicClient } from "viem";
import { StabullRouterError, StabullRouterErrorType } from "./error";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeAbiParameters: vi.fn().mockReturnValue("0xencodedData"),
}));

describe("test StabullRouter", () => {
    let mockClient: PublicClient;
    const chainId = 1;
    const mockTokenIn = new Token({
        chainId,
        address: StabullConstants.Tokens[chainId].TRYB,
        decimals: 18,
        symbol: "TRYB",
    });
    const mockTokenOut = new Token({
        chainId,
        address: StabullConstants.Tokens[chainId].NZDS,
        decimals: 18,
        symbol: "NZDS",
    });
    const mockSwapAmount = 1000000000000000000n; // 1 TRYB
    const gasPrice = 20000000000n; // 20 gwei

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = {
            readContract: vi.fn(),
        } as any;
    });

    describe("test create method", () => {
        it("should successfully initialize StabullRouter for supported chain", async () => {
            const result = await StabullRouter.create(chainId, mockClient);

            assert(result.isOk());
            if (result.isOk()) {
                const router = result.value;
                expect(router).toBeInstanceOf(StabullRouter);
                expect(router.chainId).toBe(chainId);
                expect(router.routerAddress).toBeDefined();
                expect(router.quoteCurrencyAddress).toBeDefined();
            }
        });

        it("should error for unsupported chain", async () => {
            const chainId = 14; // Unsupported chain
            const result = await StabullRouter.create(chainId, mockClient);

            assert(result.isErr());
            if (result.isErr()) {
                const error = result.error;
                expect(error).toBeInstanceOf(StabullRouterError);
                expect(error.type).toBe(StabullRouterErrorType.UnsupportedChain);
                expect(error.message).toBe(
                    `Chain with id of "${chainId}" is not supported by Stabull Router`,
                );
            }
        });
    });

    describe("test findBestRoute method", () => {
        let router: StabullRouter;

        beforeEach(async () => {
            const routerResult = await StabullRouter.create(chainId, mockClient);
            if (routerResult.isOk()) {
                router = routerResult.value;
            }
        });

        it("should successfully get best route", async () => {
            (mockClient.readContract as Mock).mockResolvedValueOnce(2000000000000000000n);

            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isOk());
            const route = result.value;
            expect(route.amountOut).toBe(2000000000000000000n);
            expect(route.price).toBe(2000000000000000000n);
            expect(route.status).toBe(RouteStatus.Success);
            expect(route.type).toBe(RouterType.Stabull);
            expect(mockClient.readContract).toHaveBeenCalledTimes(1);
            expect(mockClient.readContract).toHaveBeenCalledWith({
                abi: ABI.Stabull.Primary.Router,
                address: router.routerAddress,
                functionName: "viewOriginSwap",
                args: [
                    router.quoteCurrencyAddress,
                    mockTokenIn.address,
                    mockTokenOut.address,
                    mockSwapAmount,
                ],
            });
        });

        it("should return error when tokens are not supported", async () => {
            const unsupportedTokenIn = new Token({
                chainId: 1,
                address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
                decimals: 18,
                symbol: "UNSUPPORTED",
            });
            const result = await router.findBestRoute({
                fromToken: unsupportedTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(StabullRouterError);
            expect(result.error.type).toBe(StabullRouterErrorType.NoRouteFound);
            expect(result.error.message).toBe(
                "Cannot trade this token pair on Stabull router as one or both tokens are not supported",
            );
        });

        it("should return error when readContract fails", async () => {
            (mockClient.readContract as Mock).mockRejectedValueOnce(new Error("Network error"));
            const result = await router.findBestRoute({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isErr());
            expect(result.error).toBeInstanceOf(StabullRouterError);
            expect(result.error.type).toBe(StabullRouterErrorType.FetchFailed);
            expect(result.error.message).toBe(
                "Failed to find route in stabull router for the given token pair",
            );
        });
    });

    describe("test tryQuote method", () => {
        let router: StabullRouter;

        beforeEach(async () => {
            const routerResult = await StabullRouter.create(chainId, mockClient);
            if (routerResult.isOk()) {
                router = routerResult.value;
            }
        });

        it("should call findBestRouter correctly and return success result", async () => {
            const mockResult: StabullRouterQuote = {
                amountOut: 1234n,
                price: 1234n,
                status: RouteStatus.Success,
                type: RouterType.Stabull,
            };
            const spy = vi.spyOn(router, "findBestRoute");
            spy.mockResolvedValueOnce(Result.ok(mockResult));

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isOk());
            const quote = result.value;
            expect(quote).toEqual(mockResult);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            spy.mockRestore();
        });

        it("should call findBestRouter correctly and return error result", async () => {
            const err = new StabullRouterError("some error", StabullRouterErrorType.FetchFailed);
            const spy = vi.spyOn(router, "findBestRoute");
            spy.mockResolvedValueOnce(Result.err(err));

            const result = await router.tryQuote({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isErr());
            expect(result.error).toEqual(err);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            spy.mockRestore();
        });
    });

    describe("test getMarketPrice method", () => {
        let router: StabullRouter;

        beforeEach(async () => {
            const routerResult = await StabullRouter.create(chainId, mockClient);
            if (routerResult.isOk()) {
                router = routerResult.value;
            }
        });

        it("should call findBestRouter correctly and return success result", async () => {
            const mockResult: StabullRouterQuote = {
                amountOut: 1000000000000000000n,
                price: 1000000000000000000n,
                status: RouteStatus.Success,
                type: RouterType.Stabull,
            };
            const spy = vi.spyOn(router, "findBestRoute");
            spy.mockResolvedValueOnce(Result.ok(mockResult));

            const result = await router.getMarketPrice({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isOk());
            const marketPrice = result.value;
            expect(marketPrice).toEqual({ price: "1" });
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            spy.mockRestore();
        });

        it("should call findBestRouter correctly and return error result", async () => {
            const err = new StabullRouterError("some error", StabullRouterErrorType.FetchFailed);
            const spy = vi.spyOn(router, "findBestRoute");
            spy.mockResolvedValueOnce(Result.err(err)) // initial call
                .mockResolvedValueOnce(Result.err(err)); // toUSDC fallback call

            const result = await router.getMarketPrice({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            assert(result.isErr());
            expect(result.error).toEqual(err);
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            spy.mockRestore();
        });
    });

    describe("test getTradeParams method", () => {
        let mockOrderDetails: any;
        let mockGetTradeParamsArgs: any;
        let router: StabullRouter;

        beforeEach(async () => {
            vi.clearAllMocks();
            const routerResult = await StabullRouter.create(chainId, mockClient);
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
                    gasPrice,
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
                type: RouterType.Stabull as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            };
            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Stabull);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual([]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(maxUint256);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }],
                [router.quoteCurrencyAddress],
            );
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            tryQuoteSpy.mockRestore();
        });

        it("should successfully return trade params for partial trade size and maxRatio false", async () => {
            const mockQuote = {
                type: RouterType.Stabull as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            };
            mockGetTradeParamsArgs.isPartial = true;
            mockGetTradeParamsArgs.state.appOptions.maxRatio = false;
            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isOk());
            const tradeParams = result.value;

            expect(tradeParams.type).toBe(RouterType.Stabull);
            expect(tradeParams.quote).toEqual(mockQuote);
            expect(tradeParams.routeVisual).toEqual([]);
            expect(tradeParams.takeOrdersConfigStruct.minimumInput).toBe(1n);
            expect(tradeParams.takeOrdersConfigStruct.maximumInput).toBe(mockSwapAmount);
            expect(tradeParams.takeOrdersConfigStruct.maximumIORatio).toBe(mockQuote.price);
            expect(tradeParams.takeOrdersConfigStruct.orders).toEqual([
                mockOrderDetails.takeOrder.struct,
            ]);
            expect(tradeParams.takeOrdersConfigStruct.data).toBe("0xencodedData");

            expect(encodeAbiParameters).toHaveBeenCalledWith(
                [{ type: "address" }],
                [router.quoteCurrencyAddress],
            );
            expect(tryQuoteSpy).toHaveBeenCalledWith({
                fromToken: mockTokenIn,
                toToken: mockTokenOut,
                amountIn: mockSwapAmount,
                gasPrice,
            });

            tryQuoteSpy.mockRestore();
        });

        it("should return error when tryQuote fails", async () => {
            const mockError = new StabullRouterError(
                "No route found",
                StabullRouterErrorType.NoRouteFound,
            );
            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.err(mockError));

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());
            expect(result.error).toBe(mockError);
            expect(result.error.type).toBe(StabullRouterErrorType.NoRouteFound);

            tryQuoteSpy.mockRestore();
        });

        it("should return error when getTakeOrdersConfig fails", async () => {
            const mockQuote = {
                type: RouterType.Stabull as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            };
            const tryQuoteSpy = vi.spyOn(router, "tryQuote");
            tryQuoteSpy.mockResolvedValue(Result.ok(mockQuote));

            const getTakeOrdersConfigSpy = vi.spyOn(router, "getTakeOrdersConfig");
            getTakeOrdersConfigSpy.mockReturnValue(
                Result.err({ msg: "", readableMsg: "some error" }),
            );

            const result = await router.getTradeParams(mockGetTradeParamsArgs);

            assert(result.isErr());
            expect(result.error.message).toContain("Failed to build TakeOrdersConfig struct");
            expect(result.error.type).toBe(StabullRouterErrorType.WasmEncodedError);
            expect(result.error.cause).toEqual({ msg: "", readableMsg: "some error" });
            expect(getTakeOrdersConfigSpy).toHaveBeenCalledWith(
                mockGetTradeParamsArgs.orderDetails,
                mockGetTradeParamsArgs.maximumInput,
                mockQuote.price,
                "0xencodedData",
                mockGetTradeParamsArgs.state.appOptions.maxRatio,
                mockGetTradeParamsArgs.isPartial,
            );

            tryQuoteSpy.mockRestore();
            getTakeOrdersConfigSpy.mockRestore();
        });
    });

    describe("test canTrade static method", () => {
        const supportedChainId = 1; // Ethereum mainnet
        const unsupportedChainId = 999; // Unsupported chain

        // Valid addresses from StabullConstants for chainId 1
        const validTokenAddress1 = StabullConstants.Tokens[1].TRYB.toLowerCase() as `0x${string}`;
        const validTokenAddress2 = StabullConstants.Tokens[1].NZDS.toLowerCase() as `0x${string}`;

        // Invalid token addresses
        const invalidTokenAddress1 = "0x1234567890123456789012345678901234567890" as `0x${string}`;
        const invalidTokenAddress2 =
            "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef" as `0x${string}`;

        it("should return true when both tokens are supported on supported chain", () => {
            const result = StabullRouter.canTrade(
                validTokenAddress1,
                validTokenAddress2,
                supportedChainId,
            );
            expect(result).toBe(true);
        });

        it("should return false when fromToken is not supported on supported chain", () => {
            const result = StabullRouter.canTrade(
                invalidTokenAddress1,
                validTokenAddress2,
                supportedChainId,
            );
            expect(result).toBe(false);
        });

        it("should return false when toToken is not supported on supported chain", () => {
            const result = StabullRouter.canTrade(
                validTokenAddress1,
                invalidTokenAddress2,
                supportedChainId,
            );
            expect(result).toBe(false);
        });

        it("should return false when both tokens are not supported on supported chain", () => {
            const result = StabullRouter.canTrade(
                invalidTokenAddress1,
                invalidTokenAddress2,
                supportedChainId,
            );
            expect(result).toBe(false);
        });

        it("should return false when chain is not supported regardless of tokens", () => {
            const result = StabullRouter.canTrade(
                validTokenAddress1,
                validTokenAddress2,
                unsupportedChainId,
            );
            expect(result).toBe(false);
        });
    });
});
