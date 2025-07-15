import { TokenDetails } from "../state";
import { Result, OrderV3 } from "../common";
import { decodeAbiParameters, DecodeAbiParametersErrorType, parseAbiParameters } from "viem";

export const OrderV3Abi = parseAbiParameters(OrderV3);

export type TakeOrderDetails = {
    id: string;
    quote?: {
        maxOutput: bigint;
        ratio: bigint;
    };
    takeOrder: TakeOrder;
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

export type IO = {
    token: `0x${string}`;
    decimals: number;
    vaultId: bigint;
};

export type Order = {
    owner: `0x${string}`;
    nonce: `0x${string}`;
    evaluable: Evaluable;
    validInputs: IO[];
    validOutputs: IO[];
};
export namespace Order {
    /** Decodes order bytes into OrderV3 struct */
    export function tryFromBytes(orderBytes: string): Result<Order, DecodeAbiParametersErrorType> {
        try {
            const decoded = decodeAbiParameters(OrderV3Abi, orderBytes as `0x${string}`)[0];
            return Result.ok({
                owner: decoded.owner.toLowerCase() as `0x${string}`,
                nonce: decoded.nonce.toLowerCase() as `0x${string}`,
                evaluable: {
                    interpreter: decoded.evaluable.interpreter.toLowerCase() as `0x${string}`,
                    store: decoded.evaluable.store.toLowerCase() as `0x${string}`,
                    bytecode: decoded.evaluable.bytecode.toLowerCase() as `0x${string}`,
                },
                validInputs: decoded.validInputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    decimals: v.decimals,
                    vaultId: v.vaultId,
                })),
                validOutputs: decoded.validOutputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    decimals: v.decimals,
                    vaultId: v.vaultId,
                })),
            });
        } catch (err: any) {
            return Result.err(err);
        }
    }
}

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
