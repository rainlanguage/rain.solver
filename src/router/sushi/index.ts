import { Pair } from "../../order";
import { Result } from "../../common";
import { Token } from "sushi/currency";
import { MultiRoute, RouteLeg } from "sushi/tines";
import { RainSolverBaseError } from "../../error/types";
import { BlackListSet, RPoolFilter } from "./blacklist";
import { TakeOrdersConfigType } from "../../core/types";
import { calculatePrice18, scaleFrom18, scaleTo18 } from "../../math";
import { ChainId, LiquidityProviders, PoolCode, RainDataFetcher, Router } from "sushi";
import {
    Chain,
    Account,
    Transport,
    maxUint256,
    formatUnits,
    PublicClient,
    encodeAbiParameters,
} from "viem";
import {
    RouterType,
    RouteStatus,
    GetTradeParamsArgs,
    RainSolverRouterBase,
    RainSolverRouterQuoteParams,
} from "../types";
import {
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_3_1_ADDRESS,
    ROUTE_PROCESSOR_3_2_ADDRESS,
} from "sushi/config";

export * from "./blacklist";

/** Sushi RouteProcessor addresses grouped by version */
export namespace SushiRouteProcessorAddresses {
    /** Version 3 */
    export const V3 = ROUTE_PROCESSOR_3_ADDRESS;
    /** Version 3.1 */
    export const V3_1 = ROUTE_PROCESSOR_3_1_ADDRESS;
    /** Version 3.2 */
    export const V3_2 = ROUTE_PROCESSOR_3_2_ADDRESS;
    /** Version 4 */
    export const V4 = ROUTE_PROCESSOR_4_ADDRESS;
}

/**
 * List of liquidity providers that are excluded
 */
export const ExcludedLiquidityProviders = [
    LiquidityProviders.CurveSwap,
    LiquidityProviders.Camelot,
    LiquidityProviders.Trident,
] as const;

/** Represents the parameters for quoting Sushi */
export type SushiQuoteParams = RainSolverRouterQuoteParams;

/** Represents the quote details for a Sushi route */
export type SushiRouterQuote = {
    /** The router type */
    type: RouterType.Sushi;
    /** The status of the route */
    status: RouteStatus;
    /** The price of the route */
    price: bigint;
    /** The route details */
    route: {
        route: MultiRoute;
        pcMap: Map<string, PoolCode>;
    };
    /** The amount out for the given amount in of the route */
    amountOut: bigint;
};

/** Represents the trade params for a Sushi route */
export type SushiTradeParams = {
    /** The router type */
    type: RouterType.Sushi;
    /** The quote details for the Sushi route */
    quote: SushiRouterQuote;
    /** The visual representation of the route */
    routeVisual: string[];
    /** The TakeOrdersConfig struct for onchain execution */
    takeOrdersConfigStruct: TakeOrdersConfigType;
};

/** Enumerates the possible error types that can occur within the Sushi Router functionalities */
export enum SushiRouterErrorType {
    InitializationError,
    NoRouteFound,
    FetchFailed,
}

/**
 * Represents an error type for the Sushi Router functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `SushiRouterErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new SushiRouterError("msg", SushiRouterErrorType);
 *
 * // with cause
 * throw new SushiRouterError("msg", SushiRouterErrorType, originalError);
 * ```
 */
export class SushiRouterError extends RainSolverBaseError {
    type: SushiRouterErrorType;
    constructor(message: string, type: SushiRouterErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "SushiRouterError";
    }
}

/**
 * The Sushi Router class provides methods to interact with the sushi router library, mainly `RainDataFetcher`,
 * including fetching and syncing pool data, getting best route and market price.
 */
export class SushiRouter extends RainSolverRouterBase {
    /** The address of the route processor contract */
    readonly routerAddress: `0x${string}`;
    /** The protocol version of the Sushi */
    readonly protocolVersion = 4 as const;
    /** The list of liquidity providers to use, if undefined, all available liquidity provider for the operating chain will be used */
    readonly liquidityProviders?: LiquidityProviders[];

