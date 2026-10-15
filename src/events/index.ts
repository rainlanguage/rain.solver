import { Hex } from "./types";
import { OrderManager } from "../order";
import { SgFilter } from "../subgraph/filter";
import { SubgraphVersions } from "../subgraph/types";
import { EventSink, OrderbookSyncer } from "./syncer";

export * from "./types";
export * from "./decode";
export * from "./ledger";
export * from "./ingestor";
export * from "./syncer";

/**
 * Wraps an order manager as the sink of a syncer. The syncer adds and removes
 * the orders through the same order manager methods that the subgraph sync uses
 * @param orderManager - The order manager
 */
export function orderManagerSink(orderManager: OrderManager): EventSink {
    return {
        addOrder: (order) => orderManager.addOrder(order),
        removeOrder: (order) => orderManager.removeOrders([order]),
        updateMeta: (orderbook, owner, orderHash, meta) =>
            orderManager.updateOrderMeta(orderbook, owner, orderHash, meta),
    };
}

/**
 * Builds a syncer for one orderbook that keeps the given order manager in step
 * with the chain, the syncer writes the vault balances into the order manager's
 * own ledger, so the round reads them with no copy in between, and the order
 * manager is told the logs own the balances of this orderbook from now on, and
 * on a v6 orderbook that vault id 0 is vaultless
 * @param orderManager - The order manager to keep in step
 * @param orderbook - The orderbook the syncer follows
 * @param version - The version of the subgraph that indexes the orderbook
 * @param filters - The order filters, the same the subgraph fetch applies
 * @param onPark - (optional) Called when an event parks for the first time, see OrderbookSyncerConfig
 */
export function syncerFor(
    orderManager: OrderManager,
    orderbook: Hex,
    version: SubgraphVersions,
    filters?: SgFilter,
    onPark?: () => void,
): OrderbookSyncer {
    orderManager.logSyncedOrderbooks.add(orderbook.toLowerCase());
    // vault id 0 of a v6 orderbook is a vaultless io, see OrderManager.isVaultless
    if (version === SubgraphVersions.V6) {
        orderManager.vaultlessOrderbooks.add(orderbook.toLowerCase());
    }
    return new OrderbookSyncer({
        orderbook,
        sink: orderManagerSink(orderManager),
        ledger: orderManager.ledger,
        filters,
        version,
        onPark,
    });
}
