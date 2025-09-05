import { OrderManager } from ".";
import { errorSnapshot } from "../error";
import { SgTransaction } from "../subgraph";
import { PreAssembledSpan } from "../logger";
import { applyFilters } from "../subgraph/filter";

/** Syncs orders and vaults to upstream changes since the last fetch */
export async function syncOrders(this: OrderManager) {
    const report = new PreAssembledSpan("sync-orders");
    const { status: syncStatus, result } = await this.subgraphManager.getUpstreamEvents();

    // helper generator fn to yield events one by one
    const iterEvents = function* (events: Record<string, SgTransaction[]>) {
        for (const url in events) {
            for (const res of events[url]) {
                if (!res?.events?.length) continue;
                for (const event of res.events) {
                    yield { event, url, timestamp: Number(res.timestamp) };
                }
            }
        }
    };

    // process events one by one using generator
    for (const { event, url } of iterEvents(result)) {
        if (event.__typename === "Deposit" || event.__typename === "Withdrawal") {
            // handle vault balance changes in deposits and withdrawals
            this.updateVault(
                event.orderbook.id,
                event.vault.owner,
                {
                    address: event.vault.token.address,
                    symbol: event.vault.token.symbol,
                    decimals: Number(event.vault.token.decimals),
                },
                BigInt(event.vault.vaultId),
                BigInt(event.vault.balance),
            );
        }
        if (event.__typename === "Clear" || event.__typename === "TakeOrder") {
            // handle vault balance changes in trades
            event?.trades?.forEach((trade) => {
                this.updateVault(
                    trade.inputVaultBalanceChange.orderbook.id,
                    trade.inputVaultBalanceChange.vault.owner,
                    {
                        address: trade.inputVaultBalanceChange.vault.token.address,
                        symbol: trade.inputVaultBalanceChange.vault.token.symbol,
                        decimals: Number(trade.inputVaultBalanceChange.vault.token.decimals),
                    },
                    BigInt(trade.inputVaultBalanceChange.vault.vaultId),
                    BigInt(trade.inputVaultBalanceChange.vault.balance),
                );
                this.updateVault(
                    trade.outputVaultBalanceChange.orderbook.id,
                    trade.outputVaultBalanceChange.vault.owner,
                    {
                        address: trade.outputVaultBalanceChange.vault.token.address,
                        symbol: trade.outputVaultBalanceChange.vault.token.symbol,
                        decimals: Number(trade.outputVaultBalanceChange.vault.token.decimals),
                    },
                    BigInt(trade.outputVaultBalanceChange.vault.vaultId),
                    BigInt(trade.outputVaultBalanceChange.vault.balance),
                );
            });
        }
        if (event.__typename === "AddOrder") {
            // handle order addition if passes filters
            if (typeof event?.order?.active !== "boolean" || !event.order.active) continue;
            if (!applyFilters(event.order, this.subgraphManager.filters)) continue;

            if (!syncStatus[url][event.order.orderbook.id]) {
                syncStatus[url][event.order.orderbook.id] = {
                    added: [],
                    removed: [],
                    failedAdds: {},
                };
            }
            const result = await this.addOrder(event.order);
            if (result.isErr()) {
                syncStatus[url][event.order.orderbook.id].failedAdds[event.order.orderHash] =
                    await errorSnapshot("Failed to handle order", result.error);
            } else {
                syncStatus[url][event.order.orderbook.id].added.push(event.order.orderHash);
            }
        }
        if (event.__typename === "RemoveOrder") {
            // handle order removal
            if (typeof event?.order?.active === "boolean" && !event.order.active) {
                if (!syncStatus[url][event.order.orderbook.id]) {
                    syncStatus[url][event.order.orderbook.id] = {
                        added: [],
                        removed: [],
                    };
                }
                syncStatus[url][event.order.orderbook.id].removed.push(event.order.orderHash);
                this.removeOrders([event.order]);
            }
        }
    }

    // conclude the report
    report.name = "sync-orders";
    report.setAttr("syncStatus", JSON.stringify(syncStatus));
    report.end();

    return report;
}
