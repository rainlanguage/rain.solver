import { Pair } from "../order";
import { ONE18 } from "../math";
import { Result } from "../common";
import { PublicClient } from "viem";
import { SushiRouter } from "./sushi";
import { Token } from "sushi/currency";
import { LiquidityProviders } from "sushi";
import { BalancerRouter } from "./balancer";
import { RainSolverRouter, RainSolverRouterConfig } from "./router";
import { describe, it, expect, vi, beforeEach, assert } from "vitest";
import { RouterType, RouteStatus, GetTradeParamsArgs, RainSolverRouterQuoteParams } from "./types";
import {
    SushiRouterError,
    BalancerRouterError,
    SushiRouterErrorType,
    BalancerRouterErrorType,
    RainSolverRouterErrorType,
    StabullRouterErrorType,
    StabullRouterError,
} from "./error";
import { StabullRouter } from "./stabull";

describe("RainSolverRouter", () => {
    const chainId = 1;
    const gasPrice = 20000000000n;
    const mockSwapAmount = 1000000000000000000n; // 1 WETH
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

    let router: RainSolverRouter;
    let mockSushiRouter: SushiRouter;
    let mockBalancerRouter: BalancerRouter;
    let mockStabullRouter: StabullRouter;
    let mockClient: PublicClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = createMockPublicClient();
        mockSushiRouter = createMockSushiRouter();
        mockBalancerRouter = createMockBalancerRouter();
        mockStabullRouter = createMockStabullRouter();
        router = new RainSolverRouter(
            chainId,
            mockClient,
            mockSushiRouter,
            mockBalancerRouter,
            mockStabullRouter,
        );
    });

    describe("test create static method", () => {
        it("should create router with sushi, balancer and stabull when both succeed", async () => {
            const mockConfig: RainSolverRouterConfig = {
                chainId,
                client: mockClient,
                sushiRouterConfig: { sushiRouteProcessor4Address: "0xsushi" as `0x${string}` },
                balancerRouterConfig: { balancerRouterAddress: "0xbalancer" as `0x${string}` },
                stabullRouter: true,
            };

            const sushiCreateSpy = vi.spyOn(SushiRouter, "create");
            sushiCreateSpy.mockResolvedValue(Result.ok(mockSushiRouter));

            const balancerCreateSpy = vi.spyOn(BalancerRouter, "create");
            balancerCreateSpy.mockResolvedValue(Result.ok(mockBalancerRouter));

            const stabullCreateSpy = vi.spyOn(StabullRouter, "create");
            stabullCreateSpy.mockResolvedValue(Result.ok(mockStabullRouter));

            const result = await RainSolverRouter.create(mockConfig);

            assert(result.isOk());
            expect(result.value.sushi).toBeDefined();
            expect(result.value.balancer).toBeDefined();
            expect(sushiCreateSpy).toHaveBeenCalledWith(
                chainId,
                mockClient,
                "0xsushi" as `0x${string}`,
                undefined,
            );
            expect(balancerCreateSpy).toHaveBeenCalledWith(
                chainId,
                mockClient,
                "0xbalancer" as `0x${string}`,
            );
            expect(stabullCreateSpy).toHaveBeenCalledWith(chainId, mockClient);

            sushiCreateSpy.mockRestore();
            balancerCreateSpy.mockRestore();
            stabullCreateSpy.mockRestore();
        });

        it("should create router with only balancer when sushi fails", async () => {
            const mockConfig: RainSolverRouterConfig = {
                chainId,
                client: mockClient,
                balancerRouterConfig: { balancerRouterAddress: "0xbalancer" as `0x${string}` },
                // No sushi address
            };

            const balancerCreateSpy = vi.spyOn(BalancerRouter, "create");
            balancerCreateSpy.mockResolvedValue(Result.ok(mockBalancerRouter));

            const result = await RainSolverRouter.create(mockConfig);

            assert(result.isOk());
            expect(result.value.sushi).toBeUndefined();
            expect(result.value.balancer).toBeDefined();
            expect(balancerCreateSpy).toHaveBeenCalledWith(
                chainId,
                mockClient,
                "0xbalancer" as `0x${string}`,
            );

            balancerCreateSpy.mockRestore();
        });

        it("should create router with only sushi when balancer fails", async () => {
            const mockConfig: RainSolverRouterConfig = {
                chainId,
                client: mockClient,
                sushiRouterConfig: {
                    sushiRouteProcessor4Address: "0xsushi" as `0x${string}`,
                    liquidityProviders: [LiquidityProviders.ApeSwap],
                },
            };

            const sushiCreateSpy = vi.spyOn(SushiRouter, "create");
            sushiCreateSpy.mockResolvedValue(Result.ok(mockSushiRouter));
            const balancerCreateSpy = vi.spyOn(BalancerRouter, "create");

            const result = await RainSolverRouter.create(mockConfig);

            assert(result.isOk());
            expect(result.value.balancer).toBeUndefined();
            expect(result.value.sushi).toBeDefined();
            expect(sushiCreateSpy).toHaveBeenCalledWith(
                chainId,
                mockClient,
                "0xsushi" as `0x${string}`,
                [LiquidityProviders.ApeSwap],
            );
            expect(balancerCreateSpy).not.toHaveBeenCalled();

            sushiCreateSpy.mockRestore();
            balancerCreateSpy.mockRestore();
        });

        it("should return error when both fail", async () => {
            const mockConfig: RainSolverRouterConfig = {
                chainId,
                client: mockClient,
                // No addresses provided
            };
            const sushiCreateSpy = vi.spyOn(SushiRouter, "create");
            const balancerCreateSpy = vi.spyOn(BalancerRouter, "create");

            const result = await RainSolverRouter.create(mockConfig);

            assert(result.isErr());
            expect(result.error.typ).toBe(RainSolverRouterErrorType.InitializationError);
            expect(sushiCreateSpy).not.toHaveBeenCalled();
            expect(balancerCreateSpy).not.toHaveBeenCalled();

            sushiCreateSpy.mockRestore();
            balancerCreateSpy.mockRestore();
        });
    });

    describe("test getMarketPrice method", () => {
        const mockParams: RainSolverRouterQuoteParams = {
            fromToken: mockTokenIn,
            toToken: mockTokenOut,
            amountIn: mockSwapAmount,
            gasPrice,
        };

        it("should call both sushi, balancer and stabull getMarketPrice and return highest price", async () => {
            const sushiResult = Result.ok({ price: "2500.5" }) as any;
            const balancerResult = Result.ok({ price: "3000.0" }) as any;
            const stabullResult = Result.ok({ price: "1500.0" }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "getMarketPrice");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("3000.0");
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(stabullSpy).toHaveBeenCalledWith({ ...mockParams, sushiRouter: router.sushi });

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should return sushi result when balancer fails", async () => {
            const sushiResult = Result.ok({ price: "2500.5" }) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("error", BalancerRouterErrorType.FetchFailed),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("2500.5");

            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return balancer result when sushi fails", async () => {
            const sushiResult = Result.err(
                new SushiRouterError("error", SushiRouterErrorType.FetchFailed),
            ) as any;
            const balancerResult = Result.ok({ price: "3000.0" }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("3000.0");

            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return error when all fail", async () => {
            const sushiResult = Result.err(
                new SushiRouterError("sushi error", SushiRouterErrorType.NoRouteFound),
            ) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("balancer error", BalancerRouterErrorType.NoRouteFound),
            ) as any;
            const stabullResult = Result.err(
                new StabullRouterError("stabull error", StabullRouterErrorType.NoRouteFound),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "getMarketPrice");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.getMarketPrice(mockParams);

            assert(result.isErr());
            expect(result.error.message).toContain("Failed to get market price");
            expect(result.error.typ).toBe(RainSolverRouterErrorType.NoRouteFound);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(stabullSpy).toHaveBeenCalledWith({ ...mockParams, sushiRouter: router.sushi });

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should sort results by price correctly", async () => {
            const sushiResult = Result.ok({ price: "3500.0" }) as any; // Higher price
            const balancerResult = Result.ok({ price: "3000.0" }) as any; // Lower price

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("3500.0"); // Should return higher price
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return sushi result when undefined balancer", async () => {
            (router.balancer as any) = undefined;
            const sushiResult = Result.ok({ price: "2500.5" }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("2500.5");

            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).not.toHaveBeenCalledWith();

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return balancer result when undefined sushi", async () => {
            (router.sushi as any) = undefined;
            const balancerResult = Result.ok({ price: "2500.5" }) as any;

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getMarketPrice");
            balancerSpy.mockResolvedValue(balancerResult);

            const sushiSpy = vi.spyOn(mockSushiRouter, "getMarketPrice");

            const result = await router.getMarketPrice(mockParams);

            assert(result.isOk());
            expect(result.value.price).toBe("2500.5");

            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(sushiSpy).not.toHaveBeenCalledWith();

            balancerSpy.mockRestore();
            sushiSpy.mockRestore();
        });
    });

    describe("test tryQuote method", () => {
        const mockParams: RainSolverRouterQuoteParams = {
            fromToken: mockTokenIn,
            toToken: mockTokenOut,
            amountIn: mockSwapAmount,
            gasPrice,
        };

        it("should call sushi, balancer and stabull tryQuote and return highest amountOut", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 2500000000n,
            }) as any;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            }) as any;
            const stabullResult = Result.ok({
                type: RouterType.Stabull as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 1500000000n,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "tryQuote");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "tryQuote");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "tryQuote");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.tryQuote(mockParams);

            assert(result.isOk());
            expect(result.value.amountOut).toBe(3000000000n);
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(stabullSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should return sushi result when balancer fails", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 2500000000n,
            }) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("error", BalancerRouterErrorType.NoRouteFound),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "tryQuote");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "tryQuote");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.tryQuote(mockParams);

            assert(result.isOk());
            expect(result.value.amountOut).toBe(2500000000n);
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should sort results by amountOut correctly", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3500000000n, // Higher output
            }) as any;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n, // Lower output
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "tryQuote");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "tryQuote");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.tryQuote(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(result.value.amountOut).toBe(3500000000n); // Should return higher output
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return sushi result when undefined balancer", async () => {
            (router.balancer as any) = undefined;
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3500000000n,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "tryQuote");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "tryQuote");

            const result = await router.tryQuote(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(result.value.amountOut).toBe(3500000000n);

            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).not.toHaveBeenCalledWith();

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return balancer result when undefined sushi", async () => {
            (router.sushi as any) = undefined;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            }) as any;

            const balancerSpy = vi.spyOn(mockBalancerRouter, "tryQuote");
            balancerSpy.mockResolvedValue(balancerResult);

            const sushiSpy = vi.spyOn(mockSushiRouter, "tryQuote");

            const result = await router.tryQuote(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.amountOut).toBe(3000000000n);

            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(sushiSpy).not.toHaveBeenCalledWith();

            balancerSpy.mockRestore();
            sushiSpy.mockRestore();
        });
    });

    describe("test findBestRoute method", () => {
        const mockParams: RainSolverRouterQuoteParams = {
            fromToken: mockTokenIn,
            toToken: mockTokenOut,
            amountIn: mockSwapAmount,
            gasPrice,
        };

        it("should call sushi, balancer and stabull findBestRoute and return highest amountOut", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 2500000000n,
            }) as any;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            }) as any;
            const stabullResult = Result.ok({
                type: RouterType.Stabull as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 1500000000n,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "findBestRoute");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "findBestRoute");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "findBestRoute");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.findBestRoute(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.amountOut).toBe(3000000000n);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(stabullSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should return error when all fail", async () => {
            const sushiResult = Result.err(
                new SushiRouterError("sushi error", SushiRouterErrorType.NoRouteFound),
            ) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("balancer error", BalancerRouterErrorType.NoRouteFound),
            ) as any;
            const stabullResult = Result.err(
                new StabullRouterError("stabull error", StabullRouterErrorType.NoRouteFound),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "findBestRoute");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "findBestRoute");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "findBestRoute");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.findBestRoute(mockParams);

            assert(result.isErr());
            expect(result.error.message).toContain("Failed to find best route");
            expect(result.error.typ).toBe(RainSolverRouterErrorType.NoRouteFound);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(stabullSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should sort results by amountOut descending", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 4000000000n, // Highest output
            }) as any;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3500000000n, // Lower output
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "findBestRoute");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "findBestRoute");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.findBestRoute(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(result.value.amountOut).toBe(4000000000n);
            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).toHaveBeenCalledWith(mockParams);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return sushi result when undefined balancer", async () => {
            (router.balancer as any) = undefined;
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3500000000n,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "findBestRoute");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "findBestRoute");

            const result = await router.findBestRoute(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(result.value.amountOut).toBe(3500000000n);

            expect(sushiSpy).toHaveBeenCalledWith(mockParams);
            expect(balancerSpy).not.toHaveBeenCalledWith();

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return balancer result when undefined sushi", async () => {
            (router.sushi as any) = undefined;
            const balancerResult = Result.ok({
                type: RouterType.Balancer as const,
                status: RouteStatus.Success,
                price: 3000n * ONE18,
                amountOut: 3000000000n,
            }) as any;

            const balancerSpy = vi.spyOn(mockBalancerRouter, "findBestRoute");
            balancerSpy.mockResolvedValue(balancerResult);

            const sushiSpy = vi.spyOn(mockSushiRouter, "findBestRoute");

            const result = await router.findBestRoute(mockParams);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.amountOut).toBe(3000000000n);

            expect(balancerSpy).toHaveBeenCalledWith(mockParams);
            expect(sushiSpy).not.toHaveBeenCalledWith();

            balancerSpy.mockRestore();
            sushiSpy.mockRestore();
        });
    });

    describe("test getTradeParams method", () => {
        const mockArgs: GetTradeParamsArgs = {
            state: {
                appOptions: { maxRatio: true },
                watchedTokens: new Map(),
            },
            maximumInput: mockSwapAmount,
            orderDetails: {
                takeOrder: {
                    struct: {
                        order: "0xorder",
                        inputIOIndex: 0,
                        outputIOIndex: 0,
                        signedContext: [],
                    },
                },
            },
            toToken: mockTokenOut,
            fromToken: mockTokenIn,
            signer: { account: { address: "0xsigner" } },
            isPartial: false,
        } as any;

        it("should call sushi, balancer and stabull getTradeParams and return highest amountOut", async () => {
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: 3000n * ONE18,
                    amountOut: 2500000000n,
                },
                routeVisual: [],
                takeOrdersConfigStruct: {} as any,
            }) as any;
            const balancerResult = Result.ok({
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer as const,
                    status: RouteStatus.Success,
                    price: 3000n * ONE18,
                    amountOut: 3000000000n,
                },
                routeVisual: [],
                takeOrdersConfigStruct: {} as any,
            }) as any;
            const stabullResult = Result.ok({
                type: RouterType.Stabull,
                quote: {
                    type: RouterType.Stabull as const,
                    status: RouteStatus.Success,
                    price: 3000n * ONE18,
                    amountOut: 1500000000n,
                },
                routeVisual: [],
                takeOrdersConfigStruct: {} as any,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getTradeParams");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getTradeParams");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "getTradeParams");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.getTradeParams(mockArgs);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.quote.amountOut).toBe(3000000000n);
            expect(sushiSpy).toHaveBeenCalledWith(mockArgs);
            expect(balancerSpy).toHaveBeenCalledWith(mockArgs);
            expect(stabullSpy).toHaveBeenCalledWith(mockArgs);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should return error when all fail", async () => {
            const sushiResult = Result.err(
                new SushiRouterError("sushi error", SushiRouterErrorType.FetchFailed),
            ) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("balancer error", BalancerRouterErrorType.FetchFailed),
            ) as any;
            const stabullResult = Result.err(
                new StabullRouterError("stabull error", StabullRouterErrorType.FetchFailed),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getTradeParams");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getTradeParams");
            balancerSpy.mockResolvedValue(balancerResult);

            const stabullSpy = vi.spyOn(mockStabullRouter, "getTradeParams");
            stabullSpy.mockResolvedValue(stabullResult);

            const result = await router.getTradeParams(mockArgs);

            assert(result.isErr());
            expect(result.error.message).toContain("Failed to find trade route");
            expect(result.error.typ).toBe(RainSolverRouterErrorType.FetchFailed);
            expect(sushiSpy).toHaveBeenCalledWith(mockArgs);
            expect(balancerSpy).toHaveBeenCalledWith(mockArgs);
            expect(stabullSpy).toHaveBeenCalledWith(mockArgs);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
            stabullSpy.mockRestore();
        });

        it("should return error when both fail", async () => {
            const sushiResult = Result.err(
                new SushiRouterError("sushi error", SushiRouterErrorType.NoRouteFound),
            ) as any;
            const balancerResult = Result.err(
                new BalancerRouterError("balancer error", BalancerRouterErrorType.NoRouteFound),
            ) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getTradeParams");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getTradeParams");
            balancerSpy.mockResolvedValue(balancerResult);

            const result = await router.getTradeParams(mockArgs);

            assert(result.isErr());
            expect(result.error.message).toContain("Failed to find trade route");
            expect(result.error.typ).toBe(RainSolverRouterErrorType.NoRouteFound);
            expect(sushiSpy).toHaveBeenCalledWith(mockArgs);
            expect(balancerSpy).toHaveBeenCalledWith(mockArgs);

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return sushi result when undefined balancer", async () => {
            (router.balancer as any) = undefined;
            const sushiResult = Result.ok({
                type: RouterType.Sushi,
                quote: {
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price: 3000n * ONE18,
                    amountOut: 2500000000n,
                },
                routeVisual: [],
                takeOrdersConfigStruct: {} as any,
            }) as any;

            const sushiSpy = vi.spyOn(mockSushiRouter, "getTradeParams");
            sushiSpy.mockResolvedValue(sushiResult);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getTradeParams");

            const result = await router.getTradeParams(mockArgs);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Sushi);
            expect(result.value.quote.amountOut).toBe(2500000000n);

            expect(sushiSpy).toHaveBeenCalledWith(mockArgs);
            expect(balancerSpy).not.toHaveBeenCalledWith();

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should return balancer result when undefined sushi", async () => {
            (router.sushi as any) = undefined;
            const balancerResult = Result.ok({
                type: RouterType.Balancer,
                quote: {
                    type: RouterType.Balancer as const,
                    status: RouteStatus.Success,
                    price: 3000n * ONE18,
                    amountOut: 3000000000n,
                },
                routeVisual: [],
                takeOrdersConfigStruct: {} as any,
            }) as any;

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getTradeParams");
            balancerSpy.mockResolvedValue(balancerResult);

            const sushiSpy = vi.spyOn(mockSushiRouter, "getTradeParams");

            const result = await router.getTradeParams(mockArgs);

            assert(result.isOk());
            expect(result.value.type).toBe(RouterType.Balancer);
            expect(result.value.quote.amountOut).toBe(3000000000n);

            expect(balancerSpy).toHaveBeenCalledWith(mockArgs);
            expect(sushiSpy).not.toHaveBeenCalledWith();

            balancerSpy.mockRestore();
            sushiSpy.mockRestore();
        });
    });

    describe("test findLargestTradeSize method", () => {
        it("should call sushi findLargestTradeSize when sushi router exists", () => {
            const mockOrderDetails = {} as Pair;
            const mockGasPrice = 1000000000n;
            const expectedSize = 5000000000n;

            const sushiSpy = vi.spyOn(mockSushiRouter, "findLargestTradeSize");
            sushiSpy.mockReturnValue(expectedSize);

            const result = router.findLargestTradeSize(
                mockOrderDetails,
                mockTokenOut,
                mockTokenIn,
                mockSwapAmount,
                mockGasPrice,
                "single",
            );

            expect(result).toBe(expectedSize);
            expect(sushiSpy).toHaveBeenCalledWith(
                mockOrderDetails,
                mockTokenOut,
                mockTokenIn,
                mockSwapAmount,
                mockGasPrice,
                "single",
                false,
            );

            sushiSpy.mockRestore();
        });

        it("should return undefined when sushi router does not exist", () => {
            const routerWithoutSushi = new RainSolverRouter(
                chainId,
                mockClient,
                undefined,
                mockBalancerRouter,
            );
            const mockOrderDetails = {} as Pair;
            const mockGasPrice = 1000000000n;

            const result = routerWithoutSushi.findLargestTradeSize(
                mockOrderDetails,
                mockTokenOut,
                mockTokenIn,
                mockSwapAmount,
                mockGasPrice,
                "multi",
            );

            expect(result).toBeUndefined();
        });
    });

    describe("test getLiquidityProvidersList method", () => {
        it("should combine lists from both sushi and balancer routers", () => {
            const sushiProviders = ["SushiSwap", "UniswapV2"];
            const balancerProviders = ["Balancer", "BalancerV2"];

            const sushiSpy = vi.spyOn(mockSushiRouter, "getLiquidityProvidersList");
            sushiSpy.mockReturnValue(sushiProviders);

            const balancerSpy = vi.spyOn(mockBalancerRouter, "getLiquidityProvidersList");
            balancerSpy.mockReturnValue(balancerProviders);

            const result = router.getLiquidityProvidersList();

            expect(result).toEqual([...balancerProviders, ...sushiProviders]);
            expect(sushiSpy).toHaveBeenCalled();
            expect(balancerSpy).toHaveBeenCalled();

            sushiSpy.mockRestore();
            balancerSpy.mockRestore();
        });

        it("should handle missing routers gracefully", () => {
            const routerWithoutRouters = new RainSolverRouter(
                chainId,
                mockClient,
                undefined,
                undefined,
            );

            const result = routerWithoutRouters.getLiquidityProvidersList();

            expect(result).toEqual([]);
        });
    });
});

// Helper functions to create mock objects
function createMockSushiRouter(): SushiRouter {
    return {
        getMarketPrice: vi.fn(),
        tryQuote: vi.fn(),
        findBestRoute: vi.fn(),
        getTradeParams: vi.fn(),
        findLargestTradeSize: vi.fn(),
        getLiquidityProvidersList: vi.fn(),
    } as any;
}

function createMockBalancerRouter(): BalancerRouter {
    return {
        getMarketPrice: vi.fn(),
        tryQuote: vi.fn(),
        findBestRoute: vi.fn(),
        getTradeParams: vi.fn(),
        getLiquidityProvidersList: vi.fn(),
    } as any;
}

function createMockPublicClient(): PublicClient {
    return {} as any;
}

function createMockStabullRouter(): StabullRouter {
    return {
        getMarketPrice: vi.fn(),
        tryQuote: vi.fn(),
        findBestRoute: vi.fn(),
        getTradeParams: vi.fn(),
        getLiquidityProvidersList: vi.fn(),
    } as any;
}
