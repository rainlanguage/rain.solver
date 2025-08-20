import { PublicClient } from "viem";
import { ABI, Result } from "../common";
import { TokenDetails } from "../state";
import { ONE18, scaleTo18 } from "../math";
import { RainSolverSigner } from "../signer";
import { RainSolverBaseError } from "../error";
import { Token as SushiToken } from "sushi/currency";
import {
    Path,
    Token,
    ChainId,
    SwapKind,
    TokenAmount,
    BalancerApi,
    PathWithAmount,
    AddressProvider,
    balancerV3Contracts,
} from "@balancer/sdk";

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
export type FetchBalancerRoutesParams = {
    tokenIn: TokenDetails | SushiToken;
    tokenOut: TokenDetails | SushiToken;
    swapAmount: bigint;
};

/** Represents the parameters for getting the best Balancer route */
export type GetBestBalancerRouteParams = {
    tokenIn: TokenDetails | SushiToken;
    tokenOut: TokenDetails | SushiToken;
    swapAmount: bigint;
    ignoreCache?: boolean;
};

/** Represents a cached Balancer route */
export type BalancerCachedRoute = {
    /** The route paths details used for getting calldata */
    route: BalancerRouterPath[];
    /** The timestamp until which the route is valid */
    validUntil: number;
    /** The price of the route from balancer API */
    price: bigint;
    /**
     * The on-chain price of the route, this is usually equal to the
     * price or pretty close, as the price might sometimes lag slightly
     * due to subgraph lags
     */
    onchainPrice?: bigint;
};

/** Enumerates the possible error types that can occur within the Balancer Router functionalities */
export enum BalancerRouterErrorType {
    UnsupportedChain,
    NoRouteFound,
    FetchFailed,
    SwapQueryFailed,
}

/**
 * Represents an error type for the Balancer Router functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `BalancerRouterErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // with cause
 * throw new BalancerRouterError("msg", BalancerRouterErrorType);
 *
 * // without cause
 * throw new BalancerRouterError("msg", BalancerRouterErrorType, originalError);
 * ```
 */
export class BalancerRouterError extends RainSolverBaseError {
    type: BalancerRouterErrorType;
    constructor(message: string, type: BalancerRouterErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "BalancerRouterError";
    }
}

/**
 * The Balancer Router class provides methods to interact with the Balancer protocol,
 * including fetching routes from balancer API, getting best route and market price as well
 * as managing runtime cache for routes.
 */
export class BalancerRouter {
    /** The shared state of the router */
    readonly chainId: number;
    /** The address of the router contract */
    readonly routerAddress: `0x${string}`;
    /** The protocol version of the balancer */
    readonly protocolVersion = 3 as const;
    /** The duration for which a route is considered valid in cache */
    readonly routeTime = 60_000 as const; // 1 minute in milliseconds
    /** The Balancer API instance */
    readonly balancerApi: BalancerApi;
    /** The cache for storing previously fetched routes that are valid until specified timestamp */
    readonly cache: Map<string, BalancerCachedRoute> = new Map();

    private constructor(chainId: number) {
        this.chainId = chainId;
        this.routerAddress = AddressProvider.BatchRouter(this.chainId);
        this.balancerApi = new BalancerApi(BALANCER_API_URL, this.chainId);
    }

    /**
     * Initializes the Balancer Router instance.
     * @param chainId The chain id of the opperating chain
     * @returns A Result containing the Balancer Router instance or an error
     */
    static init(chainId: number): Result<BalancerRouter, BalancerRouterError> {
        if (
            !balancerV3Contracts.BatchRouter[
                chainId as keyof typeof balancerV3Contracts.BatchRouter
            ]
        ) {
            return Result.err(
                new BalancerRouterError(
                    `Balancer router does not support chain with id: ${chainId}`,
                    BalancerRouterErrorType.UnsupportedChain,
                ),
            );
        }
        return Result.ok(new BalancerRouter(chainId));
    }

