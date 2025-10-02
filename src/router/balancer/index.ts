import { calculatePrice18 } from "../../math";
import { ABI, Result, TokenDetails } from "../../common";
import { TakeOrdersConfigType } from "../../order/types";
import { BalancerRouterError, BalancerRouterErrorType } from "./error";
import { Chain, Account, Transport, formatUnits, PublicClient, encodeAbiParameters } from "viem";
import {
    Path,
    Token,
    ChainId,
    SwapKind,
    TokenAmount,
    BalancerApi,
    PathWithAmount,
} from "@balancer/sdk";
import {
    RouterType,
    RouteStatus,
    GetTradeParamsArgs,
    RainSolverRouterBase,
    RainSolverRouterQuoteParams,
} from "../types";

// Balancer API URL for fetching routes
export const BALANCER_API_URL = "https://api-v3.balancer.fi/" as const;

/** Represents a single step in a Balancer route */
export type BalancerRouterStep = {
    pool: `0x${string}`;
    tokenOut: `0x${string}`;
    isBuffer: boolean;
};

/** Represents the path details for a Balancer route */
export type BalancerRouterPath = {
    tokenIn: `0x${string}`;
    exactAmountIn: bigint;
    minAmountOut: bigint;
    steps: BalancerRouterStep[];
};

/** Represents the parameters for fetching Balancer routes from balancer API */
export type FetchBalancerRoutesParams = Pick<
    RainSolverRouterQuoteParams,
    "fromToken" | "toToken" | "amountIn"
>;

/** Represents the parameters for quoting Balancer */
export type BalancerQuoteParams = Omit<
    RainSolverRouterQuoteParams,
    "blockNumber" | "skipFetch" | "gasPrice"
>;

/** Represents a cached Balancer route */
export type BalancerCachedRoute = BalancerRouterQuote & {
    /** The alternative route paths details */
    altRoutes: BalancerRouterPath[];
    /** The timestamp until which the route is valid */
    validUntil: number;
};

/** Represents the quote details for a Balancer route */
export type BalancerRouterQuote = {
    /** The router type */
    type: RouterType.Balancer;
    /** The status of the route */
    status: RouteStatus;
    /** The price of the route */
    price: bigint;
    /** The route path details */
    route: BalancerRouterPath[];
    /** The amount out for the given amount in of the route */
    amountOut: bigint;
};

/** Represents the trade params for a Balancer route */
export type BalancerTradeParams = {
    /** The router type */
    type: RouterType.Balancer;
    /** The quote details for the Balancer route */
    quote: BalancerRouterQuote;
    /** The visual representation of the route */
    routeVisual: string[];
    /** The TakeOrdersConfig struct for onchain execution */
    takeOrdersConfigStruct: TakeOrdersConfigType;
};

/**
 * The Balancer Router class provides methods to interact with the Balancer protocol,
 * including fetching routes from balancer API, getting best route and market price as well
 * as managing runtime cache for routes.
 */
export class BalancerRouter extends RainSolverRouterBase {
    /** The address of the router contract */
    readonly routerAddress: `0x${string}`;
    /** The protocol version of the balancer */
    readonly protocolVersion = 3 as const;
    /** The duration for which a route is considered valid in cache */
    readonly routeTime = 300_000 as const; // 5 minutes in milliseconds
    /** The Balancer API instance */
    readonly balancerApi: BalancerApi;
    /** The cache for storing previously fetched routes that are valid until specified timestamp */
    readonly cache: Map<string, BalancerCachedRoute> = new Map();

    constructor(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
        routerAddress: `0x${string}`,
    ) {
        super(chainId, client);
        this.routerAddress = routerAddress;
        this.balancerApi = new BalancerApi(BALANCER_API_URL, this.chainId);
    }

    /**
     * Tries to initializes the Balancer Router instance.
     * @param chainId - The chain id of the operating chain
     * @param client - A viem client instance
     * @returns A Result containing the Balancer Router instance or an error
     */
    static async create(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
        routerAddress: `0x${string}`,
    ): Promise<Result<BalancerRouter, BalancerRouterError>> {
        return Result.ok(new BalancerRouter(chainId, client, routerAddress));
    }

    /**
     * Gets the market price for a token pair and swap amount.
     * @param params The parameters for the market price query
     * @returns The formatted market price for the token pair
     */
    async getMarketPrice(
        params: BalancerQuoteParams,
    ): Promise<Result<{ price: string }, BalancerRouterError>> {
        // return early if from and to tokens are the same
        if (params.fromToken.address.toLowerCase() === params.toToken.address.toLowerCase()) {
            return Result.ok({ price: "1" });
        }
        const balancerRouteResult = await this.findBestRoute(params);
        if (balancerRouteResult.isOk()) {
            return Result.ok({ price: formatUnits(balancerRouteResult.value.price, 18) });
        }
        return Result.err(balancerRouteResult.error);
    }