    /** The sushi router data fetcher instance for interacting */
    dataFetcher: RainDataFetcher;

    constructor(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
        dataFetcher: RainDataFetcher,
        routerAddress: `0x${string}`,
        liquidityProviders?: LiquidityProviders[],
    ) {
        super(chainId, client);
        this.dataFetcher = dataFetcher;
        this.routerAddress = routerAddress;
        this.liquidityProviders = liquidityProviders;
    }

    /**
     * Tries to initialize the Sushi Router instance from the given params
     * @param chainId - The chain id of the operating chain
     * @param client - A viem client instance
     * @param routerAddress - The address of the RouteProcessor4 contract
     * @param liquidityProviders - Optional list of liquidity providers to use, if undefined,
     * all available liquidity provider for the operating chain will be used
     * @returns A Result containing the Sushi Router instance or an error
     */
    static async create(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
        routerAddress: `0x${string}`,
        liquidityProviders?: LiquidityProviders[],
    ): Promise<Result<SushiRouter, SushiRouterError>> {
        const lps = !liquidityProviders
            ? undefined
            : liquidityProviders.filter((v) => !ExcludedLiquidityProviders.includes(v as any));

        const dataFetcherResult: Result<RainDataFetcher, Error> = await RainDataFetcher.init(
            chainId as ChainId,
            client as any,
            lps,
        )
            .then((v) => Result.ok(v) as Result<RainDataFetcher, Error>)
            .catch((e: any) => Result.err(e));
        if (dataFetcherResult.isErr())
            return Result.err(
                new SushiRouterError(
                    "Failed to initialize RainDataFetcher",
                    SushiRouterErrorType.InitializationError,
                    dataFetcherResult.error,
                ),
            );

        return Result.ok(
            new SushiRouter(chainId, client, dataFetcherResult.value, routerAddress, lps),
        );
    }

    /**
     * Gets the market price for a token pair and swap amount.
     * @param params The parameters for the market price query
     * @returns The formatted market price for the token pair
     */
    async getMarketPrice(
        params: SushiQuoteParams,
    ): Promise<Result<{ price: string }, SushiRouterError>> {
        // return early if from and to tokens are the same
        if (params.fromToken.address.toLowerCase() === params.toToken.address.toLowerCase()) {
            return Result.ok({ price: "1" });
        }

        const quoteResult = await this.findBestRoute(params);
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        return Result.ok({ price: formatUnits(quoteResult.value.price, 18) });
    }

    /**
     * Gets the Sushi market quote for a token pair by simulating Sushi swap query
     * @param params The parameters for getting the best Sushi market quote
     */
    async tryQuote(params: SushiQuoteParams): Promise<Result<SushiRouterQuote, SushiRouterError>> {
        const quoteResult = await this.findBestRoute(params);
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        return Result.ok(quoteResult.value);
    }

    /**
     * Finds the best Sushi route for a given token pair and swap amount
     * @param params The parameters for getting the best Sushi route
     */
    async findBestRoute(
        params: SushiQuoteParams,
    ): Promise<Result<SushiRouterQuote, SushiRouterError>> {
        const {
            fromToken,
            toToken,
            amountIn,
            gasPrice,
            blockNumber = undefined,
            ignoreCache = undefined,
            skipFetch = false,
        } = params;
        try {
            if (!skipFetch) {
                await this.dataFetcher.fetchPoolsForToken(fromToken, toToken, BlackListSet, {
                    blockNumber,
                    ignoreCache,
                });
            }
            const pcMap = this.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
            const route = Router.findBestRoute(
                pcMap,
                this.chainId as ChainId,
                fromToken,
                amountIn,
                toToken,
                Number(gasPrice),
                undefined,
                RPoolFilter,
                undefined,
                params.sushiRouteType,
            );
            if (route.status == "NoWay") {
                return Result.err(
                    new SushiRouterError(
                        "Sushi router found no route for the given token pair",
                        SushiRouterErrorType.NoRouteFound,
                    ),
                );
            } else {
                const price = calculatePrice18(
                    amountIn,
                    route.amountOutBI,
                    fromToken.decimals,
                    toToken.decimals,
                );
                return Result.ok({
                    type: RouterType.Sushi,
                    status: RouteStatus.Success,
                    price,
                    route: { route, pcMap },
                    amountOut: route.amountOutBI,
                });
            }
        } catch (error) {
            return Result.err(
                new SushiRouterError(
                    "Failed to get sushi router pool data for the given token pair",
                    SushiRouterErrorType.FetchFailed,
                    error,
                ),
            );
        }
    }