    /**
     * Gets the balancer market price for a token pair by simulating balancer swap query
     * @param params The parameters for getting the best Balancer route and market price
     * @param signer The signer instance
     */
    async getMarketPrice(
        params: GetBestBalancerRouteParams,
        signer: PublicClient | RainSolverSigner,
        address: `0x${string}` = `0x${"1".repeat(40)}`,
    ): Promise<
        Result<
            { price: bigint; route: BalancerRouterPath[]; amountOut: bigint },
            BalancerRouterError
        >
    > {
        try {
            const route = await this.getBestRoute(params);
            if (route.isErr()) {
                return Result.err(route.error);
            }
            if (typeof route.value.onchainPrice === "bigint") {
                return Result.ok({
                    price: route.value.onchainPrice,
                    route: route.value.route,
                    amountOut: route.value.route[0].minAmountOut,
                });
            }
            const result = await signer.simulateContract({
                address: this.routerAddress,
                abi: ABI.BalancerBatchRouter.Primary.BatchRouterV3,
                functionName: "querySwapExactIn",
                args: [route.value.route, signer.account?.address ?? address, "0x"],
            });

            const [price, amountOut] = (() => {
                try {
                    const amountOut = result.result[2][0];
                    const amountOut18 = scaleTo18(amountOut, params.tokenOut.decimals);
                    const amountIn18 = scaleTo18(params.swapAmount, params.tokenIn.decimals);
                    const onchainPrice = (amountOut18 * ONE18) / amountIn18;
                    route.value.onchainPrice = onchainPrice;
                    return [onchainPrice, amountOut];
                } catch {
                    return [route.value.price, route.value.route[0].minAmountOut];
                }
            })();

            return Result.ok({ price, route: route.value.route, amountOut });
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
     * Gets the best Balancer route for a given token pair and swap amount
     * @param params The parameters for getting the best Balancer route
     */
    async getBestRoute(
        params: GetBestBalancerRouteParams,
    ): Promise<Result<BalancerCachedRoute, BalancerRouterError>> {
        const key = `${params.tokenIn.address.toLowerCase()}/${params.tokenOut.address.toLowerCase()}`;

        // search in cache first and return early if ignoreCache is false
        if (!params.ignoreCache) {
            const cachedRoute = this.cache.get(key);
            if (cachedRoute && cachedRoute.validUntil > Date.now()) {
                return Result.ok(cachedRoute);
            }
        }

        const balancerSortedRoutes = await this.fetchSortedRoutes(params);
        if (balancerSortedRoutes.isErr()) {
            return Result.err(balancerSortedRoutes.error);
        }

        let minAmountOut = 0n;
        balancerSortedRoutes.value.forEach((route) => {
            minAmountOut += route.minAmountOut;
        });
        const amountOut18 = scaleTo18(minAmountOut, params.tokenOut.decimals);
        const amountIn18 = scaleTo18(params.swapAmount, params.tokenIn.decimals);
        const price = (amountOut18 * ONE18) / amountIn18;
        const route = {
            route: [
                {
                    ...balancerSortedRoutes.value[0],
                    exactAmountIn: params.swapAmount,
                    minAmountOut,
                },
            ],
            validUntil: Date.now() + this.routeTime,
            price,
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
            const { tokenIn: _tokenIn, tokenOut: _tokenOut, swapAmount: _swapAmount } = params;
            const tokenIn = new Token(
                this.chainId,
                _tokenIn.address as `0x${string}`,
                _tokenIn.decimals,
                _tokenIn.symbol ?? "unknownSymbol",
            );
            const tokenOut = new Token(
                this.chainId,
                _tokenOut.address as `0x${string}`,
                _tokenOut.decimals,
                _tokenOut.symbol ?? "unknownSymbol",
            );
            const swapAmount = TokenAmount.fromRawAmount(tokenIn, _swapAmount);
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
}