    /**
     * Gets the balancer market quote for a token pair by simulating balancer swap query
     * @param params The parameters for getting the best Balancer market quote
     */
    async tryQuote(
        params: BalancerQuoteParams,
    ): Promise<Result<BalancerRouterQuote, BalancerRouterError>> {
        try {
            const route = await this.findBestRoute(params);
            if (route.isErr()) {
                return Result.err(route.error);
            }

            // fallback to alt routes if the best one fails
            const { result, pickedRoute } = await (async () => {
                let err: any = undefined;
                const allRoutes = [...route.value.route, ...route.value.altRoutes];
                for (let i = 0; i < allRoutes.length + 1; i++) {
                    try {
                        const result = await this.client.simulateContract({
                            address: this.routerAddress,
                            abi: ABI.BalancerBatchRouter.Primary.BatchRouterV3,
                            functionName: "querySwapExactIn",
                            args: [
                                [allRoutes[i]],
                                params.senderAddress ?? `0x${"1".repeat(40)}`,
                                "0x",
                            ],
                        });
                        if (i > 0) {
                            // swap the routes so that next time the working one is tried first
                            [route.value.route, route.value.altRoutes[i - 1]] = [
                                [allRoutes[i]],
                                route.value.route[0],
                            ];
                            // move the failed alt route to the end of alt routes
                            route.value.altRoutes.push(...route.value.altRoutes.splice(i - 1, 1));
                        }
                        return {
                            result,
                            pickedRoute: allRoutes[i],
                        };
                    } catch (error) {
                        if (!err) err = error;
                    }
                }
                throw err;
            })();

            const amountOut = result.result[2][0];
            const price = calculatePrice18(
                params.amountIn,
                amountOut,
                params.fromToken.decimals,
                params.toToken.decimals,
            );

            return Result.ok({
                type: RouterType.Balancer,
                status: RouteStatus.Success,
                price,
                route: [pickedRoute],
                amountOut,
            });
        } catch (error: any) {
            return Result.err(
                new BalancerRouterError(
                    "Swap query execution failed for the given route to get market price",
                    BalancerRouterErrorType.SwapQueryFailed,
                    error,
                ),
            );
        }
    }

    /**
     * Finds the best Balancer route for a given token pair and swap amount
     * @param params The parameters for getting the best Balancer route
     */
    async findBestRoute(
        params: BalancerQuoteParams,
    ): Promise<Result<BalancerCachedRoute, BalancerRouterError>> {
        const key = `${params.fromToken.address.toLowerCase()}/${params.toToken.address.toLowerCase()}`;

        // search in cache first and return early if ignoreCache is false
        if (!params.ignoreCache) {
            const cachedRoute = this.cache.get(key);
            if (cachedRoute && cachedRoute.validUntil > Date.now()) {
                if (cachedRoute.status === RouteStatus.Success) {
                    return Result.ok(cachedRoute);
                } else {
                    return Result.err(
                        new BalancerRouterError(
                            "Found no balancer route for given token pair",
                            BalancerRouterErrorType.NoRouteFound,
                        ),
                    );
                }
            }
        }

        const balancerSortedRoutes = await this.fetchSortedRoutes(params);
        if (balancerSortedRoutes.isErr()) {
            const route: BalancerCachedRoute = {
                type: RouterType.Balancer,
                status: RouteStatus.NoWay,
                price: 0n,
                route: [],
                altRoutes: [],
                amountOut: 0n,
                validUntil: Date.now() + this.routeTime,
            };
            this.cache.set(key, route);
            return Result.err(balancerSortedRoutes.error);
        }

        let minAmountOut = 0n;
        balancerSortedRoutes.value.forEach((route) => {
            minAmountOut += route.minAmountOut;
        });
        const price = calculatePrice18(
            params.amountIn,
            minAmountOut,
            params.fromToken.decimals,
            params.toToken.decimals,
        );
        const route: BalancerCachedRoute = {
            type: RouterType.Balancer,
            status: RouteStatus.Success,
            route: [
                {
                    ...balancerSortedRoutes.value[0],
                    exactAmountIn: params.amountIn,
                    minAmountOut,
                },
            ],
            altRoutes: balancerSortedRoutes.value.slice(1).map((r) => ({
                ...r,
                exactAmountIn: params.amountIn,
                minAmountOut,
            })),
            validUntil: Date.now() + this.routeTime,
            price,
            amountOut: minAmountOut,
        };
        this.cache.set(key, route); // store in cache
        return Result.ok(route);
    }

