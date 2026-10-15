import { SgOrder } from "./types";

/** Filter criteria for subgraph queries */
export type SgFilter = {
    /** Order hashes to include */
    includeOrders?: Set<string>;
    /** Owner addresses to include */
    includeOwners?: Set<string>;
    /** Order hashes to exclude (takes precedence over includeOrders) */
    excludeOrders?: Set<string>;
    /** Owner addresses to exclude (takes precedence over includeOwners) */
    excludeOwners?: Set<string>;
    /** Orderbook addresses to include */
    includeOrderbooks?: Set<string>;
    /** Orderbook addresses to exclude (takes precedence over includeOrderbooks) */
    excludeOrderbooks?: Set<string>;
};

/** The fields of an order the filters read, known before an order is decoded any further */
export type OrderFilterKeys = {
    /** The orderbook address */
    orderbook: string;
    orderHash: string;
    owner: string;
};

/**
 * Applies the given filters to the given order and returns true if it passes, otherwise returns false
 * @param order - The order
 * @param filters - The subgraph filters
 */
export function applyFilters(order: SgOrder, filters?: SgFilter): boolean {
    return passesFilters(
        { orderbook: order.orderbook.id, orderHash: order.orderHash, owner: order.owner },
        filters,
    );
}

/**
 * Applies the given filters to the keys of an order and returns true if it passes, otherwise returns false
 * @param keys - The orderbook, hash and owner of the order
 * @param filters - The subgraph filters
 */
export function passesFilters(keys: OrderFilterKeys, filters?: SgFilter): boolean {
    if (!filters) return true;
    else {
        // apply include filter
        if (filters.includeOrderbooks) {
            if (!filters.includeOrderbooks.has(keys.orderbook)) {
                return false;
            }
        }
        if (filters.includeOrders) {
            if (!filters.includeOrders.has(keys.orderHash)) {
                return false;
            }
        }
        if (filters.includeOwners) {
            if (!filters.includeOwners.has(keys.owner)) {
                return false;
            }
        }

        // apply exclude filters
        if (filters.excludeOrderbooks) {
            if (filters.excludeOrderbooks.has(keys.orderbook)) {
                return false;
            }
        }
        if (filters.excludeOrders) {
            if (filters.excludeOrders.has(keys.orderHash)) {
                return false;
            }
        }
        if (filters.excludeOwners) {
            if (filters.excludeOwners.has(keys.owner)) {
                return false;
            }
        }

        return true;
    }
}
