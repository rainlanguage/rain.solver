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

/**
 * Applies the given filters to the given order and returns true if it passes, otherwise returns false
 * @param order - The order
 * @param filters - The subgraph filters
 */
export function applyFilters(order: SgOrder, filters?: SgFilter): boolean {
    if (!filters) return true;
    else {
        // apply include filter
        if (filters.includeOrderbooks) {
            if (!filters.includeOrderbooks.has(order.orderbook.id)) {
                return false;
            }
        }
        if (filters.includeOrders) {
            if (!filters.includeOrders.has(order.orderHash)) {
                return false;
            }
        }
        if (filters.includeOwners) {
            if (!filters.includeOwners.has(order.owner)) {
                return false;
            }
        }

        // apply exclude filters
        if (filters.excludeOrderbooks) {
            if (filters.excludeOrderbooks.has(order.orderbook.id)) {
                return false;
            }
        }
        if (filters.excludeOrders) {
            if (filters.excludeOrders.has(order.orderHash)) {
                return false;
            }
        }
        if (filters.excludeOwners) {
            if (filters.excludeOwners.has(order.owner)) {
                return false;
            }
        }

        return true;
    }
}
