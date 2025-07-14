import axios from "axios";
import { statusCheckQuery } from "./query";
import { PreAssembledSpan } from "../logger";
import { applyFilters, SgFilter } from "./filter";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorSeverity, errorSnapshot } from "../error";
import { getTxsQuery, orderbooksQuery, DEFAULT_PAGE_SIZE, getQueryPaginated } from "./query";
import {
    SgOrder,
    SgOrderUpdate,
    SgTransaction,
    SubgraphSyncState,
    SubgraphSyncResult,
} from "./types";
import { SubgraphConfig } from "./config";

// re-export
export * from "./types";
export * from "./config";

// default headers for axios subgraph queries
const headers = { "Content-Type": "application/json" } as const;

/**
 * Manages multiple subgraph endpoints, providing methods to fetch, sync, and monitor order edtails.
 * It handles communication with a set of subgraph URLs, supporting operations such as fetching
 * active orders, syncing order changes, retrieving orderbook addresses, and checking subgraph
 * indexing status. It maintains internal state for each subgraph to track synchronization progress.
 */
export class SubgraphManager {
    /** List of subgraph urls */
    readonly subgraphs: string[];
    /** Subgraph filters */
    readonly filters?: SgFilter;
    /** Subgraphs sync state */
    readonly syncState: Record<string, SubgraphSyncState> = {};

    /** Optional query timeout */
    requestTimeout?: number;

    constructor(config: SubgraphConfig) {
        this.subgraphs = config.subgraphs;
        this.filters = config.filters;
        this.requestTimeout = config.requestTimeout;
        config.subgraphs.forEach(
            (url) =>
                (this.syncState[url] = {
                    skip: 0,
                    lastFetchTimestamp: 0,
                }),
        );
    }

    /**
     * Returns the list of orderbook addresses that all of the
     * subgraphs currently index, ignores failed and invalid responses
     */
    async getOrderbooks(): Promise<Set<string>> {
        const promises = this.subgraphs.map((url) =>
            axios.post(url, { query: orderbooksQuery }, { headers, timeout: this.requestTimeout }),
        );
        const queryResults = await Promise.allSettled(promises);
        const addresses = queryResults.flatMap(
            (res: any) => res?.value?.data?.data?.orderbooks?.map((v: any) => v.id) ?? [],
        );
        return new Set(addresses);
    }

