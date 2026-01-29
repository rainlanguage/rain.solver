import axios from "axios";
import { Result } from "../common";
import { SgFilter } from "./filter";
import { SubgraphConfig } from "./config";
import { statusCheckQuery } from "./query";
import { PreAssembledSpan } from "../logger";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorSeverity, errorSnapshot } from "../error";
import { SgOrder, SgTransaction, SubgraphSyncState, SubgraphVersions } from "./types";
import { getTxsQuery, orderbooksQuery, DEFAULT_PAGE_SIZE, getQueryPaginated } from "./query";

// re-export
export * from "./types";
export * from "./config";

// default headers for axios subgraph queries
export const headers = { "Content-Type": "application/json" } as const;

// keeps track of subgraoh versions
export type SubgraphVersionList = {
    oldVersions: Set<string>;
    v6: Set<string>;
};

/**
 * Manages multiple subgraph endpoints, providing methods to fetch, sync, and monitor order edtails.
 * It handles communication with a set of subgraph URLs, supporting operations such as fetching
 * active orders, syncing order changes, retrieving orderbook addresses, and checking subgraph
 * indexing status. It maintains internal state for each subgraph to track synchronization progress.
 */
export class SubgraphManager {
    /** List of subgraph urls */
    readonly subgraphs: string[];
    readonly versions: SubgraphVersionList = {
        oldVersions: new Set(),
        v6: new Set(),
    };
    /** Subgraph filters */
    readonly filters?: SgFilter;
    /** Subgraphs sync state */
    readonly syncState: Record<string, SubgraphSyncState> = {};

    /** Optional query timeout */
    requestTimeout?: number;

    constructor(config: SubgraphConfig) {
        this.subgraphs = config.subgraphs.map((url) => {
            if (url.startsWith("v6=")) {
                this.versions.v6.add(url.slice(3));
                return url.slice(3);
            } else {
                this.versions.oldVersions.add(url);
                return url;
            }
        });
        this.filters = config.filters;
        this.requestTimeout = config.requestTimeout;
        this.subgraphs.forEach(
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
    async statusCheck(): Promise<Result<PreAssembledSpan[], PreAssembledSpan[]>> {
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
            return Result.err(result.map((v) => (v as PromiseRejectedResult).reason));
        } else {
            return Result.ok(result.map((v) => (v.status === "rejected" ? v.reason : v.value)));
        }
    }

    /**
     * Fetches details of all orders that are active from the given subgraph url
     * @param url - The subgraph url
     */
    async fetchSubgraphOrders(url: string, version: SubgraphVersions): Promise<SgOrder[]> {
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
                const orders: SgOrder[] = res.data.data.orders;
                if (version === SubgraphVersions.V6) {
                    orders.forEach((v) => (v.__version = SubgraphVersions.V6));
                } else {
                    orders.forEach((v) => (v.__version = SubgraphVersions.LEGACY));
                }
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
    async fetchAll(): Promise<
        Result<
            { orders: SgOrder[]; report: PreAssembledSpan },
            { report: PreAssembledSpan; orders: undefined }
        >
    > {
        const report = new PreAssembledSpan("fetch-orders");
        const promises = this.subgraphs.map(async (url) => {
            try {
                const result = await this.fetchSubgraphOrders(url, this.getSubgraphVersion(url));
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
            return Result.err({ report, orders: undefined });
        } else {
            return Result.ok({
                report,
                orders: results
                    .filter((result) => result.status === "fulfilled")
                    .map((v) => (v as PromiseFulfilledResult<SgOrder[]>).value)
                    .flat(),
            });
        }
    }

    /**
     * Fetches the upstream events from subgraphs since the last fetch,
     * events include order additions, removals, vault operations, and trades.
     * @returns A Promise that resolves with the status report and the list of fetched events
     */
    async getUpstreamEvents() {
        const status: any = {};
        const promises = this.subgraphs.map(async (url) => {
            status[url] = {};
            const allResults: SgTransaction[] = [];
            const startTimestamp = this.syncState[url].lastFetchTimestamp;
            let partiallyFetched = false;
            for (;;) {
                try {
                    const res = await axios.post(
                        url,
                        { query: getTxsQuery(startTimestamp, this.syncState[url].skip) },
                        { headers, timeout: this.requestTimeout },
                    );
                    if (typeof res?.data?.data?.transactions !== "undefined") {
                        partiallyFetched = true;
                        const txs: SgTransaction[] = res.data.data.transactions;
                        this.syncState[url].skip += txs.length;
                        if (this.getSubgraphVersion(url) === SubgraphVersions.V6) {
                            txs.forEach((v) => (v.__version = SubgraphVersions.V6));
                        } else {
                            txs.forEach((v) => (v.__version = SubgraphVersions.LEGACY));
                        }
                        allResults.push(...txs);
                        if (txs.length < DEFAULT_PAGE_SIZE) {
                            status[url].status = "Fully fetched";
                            break;
                        }
                    } else {
                        throw "Received invalid response";
                    }
                } catch (error) {
                    status[url].status = await errorSnapshot(
                        partiallyFetched ? "Partially fetched" : "Failed to fetch",
                        error,
                    );
                    break;
                }
            }
            return allResults;
        });

        const results = await Promise.all(promises);

        const result: Record<string, SgTransaction[]> = {};
        results.forEach((v, i) => (result[this.subgraphs[i]] = v));

        return { status, result };
    }

    // get the version of the subgraph url
    getSubgraphVersion(url: string): SubgraphVersions {
        if (this.versions.v6.has(url)) {
            return SubgraphVersions.V6;
        } else {
            return SubgraphVersions.LEGACY;
        }
    }
}
