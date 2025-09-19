/** Represents RainOrderbook order subgraph entity type */
export type SgOrder = {
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
    events: SgEvent[];
    timestamp: string;
};

/** Type of a RainOrderbook subgraph event */
export type SgEvent = SgAddRemoveEvent | SgOtherEvents;

/** Represents Add/Remove Order event */
export type SgAddRemoveEvent = {
    __typename: "AddOrder" | "RemoveOrder";
    order: SgOrder;
};

/** Other event types */
export type SgOtherEvents = {
    __typename: "Withdrawal" | "Deposit";
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
