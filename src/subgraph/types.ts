/** Represents RainOrderbook order subgraph entity type */
export type SgOrder = {
    __version: SubgraphVersions; // injected
    id: string;
    owner: string;
    orderHash: string;
    orderBytes: string;
    active: boolean;
    nonce: string;
    orderbook: {
        id: string;
    };
    inputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
    outputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
};

/** Represents a order with an update (added or removed) at the timestamp */
export type SgOrderUpdate = {
    order: SgOrder;
    timestamp: number;
};

/** Represent RainOrderbook transactions entity type */
export type SgTransaction = {
    __version: SubgraphVersions; // injected
    events: SgEvent[];
    timestamp: string;
};

/** Type of a RainOrderbook subgraph event */
export type SgEvent = SgAddRemoveEvent | SgVaultOperationEvent | SgTradeEvent;

/** Represents Add/Remove Order event */
export type SgAddRemoveEvent = {
    __typename: "AddOrder" | "RemoveOrder";
    order: SgOrder;
};

/** Vault operation event types, deposit and withdraw */
export type SgVaultOperationEvent = {
    __typename: "Withdrawal" | "Deposit";
} & VaultChangeEvent;

/** Represents trade events */
export type SgTradeEvent = {
    __typename: "TakeOrder" | "Clear";
    trades: SgTrade[];
};

/** Represents vault balance change event */
export type VaultChangeEvent = {
    newVaultBalance: string;
    oldVaultBalance: string;
    vault: {
        owner: string;
        vaultId: string;
        balance: string;
        token: {
            address: string;
            symbol: string;
            decimals: string | number;
        };
    };
    orderbook: {
        id: string;
    };
};

/** Represents trade event details */
export type SgTrade = {
    inputVaultBalanceChange: VaultChangeEvent;
    outputVaultBalanceChange: VaultChangeEvent;
};

/** Represents subgraph sync result that include added and removed orders */
export type SubgraphSyncResult = {
    addOrders: SgOrderUpdate[];
    removeOrders: SgOrderUpdate[];
};

/** Keeps subgraph sync state */
export type SubgraphSyncState = {
    skip: number;
    lastFetchTimestamp: number;
};

export enum SubgraphVersions {
    LEGACY = "legacy", // for v4 and v5 orderbooks
    V6 = "v6",
}
