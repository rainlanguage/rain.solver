import { Order } from "./versions";
import { TokenDetails } from "../common";

export { Order };

export type TakeOrderDetails = {
    id: string;
    quote?: {
        maxOutput: bigint;
        ratio: bigint;
    };
    struct: TakeOrder;
};

export type TakeOrder = {
    order: Order;
    inputIOIndex: number;
    outputIOIndex: number;
    signedContext: any[];
};
export namespace TakeOrder {
    /** Get a QuoteConfig type from TakeOrder */
    export function getQuoteConfig(takeOrder: TakeOrder) {
        return {
            ...takeOrder,
            inputIOIndex: BigInt(takeOrder.inputIOIndex),
            outputIOIndex: BigInt(takeOrder.outputIOIndex),
        };
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
// export type CounterpartyType = "IntraOrderbook" | "InterOrderbook";

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

export type Pair = {
    orderbook: string;
    buyToken: string;
    buyTokenDecimals: number;
    buyTokenSymbol: string;
    buyTokenVaultBalance: bigint;
    sellToken: string;
    sellTokenDecimals: number;
    sellTokenSymbol: string;
    sellTokenVaultBalance: bigint;
    takeOrder: TakeOrderDetails;
};

export type OrderProfile = {
    active: boolean;
    order: Order;
    takeOrders: Pair[];
};

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