    /**
     * Updates the pool data to the latest block or the specified block number
     * @param blockNumber - Optional block number to fetch the pools data at a specific block height
     */
    async update(blockNumber?: bigint) {
        await this.dataFetcher.updatePools(blockNumber);
    }

    /** Resets the data fetcher to a fresh instance */
    async reset() {
        try {
            this.dataFetcher = await RainDataFetcher.init(
                this.chainId as ChainId,
                this.client as any,
                this.liquidityProviders,
            );
        } catch {}
    }

    /** Gets the list of active liquidity providers */
    getLiquidityProvidersList(): string[] {
        return this.dataFetcher.providers.map((v) => v.getPoolProviderName());
    }

    /**
     * Resolves an array of case-insensitive names to LiquidityProviders type, ignores the ones that are not valid
     * @param liquidityProviders - List of liquidity providers
     */
    static processLiquidityProviders(liquidityProviders?: string[]): LiquidityProviders[] {
        const LPS = Object.values(LiquidityProviders);
        if (!liquidityProviders || !liquidityProviders.length) {
            return LPS.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
        }
        const lps: LiquidityProviders[] = [];
        for (let i = 0; i < liquidityProviders.length; i++) {
            const index = LPS.findIndex(
                (v) => v.toLowerCase() === liquidityProviders[i].toLowerCase().trim(),
            );
            if (index > -1 && !lps.includes(LPS[index])) lps.push(LPS[index]);
        }
        return lps.length ? lps : LPS.filter((v) => !ExcludedLiquidityProviders.includes(v as any));
    }

    /**
     * Method to visualize the routes, returns array of route strings sorted from highest to lowest percentage
     * @param fromToken - The from token address
     * @param toToken - The to token address
     * @param legs - The legs of the route
     */
    static visualizeRoute(fromToken: Token, toToken: Token, legs: RouteLeg[]): string[] {
        return [
            // direct
            ...legs
                .filter(
                    (v) =>
                        v.tokenTo.address.toLowerCase() === toToken.address.toLowerCase() &&
                        v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase(),
                )
                .map((v) => [v]),

            // indirect
            ...legs
                .filter(
                    (v) =>
                        v.tokenFrom.address.toLowerCase() === fromToken.address.toLowerCase() &&
                        v.tokenTo.address.toLowerCase() !== toToken.address.toLowerCase(),
                )
                .map((v) => {
                    const portions: RouteLeg[] = [v];
                    while (
                        portions.at(-1)?.tokenTo.address.toLowerCase() !==
                        toToken.address.toLowerCase()
                    ) {
                        const legPortion = legs.find(
                            (e) =>
                                e.tokenFrom.address.toLowerCase() ===
                                    portions.at(-1)?.tokenTo.address.toLowerCase() &&
                                portions.every(
                                    (k) =>
                                        k.poolAddress.toLowerCase() !== e.poolAddress.toLowerCase(),
                                ),
                        );
                        if (legPortion) {
                            portions.push(legPortion);
                        } else {
                            break;
                        }
                    }
                    return portions;
                }),
        ]
            .sort((a, b) => b[0].absolutePortion - a[0].absolutePortion)
            .map(
                (v) =>
                    (v[0].absolutePortion * 100).toFixed(2).padStart(5, "0") +
                    "%   --->   " +
                    v
                        .map(
                            (e) =>
                                (e.tokenTo.symbol ??
                                    (e.tokenTo.address.toLowerCase() ===
                                    toToken.address.toLowerCase()
                                        ? toToken.symbol
                                        : "unknownSymbol")) +
                                "/" +
                                (e.tokenFrom.symbol ??
                                    (e.tokenFrom.address.toLowerCase() ===
                                    fromToken.address.toLowerCase()
                                        ? fromToken.symbol
                                        : "unknownSymbol")) +
                                " (" +
                                (e as any).poolName +
                                " " +
                                e.poolAddress +
                                ")",
                        )
                        .join(" >> "),
            );
    }

