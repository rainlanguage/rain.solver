import { OrderManager } from ".";
import { errorSnapshot } from "../error";
import { normalizeFloat } from "../common";
import { PreAssembledSpan } from "../logger";
import { SgTransaction } from "../subgraph/types";
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
            const decimals = Number(event.vault.token.decimals);
            const balance = normalizeFloat(event.vault.balance, decimals);
            if (balance.isErr()) continue;

            this.updateVault(
                event.orderbook.id,
                event.vault.owner,
                {
                    address: event.vault.token.address,
                    symbol: event.vault.token.symbol,
                    decimals,
                },
                BigInt(event.vault.vaultId),
                balance.value,
            );
        }
        if (event.__typename === "Clear" || event.__typename === "TakeOrder") {
            // handle vault balance changes in trades
            event?.trades?.forEach((trade) => {
                const inputDecimals = Number(trade.inputVaultBalanceChange.vault.token.decimals);
                const inputBalance = normalizeFloat(
                    trade.inputVaultBalanceChange.vault.balance,
                    inputDecimals,
                );
                if (inputBalance.isErr()) return;
                this.updateVault(
                    trade.inputVaultBalanceChange.orderbook.id,
                    trade.inputVaultBalanceChange.vault.owner,
                    {
                        address: trade.inputVaultBalanceChange.vault.token.address,
                        symbol: trade.inputVaultBalanceChange.vault.token.symbol,
                        decimals: inputDecimals,
                    },
                    BigInt(trade.inputVaultBalanceChange.vault.vaultId),
                    inputBalance.value,
                );

                const outputDecimals = Number(trade.outputVaultBalanceChange.vault.token.decimals);
                const outputBalance = normalizeFloat(
                    trade.outputVaultBalanceChange.vault.balance,
                    outputDecimals,
                );
                if (outputBalance.isErr()) return;
                this.updateVault(
                    trade.outputVaultBalanceChange.orderbook.id,
                    trade.outputVaultBalanceChange.vault.owner,
                    {
                        address: trade.outputVaultBalanceChange.vault.token.address,
                        symbol: trade.outputVaultBalanceChange.vault.token.symbol,
                        decimals: outputDecimals,
                    },
                    BigInt(trade.outputVaultBalanceChange.vault.vaultId),
                    outputBalance.value,
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
