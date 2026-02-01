import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { RainSolverSigner } from "../signer";
import { RainSolverRouterError } from "./error";
import { WasmEncodedError } from "@rainlanguage/float";
import { maxFloat, minFloat, Result, toFloat } from "../common";
import type { StabullRouterQuote, StabullTradeParams } from "./stabull";
import type { BalancerRouterQuote, BalancerTradeParams } from "./balancer";
import type { SushiRouter, SushiRouterQuote, SushiTradeParams } from "./sushi";
import { Account, Chain, maxUint256, PublicClient, Transport } from "viem";
import {
    Pair,
    PairV3,
    PairV4,
    TakeOrdersConfigType,
    TakeOrdersConfigTypeV3,
    TakeOrdersConfigTypeV4,
    TakeOrdersConfigTypeV5,
} from "../order";

/** Represents the different router types */
export enum RouterType {
    /** The Sushi router (RainDataFetcher) */
    Sushi = "sushi",
    /** The Balancer router (BatchRouter) */
    Balancer = "balancer",
    /** The Stabull router */
    Stabull = "stabull",
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
    sushiRouter?: SushiRouter;
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
export type TradeParamsType = SushiTradeParams | BalancerTradeParams | StabullTradeParams;

/** Represents the quote details for a RainSolverRouter route */
export type RainSolverRouterQuote = SushiRouterQuote | BalancerRouterQuote | StabullRouterQuote;

/**
 * Base class for all RainSolverRouter implementations.
 * It defines the common interface and properties that all routers must implement,
 * including methods for getting market prices, quoting trades, finding the best route,
 * and retrieving trade parameters.
 */
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