    async getTradeParams(
        args: GetTradeParamsArgs,
    ): Promise<Result<SushiTradeParams, SushiRouterError>> {
        const { state, maximumInput, orderDetails, toToken, fromToken, blockNumber, isPartial } =
            args;
        const gasPrice = state.gasPrice;

        // get route details from sushi dataFetcher
        const quoteResult = await this.tryQuote({
            fromToken,
            toToken,
            amountIn: maximumInput,
            gasPrice,
            blockNumber,
            skipFetch: true,
        });

        // exit early if no route found
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        const quote = quoteResult.value;

        const routeVisual: string[] = [];
        try {
            SushiRouter.visualizeRoute(
                fromToken,
                toToken,
                quoteResult.value.route.route.legs,
            ).forEach((v) => {
                routeVisual.push(v);
            });
        } catch {
            /**/
        }

        const rpParams = Router.routeProcessor4Params(
            quoteResult.value.route.pcMap,
            quoteResult.value.route.route,
            fromToken,
            toToken,
            state.appOptions.arbAddress as `0x${string}`,
            state.chainConfig.routeProcessors["4"],
        );

        const orders = [orderDetails.takeOrder.struct];
        const takeOrdersConfigStruct: TakeOrdersConfigType = {
            minimumInput: 1n,
            maximumInput: isPartial ? maximumInput : maxUint256,
            maximumIORatio: state.appOptions.maxRatio ? maxUint256 : quote.price,
            orders,
            data: encodeAbiParameters([{ type: "bytes" }], [rpParams.routeCode]),
        };

        return Result.ok({
            type: RouterType.Sushi,
            quote,
            routeVisual,
            takeOrdersConfigStruct,
        });
    }

    /**
     * Calculates the largest possible partial trade size for rp clear, returns undefined if
     * it cannot be determined due to the fact that order's ratio being higher than market
     * price
     * @param orderDetails - The order details
     * @param toToken - The token to trade to
     * @param fromToken - The token to trade from
     * @param maximumInputFixed - The maximum input amount (in 18 decimals)
     * @param gasPriceBI - The current gas price (in bigint)
     * @param routeType - The route type, single or multi
     */
    findLargestTradeSize(
        orderDetails: Pair,
        toToken: Token,
        fromToken: Token,
        maximumInputFixed: bigint,
        gasPriceBI: bigint,
        routeType: "single" | "multi" = "single",
    ): bigint | undefined {
        const result: bigint[] = [];
        const gasPrice = Number(gasPriceBI);
        const ratio = orderDetails.takeOrder.quote!.ratio;
        const pcMap = this.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
        const initAmount = scaleFrom18(maximumInputFixed, fromToken.decimals) / 2n;
        let maximumInput = initAmount;
        for (let i = 1n; i < 26n; i++) {
            const maxInput18 = scaleTo18(maximumInput, fromToken.decimals);
            const route = Router.findBestRoute(
                pcMap,
                this.chainId as ChainId,
                fromToken,
                maximumInput,
                toToken,
                gasPrice,
                undefined,
                RPoolFilter,
                undefined,
                routeType,
            );

            if (route.status == "NoWay") {
                maximumInput = maximumInput - initAmount / 2n ** i;
            } else {
                const price = calculatePrice18(
                    maximumInput,
                    route.amountOutBI,
                    fromToken.decimals,
                    toToken.decimals,
                );

                if (price < ratio) {
                    maximumInput = maximumInput - initAmount / 2n ** i;
                } else {
                    result.unshift(maxInput18);
                    maximumInput = maximumInput + initAmount / 2n ** i;
                }
            }
        }

        if (result.length) {
            return result[0];
        } else {
            return undefined;
        }
    }
}
