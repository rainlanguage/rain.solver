import { USDC } from "sushi/currency";
import { ABI, Result } from "../../common";
import { calculatePrice18, ONE18 } from "../../math";
import { StabullConstants } from "./constants";
import { TakeOrdersConfigType } from "../../order/types";
import { StabullRouterError, StabullRouterErrorType } from "./error";
import {
    Chain,
    Account,
    Transport,
    parseUnits,
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

/** Represents the parameters for quoting Stabull */
export type StabullQuoteParams = RainSolverRouterQuoteParams;

/** Represents the quote details for a Stabull route */
export type StabullRouterQuote = {
    /** The router type */
    type: RouterType.Stabull;
    /** The status of the route */
    status: RouteStatus;
    /** The price of the route */
    price: bigint;
    /** The amount out for the given amount in of the route */
    amountOut: bigint;
};

/** Represents the trade params for a Stabull route */
export type StabullTradeParams = {
    /** The router type */
    type: RouterType.Stabull;
    /** The quote details for the Stabull route */
    quote: StabullRouterQuote;
    /** The visual representation of the route */
    routeVisual: string[];
    /** The TakeOrdersConfig struct for onchain execution */
    takeOrdersConfigStruct: TakeOrdersConfigType;
};

/** Represents a cached Stabull price */
export type StabullCachedPrice = {
    /** The status of the route */
    status: RouteStatus;
    /** The price in 18 fixed point decimals */
    price: bigint;
    /** The timestamp until which the route is valid */
    validUntil: number;
};

/**
 * The Stabull Router class provides methods to interact with the stabull protocol.
 * Stabull DEX supports very limited set of tokens and it can only support a trade
 * when both IO tokens are supported (this is done through `canTrade` static method).
 * For finding the best route and quoting, we just need to call its `Router` contract
 * functions on the supported chains.
 * List of supported chains, tokens and pools can be found in {@link StabullConstants}
 */
export class StabullRouter extends RainSolverRouterBase {
    /** The address of the router contract */
    readonly routerAddress: `0x${string}`;
    /** The address of the quote currency, usually USDC as per Stabull docs */
    readonly quoteCurrencyAddress: `0x${string}`;
    /** The duration for which a price is considered valid in cache */
    readonly cacheTime = 300_000 as const;
    /** The cache for storing previously fetched prices that are valid until specified timestamp */
    readonly cache: Map<string, StabullCachedPrice> = new Map();

    constructor(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
    ) {
        super(chainId, client);
        this.routerAddress =
            StabullConstants.Routers[chainId as keyof typeof StabullConstants.Routers];
        this.quoteCurrencyAddress =
            StabullConstants.QuoteCurrency[chainId as keyof typeof StabullConstants.QuoteCurrency];
    }

    /**
     * Tries to initialize the Stabull Router for the given chain id and viem client
     * @param chainId - The chain id of the operating chain
     * @param client - A viem client instance
     * @returns A Result containing the Stabull Router instance or an error
     */
    static async create(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
    ): Promise<Result<StabullRouter, StabullRouterError>> {
        if (!StabullConstants.isChainSupported(chainId)) {
            return Result.err(
                new StabullRouterError(
                    `Chain with id of "${chainId}" is not supported by Stabull Router`,
                    StabullRouterErrorType.UnsupportedChain,
                ),
            );
        }

        return Result.ok(new StabullRouter(chainId, client));
    }

    /** Gets the list of this liquidity provider */
    getLiquidityProvidersList(): string[] {
        return ["Stabull"];
    }

    /**
     * Gets the market price for a token pair and swap amount.
     * @param params The parameters for the market price query
     * @returns The formatted market price for the token pair
     */
    async getMarketPrice(
        params: StabullQuoteParams,
    ): Promise<Result<{ price: string }, StabullRouterError>> {
        // return early if from and to tokens are the same
        if (params.fromToken.address.toLowerCase() === params.toToken.address.toLowerCase()) {
            return Result.ok({ price: "1" });
        }
        const key = `${params.fromToken.address.toLowerCase()}/${params.toToken.address.toLowerCase()}`;

        // search in cache first and return early if ignoreCache is false
        if (!params.ignoreCache) {
            const cachedPrice = this.cache.get(key);
            if (cachedPrice && cachedPrice.validUntil > Date.now()) {
                if (cachedPrice.status === RouteStatus.Success) {
                    return Result.ok({ price: formatUnits(cachedPrice.price, 18) });
                } else {
                    return Result.err(
                        new StabullRouterError(
                            "Did not find any route for this token pair",
                            StabullRouterErrorType.NoRouteFound,
                        ),
                    );
                }
            }
        }

        const quoteResult = await this.findBestRoute(params);
        if (quoteResult.isErr()) {
            const toUsdcQuote = await this.findBestRoute({
                ...params,
                toToken: USDC[this.chainId as keyof typeof USDC],
            });
            if (!toUsdcQuote?.isOk()) {
                this.cache.set(key, {
                    status: RouteStatus.NoWay,
                    price: 0n,
                    validUntil: Date.now() + this.cacheTime,
                });
                return Result.err(quoteResult.error);
            }
            const fromUsdcPrice = await params.sushiRouter?.getMarketPrice({
                ...params,
                fromToken: USDC[this.chainId as keyof typeof USDC],
            });
            if (!fromUsdcPrice?.isOk()) {
                this.cache.set(key, {
                    status: RouteStatus.NoWay,
                    price: 0n,
                    validUntil: Date.now() + this.cacheTime,
                });
                return Result.err(quoteResult.error);
            }

            const price =
                (toUsdcQuote.value.price * parseUnits(fromUsdcPrice.value.price, 18)) / ONE18;
            this.cache.set(key, {
                status: RouteStatus.Success,
                price,
                validUntil: Date.now() + this.cacheTime,
            });
            return Result.ok({ price: formatUnits(price, 18) });
        }
        this.cache.set(key, {
            status: RouteStatus.Success,
            price: quoteResult.value.price,
            validUntil: Date.now() + this.cacheTime,
        });
        return Result.ok({ price: formatUnits(quoteResult.value.price, 18) });
    }

    /**
     * Gets the Stabull market quote for a token pair by simulating Stabull swap query
     * @param params The parameters for getting the best Stabull market quote
     */
    async tryQuote(
        params: StabullQuoteParams,
    ): Promise<Result<StabullRouterQuote, StabullRouterError>> {
        const quoteResult = await this.findBestRoute(params);
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        return Result.ok(quoteResult.value);
    }

    /**
     * Finds the best Stabull route for a given token pair and swap amount
     * @param params The parameters for getting the best Stabull route
     */
    async findBestRoute(
        params: StabullQuoteParams,
    ): Promise<Result<StabullRouterQuote, StabullRouterError>> {
        const { fromToken, toToken, amountIn } = params;

        // exit early if token pair (at least one of the tokens of the trade) is not supported by Stabull
        if (!StabullRouter.canTrade(fromToken.address, toToken.address, this.chainId)) {
            return Result.err(
                new StabullRouterError(
                    "Cannot trade this token pair on Stabull router as one or both tokens are not supported",
                    StabullRouterErrorType.NoRouteFound,
                ),
            );
        }

        // try to find a route using the Stabull router by calling the router contract quote function
        try {
            const result = await this.client.readContract({
                abi: ABI.Stabull.Primary.Router,
                address: this.routerAddress,
                functionName: "viewOriginSwap",
                args: [this.quoteCurrencyAddress, fromToken.address, toToken.address, amountIn],
            });
            const price = calculatePrice18(amountIn, result, fromToken.decimals, toToken.decimals);
            return Result.ok({
                type: RouterType.Stabull,
                status: RouteStatus.Success,
                price,
                amountOut: result,
            });
        } catch (error) {
            return Result.err(
                new StabullRouterError(
                    "Failed to find route in stabull router for the given token pair",
                    StabullRouterErrorType.FetchFailed,
                    error,
                ),
            );
        }
    }

    /**
     * Gets the trade parameters for the best possible market quote for
     * executing a trade against Stabull Router with the returned value.
     * @param args - The trade arguments
     */
    async getTradeParams(
        args: GetTradeParamsArgs,
    ): Promise<Result<StabullTradeParams, StabullRouterError>> {
        const { state, maximumInput, orderDetails, toToken, fromToken, isPartial } = args;
        const gasPrice = state.gasPrice;

        // get route details from stabull dataFetcher
        const quoteResult = await this.tryQuote({
            fromToken,
            toToken,
            amountIn: maximumInput,
            gasPrice,
        });

        // exit early if no route found
        if (quoteResult.isErr()) {
            return Result.err(quoteResult.error);
        }
        const quote = quoteResult.value;

        const takeOrdersConfigStructResult = this.getTakeOrdersConfig(
            orderDetails,
            maximumInput,
            quote.price,
            encodeAbiParameters([{ type: "address" }], [this.quoteCurrencyAddress]),
            state.appOptions.maxRatio,
            isPartial,
        );
        if (takeOrdersConfigStructResult.isErr()) {
            return Result.err(
                new StabullRouterError(
                    "Failed to build TakeOrdersConfig struct",
                    StabullRouterErrorType.WasmEncodedError,
                    takeOrdersConfigStructResult.error,
                ),
            );
        }
        const takeOrdersConfigStruct = takeOrdersConfigStructResult.value;

        return Result.ok({
            type: RouterType.Stabull,
            quote,
            routeVisual: [],
            takeOrdersConfigStruct,
        });
    }

    /**
     * Checks if a trade can take place between the given `from/to` tokens on Stabull
     * protocol as Stabull only supports a limited set of tokens on each chain.
     * @param fromToken - The token to be sold in the swap
     * @param toToken - The token to be received in the swap
     * @param chainId - The chain id of the operating chain
     * @returns True if the trade is possible for the given token pair, false otherwise
     */
    static canTrade(fromToken: `0x${string}`, toToken: `0x${string}`, chainId: number): boolean {
        return (
            StabullConstants.isChainSupported(chainId) &&
            StabullConstants.TokenList[chainId].has(toToken.toLowerCase()) &&
            StabullConstants.TokenList[chainId].has(fromToken.toLowerCase())
        );
    }
}