    /**
     * Gets the current market price for a given params as decimal string.
     * @param params - The quote parameters
     */
    abstract getMarketPrice(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<{ price: string }, RainSolverRouterError>>;

    /**
     * Tries to get the best market quote for the given params.
     * @param params - The quote parameters
     */
    abstract tryQuote(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>>;

    /**
     * Finds the best route for the given params.
     * @param params - The quote parameters
     */
    abstract findBestRoute(
        params: RainSolverRouterQuoteParams,
    ): Promise<Result<RainSolverRouterQuote, RainSolverRouterError>>;

    /** Gets the list of available liquidity providers */
    abstract getLiquidityProvidersList(): string[];

    /**
     * Gets the trade parameters for executing a trade with the returned value.
     * @param params - The trade parameters arguments
     */
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

    /**
     * Creates a new TakeOrdersConfigTypeV4 based on the given v3 order and other parameters
     * This is the default implementation, but child classes can override it if needed.
     * @param order The order pair v3 to create the config for
     * @param maximumInput The maximum input amount
     * @param price The current market price for input amount
     * @param data The TakeOrdersConfig data
     * @param maxRatio Whether to use the maximum IO ratio
     * @param isPartial Whether the trade is a partial fill
     */
    getTakeOrdersConfigV3(
        order: PairV3,
        maximumInput: bigint,
        price: bigint,
        data: `0x${string}`,
        maxRatio: boolean,
        isPartial: boolean,
    ): TakeOrdersConfigTypeV3 {
        const takeOrdersConfigStruct: TakeOrdersConfigTypeV3 = {
            minimumInput: 1n,
            maximumInput: isPartial ? maximumInput : maxUint256,
            maximumIORatio: maxRatio ? maxUint256 : price,
            orders: [order.takeOrder.struct],
            data,
        };
        return takeOrdersConfigStruct;
    }

    /**
     * Creates a new TakeOrdersConfigTypeV4 based on the given v4 order and other parameters
     * This is the default implementation, but child classes can override it if needed.
     * @param order The order pair v4 to create the config for
     * @param maximumInput The maximum input amount
     * @param price The current market price for input amount
     * @param data The TakeOrdersConfig data
     * @param maxRatio Whether to use the maximum IO ratio
     * @param isPartial Whether the trade is a partial fill
     */
    getTakeOrdersConfigV4(
        order: PairV4,
        maximumInput: bigint,
        price: bigint,
        data: `0x${string}`,
        maxRatio: boolean,
        isPartial: boolean,
    ): Result<TakeOrdersConfigTypeV4, WasmEncodedError> {
        let maximumInputFloat: `0x${string}` = maxFloat(order.sellTokenDecimals);
        if (isPartial) {
            const valueResult = toFloat(maximumInput, order.sellTokenDecimals);
            if (valueResult.isErr()) {
                return Result.err(valueResult.error);
            }
            maximumInputFloat = valueResult.value;
        }

        let maximumIORatioFloat: `0x${string}` = maxFloat(18);
        if (!maxRatio) {
            const valueResult = toFloat(price, 18);
            if (valueResult.isErr()) {
                return Result.err(valueResult.error);
            }
            maximumIORatioFloat = valueResult.value;
        }

        const takeOrdersConfigStruct: TakeOrdersConfigTypeV4 = {
            minimumInput: minFloat(order.sellTokenDecimals),
            maximumInput: maximumInputFloat,
            maximumIORatio: maximumIORatioFloat,
            orders: [order.takeOrder.struct],
            data,
        };
        return Result.ok(takeOrdersConfigStruct);
    }

    /**
     * Creates a new TakeOrdersConfigTypeV5 based on the given v4 order and other parameters
     * This is the default implementation, but child classes can override it if needed.
     * @param order The order pair v4 to create the config for
     * @param maximumInput The maximum input amount
     * @param price The current market price for input amount
     * @param data The TakeOrdersConfig data
     * @param maxRatio Whether to use the maximum IO ratio
     * @param isPartial Whether the trade is a partial fill
     */
    getTakeOrdersConfigV5(
        order: PairV4,
        maximumInput: bigint,
        price: bigint,
        data: `0x${string}`,
        maxRatio: boolean,
        isPartial: boolean,
    ): Result<TakeOrdersConfigTypeV5, WasmEncodedError> {
        let maximumInputFloat: `0x${string}` = maxFloat(order.sellTokenDecimals);
        if (isPartial) {
            const valueResult = toFloat(maximumInput, order.sellTokenDecimals);
            if (valueResult.isErr()) {
                return Result.err(valueResult.error);
            }
            maximumInputFloat = valueResult.value;
        }

        let maximumIORatioFloat: `0x${string}` = maxFloat(18);
        if (!maxRatio) {
            const valueResult = toFloat(price, 18);
            if (valueResult.isErr()) {
                return Result.err(valueResult.error);
            }
            maximumIORatioFloat = valueResult.value;
        }

        const takeOrdersConfigStruct: TakeOrdersConfigTypeV5 = {
            minimumIO: minFloat(order.sellTokenDecimals),
            maximumIO: maximumInputFloat,
            maximumIORatio: maximumIORatioFloat,
            IOIsInput: true,
            orders: [order.takeOrder.struct],
            data,
        };
        return Result.ok(takeOrdersConfigStruct);
    }

    /**
     * Creates a new TakeOrdersConfigType based on the given order, its version and other parameters
     * This is the default implementation that works for both V3 and V4 orders, but child classes can
     * override it if needed.
     * @param order The order pair to create the config for
     * @param maximumInput The maximum input amount
     * @param price The current market price for input amount
     * @param data The TakeOrdersConfig data
     * @param maxRatio Whether to use the maximum IO ratio
     * @param isPartial Whether the trade is a partial fill
     */
    getTakeOrdersConfig(
        order: Pair,
        maximumInput: bigint,
        price: bigint,
        data: `0x${string}`,
        maxRatio: boolean,
        isPartial: boolean,
    ): Result<TakeOrdersConfigType, WasmEncodedError> {
        if (Pair.isV3(order)) {
            return Result.ok(
                this.getTakeOrdersConfigV3(order, maximumInput, price, data, maxRatio, isPartial),
            );
        } else if (Pair.isV4OrderbookV5(order)) {
            return this.getTakeOrdersConfigV4(
                order,
                maximumInput,
                price,
                data,
                maxRatio,
                isPartial,
            );
        } else {
            return this.getTakeOrdersConfigV5(
                order,
                maximumInput,
                price,
                data,
                maxRatio,
                isPartial,
            );
        }
    }
}