    /**
     * Fetches the best Balancer route for a given token pair and swap amount.
     * This method uses the Balancer API to find the best swap paths from available liquidity.
     * @param params The parameters for fetching the best Balancer price
     * @returns A Result containing the best Balancer route or an error
     */
    async fetchSortedRoutes(
        params: FetchBalancerRoutesParams,
    ): Promise<Result<BalancerRouterPath[], BalancerRouterError>> {
        try {
            // prepare params
            const { fromToken, toToken, amountIn } = params;
            const tokenIn = new Token(
                this.chainId,
                fromToken.address as `0x${string}`,
                fromToken.decimals,
                fromToken.symbol,
            );
            const tokenOut = new Token(
                this.chainId,
                toToken.address as `0x${string}`,
                toToken.decimals,
                toToken.symbol,
            );
            const swapAmount = TokenAmount.fromRawAmount(tokenIn, amountIn);
            const swapKind = SwapKind.GivenIn;

            // fetch the sorted routes from the Balancer API
            const sorPaths = await this.balancerApi.sorSwapPaths.fetchSorSwapPaths({
                chainId: this.chainId,
                tokenIn: tokenIn.address.toLowerCase() as `0x${string}`,
                tokenOut: tokenOut.address.toLowerCase() as `0x${string}`,
                swapKind,
                swapAmount,
                useProtocolVersion: this.protocolVersion,
            });

            // return err if no route was found
            if (sorPaths.length === 0) {
                return Result.err(
                    new BalancerRouterError(
                        "Found no balancer route for given token pair",
                        BalancerRouterErrorType.NoRouteFound,
                    ),
                );
            }

            return Result.ok(BalancerRouter.convertToRoutePaths(sorPaths));
        } catch (error) {
            return Result.err(
                new BalancerRouterError(
                    "Failed to fetch balancer routes",
                    BalancerRouterErrorType.FetchFailed,
                    error,
                ),
            );
        }
    }

    /** Gets the list of active liquidity providers */
    getLiquidityProvidersList(): string[] {
        return ["BalancerV3"];
    }

    /**
     * Method to visualize the routes, returns an array of portioned route paths strings
     * @param route: The Balancer route to visualize
     * @param cachedTokenDetails: A map of token addresses to their details for symbol lookup
     */
    static visualizeRoute(
        route: BalancerRouterPath[],
        cachedTokenDetails: Map<string, TokenDetails>,
    ): string[] {
        let totalIn = 0n;
        route.forEach((path) => (totalIn += path.exactAmountIn));
        return route.map(
            (path) =>
                (Number((path.exactAmountIn * 10_000n) / totalIn) / 100).toFixed(2) +
                "%   --->   " +
                path.steps
                    .map((step, i) => {
                        const tokenIn = i === 0 ? path.tokenIn : path.steps[i - 1].tokenOut;
                        const tokenOutSymbol =
                            cachedTokenDetails.get(step.tokenOut.toLowerCase())?.symbol ??
                            "unknownSymbol";
                        const tokenInSymbol =
                            cachedTokenDetails.get(tokenIn.toLowerCase())?.symbol ??
                            "unknownSymbol";
                        return tokenOutSymbol + "/" + tokenInSymbol + " (pool " + step.pool + ")";
                    })
                    .join(" >> "),
        );
    }

    /**
     * Converts an array of paths to BalancerRouterPath objects used for balancer router swap calldata
     * @param paths The paths to convert
     */
    static convertToRoutePaths(paths: Path[]): BalancerRouterPath[] {
        const pathsWithAmounts = paths.map(
            (p) =>
                new PathWithAmount(
                    ChainId.MAINNET,
                    p.tokens,
                    p.pools,
                    p.inputAmountRaw,
                    p.outputAmountRaw,
                    p.isBuffer,
                ),
        );
        const swaps = pathsWithAmounts.map((p) => {
            return {
                tokenIn: p.inputAmount.token.address,
                exactAmountIn: p.inputAmount.amount,
                minAmountOut: p.outputAmount.amount,
                steps: p.pools.map((pool, i) => {
                    return {
                        pool,
                        tokenOut: p.tokens[i + 1].address,
                        isBuffer: p.isBuffer[i],
                    };
                }),
            };
        });
        return swaps;
    }

    /**
     * Gets the trade parameters for the best possible market quote for
     * executing a trade against Balancer BatchRouter with the returned value.
     * @param args - The trade arguments
     */
    async getTradeParams(
        args: GetTradeParamsArgs,
    ): Promise<Result<BalancerTradeParams, BalancerRouterError>> {
        const { state, orderDetails, maximumInput, signer, toToken, fromToken, isPartial } = args;
        const quoteResult = await this.tryQuote({
            fromToken: fromToken,
            toToken: toToken,
            amountIn: maximumInput,
            senderAddress: signer.account.address,
        });
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        const quote = quoteResult.value;

        const routeVisual: string[] = [];
        try {
            BalancerRouter.visualizeRoute(quote.route, state.watchedTokens).forEach((v) => {
                routeVisual.push(v);
            });
        } catch {
            /**/
        }

        const takeOrdersConfigStructResult = this.getTakeOrdersConfig(
            orderDetails,
            maximumInput,
            quote.price,
            encodeAbiParameters(
                [{ type: "address" }, ABI.BalancerBatchRouter.Structs.SwapPathExactAmountIn],
                [this.routerAddress, quote.route[0]],
            ),
            state.appOptions.maxRatio,
            isPartial,
        );
        if (takeOrdersConfigStructResult.isErr()) {
            return Result.err(
                new BalancerRouterError(
                    "Failed to build TakeOrdersConfig struct",
                    BalancerRouterErrorType.WasmEncodedError,
                    takeOrdersConfigStructResult.error,
                ),
            );
        }
        const takeOrdersConfigStruct = takeOrdersConfigStructResult.value;

        return Result.ok({
            type: RouterType.Balancer,
            quote: quoteResult.value,
            routeVisual,
            takeOrdersConfigStruct,
        });
    }
}
