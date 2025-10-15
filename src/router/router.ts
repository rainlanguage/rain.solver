import { Pair } from "../order";
import { SushiRouter } from "./sushi";
import { Token } from "sushi/currency";
import { Err, Result } from "../common";
import { LiquidityProviders } from "sushi";
import { BalancerRouter } from "./balancer";
import { Account, Chain, PublicClient, Transport, parseUnits } from "viem";
import {
    TradeParamsType,
    GetTradeParamsArgs,
    RainSolverRouterBase,
    RainSolverRouterQuote,
    RainSolverRouterQuoteParams,
} from "./types";
import {
    SushiRouterError,
    BalancerRouterError,
    SushiRouterErrorType,
    RainSolverRouterError,
    BalancerRouterErrorType,
    RainSolverRouterErrorType,
} from "./error";
import { StabullRouter } from "./stabull";
import { StabullRouterError, StabullRouterErrorType } from "./stabull/error";

export type RainSolverRouterConfig = {
    /** The chain id of the operating chain */
    chainId: number;
    /** A viem client instance */
    client: PublicClient<Transport, Chain | undefined, Account | undefined>;
    /** Optional configuration for the Sushi router */
    sushiRouterConfig?: {
        /** The address of the SushiSwap Router v4 contract */
        sushiRouteProcessor4Address: `0x${string}`;
        /** Optional list of Sushi RP liquidity providers */
        liquidityProviders?: LiquidityProviders[];
    };
    /** Optional configuration for the Balancer router */
    balancerRouterConfig?: {
        /** The address of the Balancer BatchRouter contract */
        balancerRouterAddress: `0x${string}`;
    };
    /** Optional configuration for enabling the Stabull router */
    stabullRouter?: boolean;
};

/**
 * The RainSolverRouter class provides methods to interact with the sushi router library, mainly `RainDataFetcher`,
 * including fetching routes from RainSolverRouter API, getting best route and market price as well
 * as managing runtime cache for routes.
 */
export class RainSolverRouter extends RainSolverRouterBase {
    readonly sushi: SushiRouter | undefined;
    readonly balancer: BalancerRouter | undefined;
    readonly stabull: StabullRouter | undefined;

    constructor(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
        sushiRouter?: SushiRouter,
        balancerRouter?: BalancerRouter,
        stabullRouter?: StabullRouter,
    ) {
        super(chainId, client);
        this.sushi = sushiRouter;
        this.balancer = balancerRouter;
        this.stabull = stabullRouter;
    }

    /**
     * Tries to initialize the RainSolverRouter Router instance from the shared state.
     * @param config - The configuration for initializing the RainSolverRouter Router
     * @returns A Result containing the RainSolverRouter Router instance or an error
     */
    static async create(
        config: RainSolverRouterConfig,
    ): Promise<Result<RainSolverRouter, RainSolverRouterError>> {
        const { chainId, client, balancerRouterConfig, sushiRouterConfig, stabullRouter } = config;
        const sushiResult: Result<SushiRouter, SushiRouterError> = sushiRouterConfig
            ? await SushiRouter.create(
                  chainId,
                  client,
                  sushiRouterConfig.sushiRouteProcessor4Address,
                  sushiRouterConfig.liquidityProviders,
              )
            : Result.err(
                  new SushiRouterError(
                      "Undefined sushi router address",
                      SushiRouterErrorType.InitializationError,
                  ),
              );
        const balancerResult: Result<BalancerRouter, BalancerRouterError> = balancerRouterConfig
            ? await BalancerRouter.create(
                  chainId,
                  client,
                  balancerRouterConfig.balancerRouterAddress,
              )
            : Result.err(
                  new BalancerRouterError(
                      "Undefined balancer router address",
                      BalancerRouterErrorType.UnsupportedChain,
                  ),
              );
        const stabullResult: Result<StabullRouter, StabullRouterError> = stabullRouter
            ? await StabullRouter.create(chainId, client)
            : Result.err(
                  new StabullRouterError(
                      "Stabull router not enabled",
                      StabullRouterErrorType.InitializationError,
                  ),
              );
        if (sushiResult.isErr() && balancerResult.isErr() && stabullResult.isErr()) {
            return Result.err(
                new RainSolverRouterError(
                    "Failed initializing RainSolverRouter",
                    RainSolverRouterErrorType.InitializationError,
                    sushiResult.error,
                    balancerResult.error,
                    stabullResult.error,
                ),
            );
        }
        return Result.ok(
            new RainSolverRouter(
                chainId,
                client,
                sushiResult.isOk() ? sushiResult.value : undefined,
                balancerResult.isOk() ? balancerResult.value : undefined,
                stabullResult.isOk() ? stabullResult.value : undefined,
            ),
        );
    }