    /**
     * Checks the status of the subgraphs for indexing error
     * @returns A Promise that resolves with the status report
     */
    async statusCheck(): Promise<PreAssembledSpan[]> {
        const promises = this.subgraphs.map(async (url) => {
            const report = new PreAssembledSpan("subgraph-status-check");
            report.setAttr("url", url);

            try {
                const result = await axios.post(
                    url,
                    { query: statusCheckQuery },
                    { headers, timeout: this.requestTimeout },
                );
                const status = result?.data?.data?._meta;
                if (status) {
                    if (status.hasIndexingErrors) {
                        // set err status and high severity if sg has indexing error
                        report.setAttr("severity", ErrorSeverity.HIGH);
                        report.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: "Subgraph has indexing error",
                        });
                    } else {
                        // everything is ok, subgraph has no indexing error
                        report.setStatus({ code: SpanStatusCode.OK });
                    }
                } else {
                    // set err status and medium severity for invalid response
                    report.setAttr("severity", ErrorSeverity.MEDIUM);
                    report.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: "Did not receive valid status response",
                    });
                }
                report.end();
                return report;
            } catch (error) {
                // set err status and medium severity and record exception
                report.setAttr("severity", ErrorSeverity.MEDIUM);
                report.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: await errorSnapshot("Subgraph status check query failed", error),
                });
                report.recordException(error as any);
                report.end();

                throw report;
            }
        });

        const result = await Promise.allSettled(promises);
        if (result.every((v) => v.status === "rejected")) {
            throw result.map((v) => (v as PromiseRejectedResult).reason);
        } else {
            return result.map((v) => (v.status === "rejected" ? v.reason : v.value));
        }
    }

    /**
     * Fetches details of all orders that are active from the given subgraph url
     * @param url - The subgraph url
     */
    async fetchSubgraphOrders(url: string): Promise<SgOrder[]> {
        const result: SgOrder[] = [];
        let skip = 0;
        let timestamp = Date.now();
        for (;;) {
            timestamp = Date.now();
            const res = await axios.post(
                url,
                {
                    query: getQueryPaginated(skip, this.filters),
                },
                { headers, timeout: this.requestTimeout },
            );
            if (res?.data?.data?.orders) {
                const orders = res.data.data.orders;
                result.push(...orders);
                if (orders.length < DEFAULT_PAGE_SIZE) {
                    break;
                } else {
                    skip += DEFAULT_PAGE_SIZE;
                }
            } else {
                throw "Received invalid response";
            }
        }
        this.syncState[url].lastFetchTimestamp = Math.floor(timestamp / 1000);
        return result;
    }

    /**
     * Fetches all active orders of all subgraphs
     * @returns A promise that resolves with the fetch status report and list of fetched order details
     */
    async fetchAll(): Promise<{ orders: SgOrder[]; report: PreAssembledSpan }> {
        const report = new PreAssembledSpan("fetch-orders");
        const promises = this.subgraphs.map(async (url) => {
            try {
                const result = await this.fetchSubgraphOrders(url);
                report.setAttr(`fetchStatus.${url}`, "Fully fetched");
                return result;
            } catch (error) {
                report.setAttr(
                    `fetchStatus.${url}`,
                    await errorSnapshot("Failed to fetch orders", error),
                );
                return Promise.reject();
            }
        });

        const results = await Promise.allSettled(promises);
        report.end();

        if (results.every((v) => v.status === "rejected")) {
            throw { report, orders: undefined };
        } else {
            return {
                report,
                orders: results
                    .filter((result) => result.status === "fulfilled")
                    .map((v) => (v as PromiseFulfilledResult<SgOrder[]>).value)
                    .flat(),
            };
        }
    }

    /**
     * Syncs orders to upstream changes (add or removal) since the last fetch
     * @returns A Promise that resolves with the sync status report and added and removed order details
     */
    async syncOrders() {
        const report = new PreAssembledSpan("sync-orders");
        const syncStatus: any = {};
        const promises = this.subgraphs.map(async (url) => {
            syncStatus[url] = {};
            const allResults: SgTransaction[] = [];
            const addOrders: SgOrderUpdate[] = [];
            const removeOrders: SgOrderUpdate[] = [];
            const startTimestamp = this.syncState[url].lastFetchTimestamp;
            let partiallySynced = false;
            for (;;) {
                try {
                    const res = await axios.post(
                        url,
                        { query: getTxsQuery(startTimestamp, this.syncState[url].skip) },
                        { headers, timeout: this.requestTimeout },
                    );
                    if (typeof res?.data?.data?.transactions !== "undefined") {
                        partiallySynced = true;
                        const txs = res.data.data.transactions;
                        this.syncState[url].skip += txs.length;
                        allResults.push(...txs);
                        if (txs.length < DEFAULT_PAGE_SIZE) {
                            break;
                        }
                    } else {
                        throw "Received invalid response";
                    }
                    syncStatus[url].status = "Fully synced";
                } catch (error) {
                    syncStatus[url].status = await errorSnapshot(
                        partiallySynced ? "Partially synced" : "Failed to sync",
                        error,
                    );
                    break;
                }
            }

            // handle results by applying filters and recording the order changes for report
            allResults.forEach((res) => {
                if (res?.events?.length) {
                    res.events.forEach((event) => {
                        if (event.__typename === "AddOrder") {
                            if (typeof event?.order?.active === "boolean" && event.order.active) {
                                if (!addOrders.find((e) => e.order.id === event.order.id)) {
                                    const newOrder: SgOrderUpdate = {
                                        order: event.order,
                                        timestamp: Number(res.timestamp),
                                    };

                                    // include if the order passes the filters
                                    if (applyFilters(newOrder.order, this.filters)) {
                                        if (!syncStatus[url][event.order.orderbook.id]) {
                                            syncStatus[url][event.order.orderbook.id] = {};
                                        }
                                        if (!syncStatus[url][event.order.orderbook.id].added) {
                                            syncStatus[url][event.order.orderbook.id].added = [];
                                        }
                                        syncStatus[url][event.order.orderbook.id].added.push(
                                            event.order.orderHash,
                                        );

                                        addOrders.push(newOrder);
                                    }
                                }
                            }
                        }
                        if (event.__typename === "RemoveOrder") {
                            if (typeof event?.order?.active === "boolean" && !event.order.active) {
                                if (!removeOrders.find((e) => e.order.id === event.order.id)) {
                                    if (!syncStatus[url][event.order.orderbook.id]) {
                                        syncStatus[url][event.order.orderbook.id] = {};
                                    }
                                    if (!syncStatus[url][event.order.orderbook.id].removed) {
                                        syncStatus[url][event.order.orderbook.id].removed = [];
                                    }
                                    syncStatus[url][event.order.orderbook.id].removed.push(
                                        event.order.orderHash,
                                    );
                                    removeOrders.push({
                                        order: event.order,
                                        timestamp: Number(res.timestamp),
                                    });
                                }
                            }
                        }
                    });
                }
            });
            return { addOrders, removeOrders };
        });

        const syncResults = await Promise.allSettled(promises);

        // conclude the report
        report.setAttr("syncStatus", JSON.stringify(syncStatus));
        report.end();

        const result: Record<string, SubgraphSyncResult> = {};
        syncResults.forEach((v, i) => {
            if (v.status === "fulfilled") result[this.subgraphs[i]] = v.value;
        });

        return { report, result };
    }
}
