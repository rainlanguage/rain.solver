import { Pair } from "../order";
import { Result } from "../common";
import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { RainSolverSigner } from "../signer";
import { SushiRouterError, SushiRouterQuote, SushiTradeParams } from "./sushi";
import { Account, Chain, PublicClient, Transport } from "viem";
import { BalancerRouterError, BalancerRouterQuote, BalancerTradeParams } from "./balancer";
import { RainSolverBaseError } from "../error";

/** Represents the different router types */
export enum RouterType {
    /** The Sushi router (RainDataFetcher) */
    Sushi = "sushi",
    /** The Balancer router (BatchRouter) */
    Balancer = "balancer",
}

/** Represents the status of a route */
export enum RouteStatus {
    Success,
    NoWay,
}

/** Represents the parameters for quoting RainSolverRouter */
export type RainSolverRouterQuoteParams = {
    fromToken: Token;
    toToken: Token;
    amountIn: bigint;
    gasPrice: bigint;
    ignoreCache?: boolean;
    skipFetch?: boolean;
    blockNumber?: bigint;
    senderAddress?: `0x${string}`;
    sushiRouteType?: "single" | "multi";
};

/** Arguments for simulating a trade against routers */
export type GetTradeParamsArgs = {
    /** The shared state instance */
    state: SharedState;
    /** The bundled order details including tokens, decimals, and take orders */
    orderDetails: Pair;
    /** The maximum input amount (amountIn) */
    maximumInput: bigint;
    /** The RainSolverSigner instance */
    signer: RainSolverSigner;
    /** The token to be received in the swap */
    toToken: Token;
    /** The token to be sold in the swap */
    fromToken: Token;
    /** The current block number for context */
    blockNumber: bigint;
    /** Whether should set partial max input for take order */
    isPartial: boolean;
};

/** Represents the trade params for a RainSolverRouter route */
export type TradeParamsType = SushiTradeParams | BalancerTradeParams;

/** Represents the quote details for a RainSolverRouter route */
export type RainSolverRouterQuote = SushiRouterQuote | BalancerRouterQuote;

/** Enumerates the possible error types that can occur within the RainSolverRouter functionalities */
export enum RainSolverRouterErrorType {
    InitializationError,
    NoRouteFound,
    FetchFailed,
}

/**
 * Represents an error type for the RainSolverRouter functionalities.
 * This error class extends the `RainSolverBaseError` error class, with
 * the addition of optional properties to hold underlying errors from
 * the SushiRouter and BalancerRouter.
 *
 * @example
 * ```typescript
 * throw new RainSolverRouterError("msg", RainSolverRouterErrorType, SushiRouterError, BalancerRouterError);
 * ```
 */
export class RainSolverRouterError extends RainSolverBaseError {
    typ?: RainSolverRouterErrorType;
    sushiError?: SushiRouterError;
    balancerError?: BalancerRouterError;
    constructor(
        message: string,
        type: RainSolverRouterErrorType,
        sushiError?: SushiRouterError,
        balancerError?: BalancerRouterError,
    ) {
        const msgs = [message];
        if (sushiError) {
            msgs.push(`SushiRouterError: ${sushiError.message}`);
        }
        if (balancerError) {
            msgs.push(`BalancerRouterError: ${balancerError.message}`);
        }
        super(msgs.join("\n"));
        this.typ = type;
        this.sushiError = sushiError;
        this.balancerError = balancerError;
        this.name = "RainSolverRouterError";
    }
}

export abstract class RainSolverRouterBase {
    /** The chain id of the operating chain */
    readonly chainId: number;
    /** A viem client instance */
    readonly client: PublicClient<Transport, Chain | undefined, Account | undefined>;

    constructor(
        chainId: number,
        client: PublicClient<Transport, Chain | undefined, Account | undefined>,
    ) {
        this.chainId = chainId;
        this.client = client;
    }

    abstract getMarketPrice(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<{ price: string }, RainSolverRouterError>>;

    abstract tryQuote(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>>;

    abstract findBestRoute(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>>;

    abstract getLiquidityProvidersList(): string[];

    abstract getTradeParams(
        params: GetTradeParamsArgs,
    ): Promise<Result<TradeParamsType, RainSolverRouterError>>;

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
        routeType: "single" | "multi",
    ): bigint | undefined {
        // default implementation returns undefined, override in subclass if supported
        orderDetails;
        toToken;
        fromToken;
        maximumInputFixed;
        gasPriceBI;
        routeType;
        return undefined;
    }
}