    /**
     * Gets the market price for a token pair and swap amount.
     * @param params The parameters for the market price query
     * @returns The formatted market price for the token pair
     */
    async getMarketPrice(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<{ price: string }, RainSolverRouterError>> {
        const promises = [
            this.sushi?.getMarketPrice(params),
            this.balancer?.getMarketPrice(params),
            this.stabull?.getMarketPrice({ ...params, sushiRouter: this.sushi }),
        ];
        const results = await Promise.all(promises);
        results.sort((a, b) => {
            if (!a?.isOk() && !b?.isOk()) return 0;
            if (!a?.isOk()) return 1;
            if (!b?.isOk()) return -1;
            const aPrice = parseUnits(a.value.price, 18);
            const bPrice = parseUnits(b.value.price, 18);
            if (aPrice < bPrice) {
                return 1;
            } else if (aPrice > bPrice) {
                return -1;
            } else {
                return 0;
            }
        });
        if (results.every((res) => !res?.isOk())) {
            return Result.err(getError("Failed to get market price", results));
        }
        return results[0] as Result<{ price: string }, RainSolverRouterError>;
    }

    /**
     * Gets the RainSolverRouter market quote for a token pair by simulating RainSolverRouter swap query
     * @param params The parameters for getting the best RainSolverRouter market quote
     */
    async tryQuote(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>> {
        const promises = [
            this.sushi?.tryQuote(params),
            this.balancer?.tryQuote(params),
            this.stabull?.tryQuote(params),
        ];
        const results = await Promise.all(promises);
        results.sort((a, b) => {
            if (!a?.isOk() && !b?.isOk()) return 0;
            if (!a?.isOk()) return 1;
            if (!b?.isOk()) return -1;
            if (a.value.amountOut < b.value.amountOut) {
                return 1;
            } else if (a.value.amountOut > b.value.amountOut) {
                return -1;
            } else {
                return 0;
            }
        });
        if (results.every((res) => !res?.isOk())) {
            return Result.err(getError("Failed to get quote", results));
        }
        return results[0] as Result<RainSolverRouterQuote, RainSolverRouterError>;
    }

    /**
     * Finds the best RainSolverRouter route for a given token pair and swap amount
     * @param params The parameters for getting the best RainSolverRouter route
     */
    async findBestRoute(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>> {
        const promises = [
            this.sushi?.findBestRoute(params),
            this.balancer?.findBestRoute(params),
            this.stabull?.findBestRoute(params),
        ];
        const results = await Promise.all(promises);
        results.sort((a, b) => {
            if (!a?.isOk() && !b?.isOk()) return 0;
            if (!a?.isOk()) return 1;
            if (!b?.isOk()) return -1;
            if (a.value.amountOut < b.value.amountOut) {
                return 1;
            } else if (a.value.amountOut > b.value.amountOut) {
                return -1;
            } else {
                return 0;
            }
        });
        if (results.every((res) => !res?.isOk())) {
            return Result.err(getError("Failed to find best route", results));
        }
        return results[0] as Result<RainSolverRouterQuote, RainSolverRouterError>;
    }

    async getTradeParams(
        args: GetTradeParamsArgs,
    ): Promise<Result<TradeParamsType, RainSolverRouterError>> {
        const promises = [
            this.sushi?.getTradeParams(args),
            this.balancer?.getTradeParams(args),
            this.stabull?.getTradeParams(args),
        ];
        const results = await Promise.all(promises);
        results.sort((a, b) => {
            if (!a?.isOk() && !b?.isOk()) return 0;
            if (!a?.isOk()) return 1;
            if (!b?.isOk()) return -1;
            if (a.value.quote.amountOut < b.value.quote.amountOut) {
                return 1;
            } else if (a.value.quote.amountOut > b.value.quote.amountOut) {
                return -1;
            } else {
                return 0;
            }
        });
        if (results.every((res) => !res?.isOk())) {
            return Result.err(getError("Failed to find trade route", results));
        }
        return results[0] as Result<TradeParamsType, RainSolverRouterError>;
    }

    findLargestTradeSize(
        orderDetails: Pair,
        toToken: Token,
        fromToken: Token,
        maximumInputFixed: bigint,
        gasPrice: bigint,
        routeType: "single" | "multi" = "single",
    ): bigint | undefined {
        return this.sushi?.findLargestTradeSize(
            orderDetails,
            toToken,
            fromToken,
            maximumInputFixed,
            gasPrice,
            routeType,
        );
    }

    getLiquidityProvidersList(): string[] {
        return [
            ...(this.balancer?.getLiquidityProvidersList() ?? []),
            ...(this.sushi?.getLiquidityProvidersList() ?? []),
            ...(this.stabull?.getLiquidityProvidersList() ?? []),
        ];
    }
}

function getError(
    msg: string,
    results: (
        | Result<any, SushiRouterError | BalancerRouterError | StabullRouterError>
        | undefined
    )[],
): RainSolverRouterError {
    let type = RainSolverRouterErrorType.FetchFailed;
    if (
        (!results[0] ||
            (results[0] as Err<SushiRouterError> | undefined)?.error?.type ===
                SushiRouterErrorType.NoRouteFound) &&
        (!results[1] ||
            (results[1] as Err<BalancerRouterError> | undefined)?.error?.type ===
                BalancerRouterErrorType.NoRouteFound) &&
        (!results[2] ||
            (results[2] as Err<StabullRouterError> | undefined)?.error?.type ===
                StabullRouterErrorType.NoRouteFound)
    ) {
        type = RainSolverRouterErrorType.NoRouteFound;
    }
    return new RainSolverRouterError(
        msg,
        type,
        (results[0] as Err<SushiRouterError> | undefined)?.error,
        (results[1] as Err<BalancerRouterError> | undefined)?.error,
        (results[2] as Err<StabullRouterError> | undefined)?.error,
    );
}
