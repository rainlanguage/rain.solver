/* eslint-disable @typescript-eslint/no-unused-vars */
import { SgOrder } from "../../subgraph";
import { Result, TokenDetails } from "../../common";
import { WasmEncodedError } from "@rainlanguage/float";
import {
    V3 as OrderV3,
    OrderProfileV3,
    PairV3,
    TakeOrderDetailsV3,
    TakeOrdersConfigTypeV3,
    TakeOrderV3,
} from "./v3";
import {
    V4 as OrderV4,
    OrderProfileV4,
    PairV4,
    TakeOrderDetailsV4,
    TakeOrdersConfigTypeV4,
    TakeOrderV4,
} from "./v4";

// Re-export types from v3 and v4
export { OrderV3, OrderProfileV3, PairV3, TakeOrderDetailsV3, TakeOrdersConfigTypeV3, TakeOrderV3 };
export { OrderV4, OrderProfileV4, PairV4, TakeOrderDetailsV4, TakeOrdersConfigTypeV4, TakeOrderV4 };

/** Represents an order with a specific version */
export type Order = OrderV3 | OrderV4;

/** @remarks Order namespace provides utilities and types related and for working with orders */
export namespace Order {
    /** Specifies the version of the order */
    export enum Type {
        V3 = "V3", // orderbook v4
        V4 = "V4", // orderbook v5
    }

    export import V3 = OrderV3;
    export import V4 = OrderV4;

    /** Decodes order bytes into OrderV3 struct */
    export function tryFromBytes(orderBytes: string): Result<Order, Error> {
        const v3Result = OrderV3.tryFromBytes(orderBytes);
        if (v3Result.isOk()) {
            return Result.ok(v3Result.value);
        }
        const v4Result = OrderV4.tryFromBytes(orderBytes);
        if (v4Result.isOk()) {
            return Result.ok(v4Result.value);
        }
        return Result.err(
            new Error("Failed to decode the given order bytes as OrderV3 and OrderV4"),
        );
    }
}

export type TakeOrderDetailsBase = {
    id: string;
    quote?: {
        maxOutput: bigint;
        ratio: bigint;
    };
};
export type TakeOrderDetails = TakeOrderDetailsV3 | TakeOrderDetailsV4;
export namespace TakeOrderDetails {
    /** Determines if the TakeOrderDetails is of type V3 */
    export function isV3(takeOrder: TakeOrderDetails): takeOrder is TakeOrderDetailsV3 {
        return takeOrder.struct.order.type === Order.Type.V3;
    }

    /** Determines if the TakeOrderDetails is of type V4 */
    export function isV4(takeOrder: TakeOrderDetails): takeOrder is TakeOrderDetailsV4 {
        return takeOrder.struct.order.type === Order.Type.V4;
    }
}

export type TakeOrder = TakeOrderV3 | TakeOrderV4;
export namespace TakeOrder {
    /** Get a QuoteConfig type from TakeOrder */
    export function getQuoteConfig(takeOrder: TakeOrder) {
        return {
            ...takeOrder,
            inputIOIndex: BigInt(takeOrder.inputIOIndex),
            outputIOIndex: BigInt(takeOrder.outputIOIndex),
        };
    }

    /** Determines if the TakeOrder is of type V3 */
    export function isV3(takeOrder: TakeOrder): takeOrder is TakeOrderV3 {
        return takeOrder.order.type === Order.Type.V3;
    }

    /** Determines if the TakeOrder is of type V4 */
    export function isV4(takeOrder: TakeOrder): takeOrder is TakeOrderV4 {
        return takeOrder.order.type === Order.Type.V4;
    }
}

export type Evaluable = {
    interpreter: `0x${string}`;
    store: `0x${string}`;
    bytecode: `0x${string}`;
};

/** Represents the source of the counterparty order for an order */
export enum CounterpartySource {
    IntraOrderbook,
    InterOrderbook,
}

export type BundledOrders = {
    orderbook: string;
    buyToken: string;
    buyTokenDecimals: number;
    buyTokenSymbol: string;
    sellToken: string;
    sellTokenDecimals: number;
    sellTokenSymbol: string;
    takeOrders: TakeOrderDetails[];
};

export type PairBase = {
    orderbook: string;
    buyToken: string;
    buyTokenDecimals: number;
    buyTokenSymbol: string;
    buyTokenVaultBalance: bigint;
    sellToken: string;
    sellTokenDecimals: number;
    sellTokenSymbol: string;
    sellTokenVaultBalance: bigint;
};
export type Pair = PairV3 | PairV4;
export namespace Pair {
    /** Determines if the Pair is of type V3 */
    export function isV3(pair: Pair): pair is PairV3 {
        return pair.takeOrder.struct.order.type === Order.Type.V3;
    }

    /** Determines if the Pair is of type V4 */
    export function isV4(pair: Pair): pair is PairV4 {
        return pair.takeOrder.struct.order.type === Order.Type.V4;
    }

    export function tryFromArgs(
        orderHash: string,
        orderStruct: Order,
        orderDetails: SgOrder,
        inputIOIndex: number,
        outputIOIndex: number,
        inputVaultMetadata: { token: string; symbol: string; decimals: number; balance: string },
        outputVaultMetadata: { token: string; symbol: string; decimals: number; balance: string },
    ): Result<Pair, WasmEncodedError> {
        if (orderStruct.type === Order.Type.V3) {
            return Result.ok(
                PairV3.fromArgs(
                    orderHash,
                    orderStruct,
                    orderDetails,
                    inputIOIndex,
                    outputIOIndex,
                    inputVaultMetadata,
                    outputVaultMetadata,
                ),
            );
        } else {
            return PairV4.fromArgs(
                orderHash,
                orderStruct,
                orderDetails,
                inputIOIndex,
                outputIOIndex,
                inputVaultMetadata,
                outputVaultMetadata,
            );
        }
    }
}

export type OrderProfile = OrderProfileV3 | OrderProfileV4;
export namespace OrderProfile {
    /** Determines if the OrderProfile is of type V3 */
    export function isV3(orderProfile: OrderProfile): orderProfile is OrderProfileV3 {
        return orderProfile.order.type === Order.Type.V3;
    }

    /** Determines if the OrderProfile is of type V4 */
    export function isV4(orderProfile: OrderProfile): orderProfile is OrderProfileV4 {
        return orderProfile.order.type === Order.Type.V4;
    }
}

export type OwnerProfile = {
    limit: number;
    lastIndex: number;
    orders: OrdersProfileMap;
};

export type OrdersProfileMap = Map<string, OrderProfile>;

export type OwnersProfileMap = Map<string, OwnerProfile>;

export type OrderbooksOwnersProfileMap = Map<string, OwnersProfileMap>;

export type OrderbooksPairMap = Map<string, PairMap>;

export type PairMap = Map<string, Map<string, Map<string, Pair>>>;

/** Represents the details of a token vault */
export type VaultDetails = {
    id: bigint;
    token: TokenDetails;
    balance: bigint;
};
/** token -> vault id -> vault details map */
export type TokenVaultMap = Map<string, Map<bigint, VaultDetails>>;
/** owner -> TokenVaultMap */
export type OwnerTokenVaultsMap = Map<string, TokenVaultMap>;
/** orderbook -> OwnerTokenVaultsMap */
export type OrderbookOwnerTokenVaultsMap = Map<string, OwnerTokenVaultsMap>;

export type TakeOrdersConfigType = TakeOrdersConfigTypeV3 | TakeOrdersConfigTypeV4;
export namespace TakeOrdersConfigType {
    /** Checks if the TakeOrdersConfigType is of type V3 */
    export function isV3(config: TakeOrdersConfigType): config is TakeOrdersConfigTypeV3 {
        return config.orders[0].order.type === Order.Type.V3;
    }

    /** Checks if the TakeOrdersConfigType is of type V4 */
    export function isV4(config: TakeOrdersConfigType): config is TakeOrdersConfigTypeV4 {
        return config.orders[0].order.type === Order.Type.V4;
    }
}
