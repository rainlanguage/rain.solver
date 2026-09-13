import axios from "axios";
import { SgOrder, SubgraphVersions } from "./types";
import { ErrorSeverity } from "../error";
import { SubgraphManager } from "./index";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("axios");

vi.mock("./query", async (importOriginal) => ({
    ...(await importOriginal()),
    DEFAULT_PAGE_SIZE: 1,
}));

describe("Test SubgraphManager", () => {
    const subgraphUrl = "https://example.com";
    const mockOrder = {
        id: "1",
        orderHash: "0xabc",
        active: true,
        orderbook: { id: "0xob1" },
    } as any as SgOrder;
    let manager: SubgraphManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new SubgraphManager({
            subgraphs: [subgraphUrl],
            filters: undefined,
            requestTimeout: 1000,
        });
    });

    it("should keep track of subgraph versions", () => {
        const url1 = "https:example1.com";
        const url2 = "https:exmaple2.com";
        const _manager = new SubgraphManager({
            subgraphs: [url1, `v6=${url2}`],
            filters: undefined,
            requestTimeout: 1000,
        });
        expect(_manager.syncState[url1]).toBeDefined();
        expect(_manager.syncState[url1].skip).toBe(0);
        expect(_manager.syncState[url1].lastFetchTimestamp).toBe(0);
        expect(_manager.versions.oldVersions).toEqual(new Set([url1]));

        expect(_manager.syncState[url2]).toBeDefined();
        expect(_manager.syncState[url2].skip).toBe(0);
        expect(_manager.syncState[url2].lastFetchTimestamp).toBe(0);
        expect(_manager.versions.v6).toEqual(new Set([url2]));
    });

    it("should initialize syncState for each subgraph", () => {
        expect(manager.syncState[subgraphUrl]).toBeDefined();
        expect(manager.syncState[subgraphUrl].skip).toBe(0);
        expect(manager.syncState[subgraphUrl].lastFetchTimestamp).toBe(0);
    });

    it("test fetchSubgraphOrders: should fetch and paginate orders", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: { data: { orders: [mockOrder] } },
            })
            .mockResolvedValueOnce({
                data: { data: { orders: [] } },
            });

        const orders = await manager.fetchSubgraphOrders(subgraphUrl, SubgraphVersions.LEGACY);
        expect(orders).toEqual([mockOrder]);
        expect(orders[0].__version).toBe(SubgraphVersions.LEGACY);
        expect(manager.syncState[subgraphUrl].lastFetchTimestamp).toBeGreaterThan(0);
    });

    it("test fetchSubgraphOrders: should fetch and paginate orders v6", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: { data: { orders: [mockOrder] } },
            })
            .mockResolvedValueOnce({
                data: { data: { orders: [] } },
            });

        const orders = await manager.fetchSubgraphOrders(subgraphUrl, SubgraphVersions.V6);
        expect(orders).toEqual([mockOrder]);
        expect(orders[0].__version).toBe(SubgraphVersions.V6);
        expect(manager.syncState[subgraphUrl].lastFetchTimestamp).toBeGreaterThan(0);
    });

    it("test fetchSubgraphOrders: should throw on invalid response", async () => {
        (axios.post as Mock).mockResolvedValueOnce({ data: { data: {} } });
        await expect(manager.fetchSubgraphOrders(subgraphUrl, SubgraphVersions.V6)).rejects.toBe(
            "Received invalid response",
        );
    });

    it("test fetchAll: should fetch all orders and report", async () => {
        vi.spyOn(manager, "fetchSubgraphOrders").mockResolvedValue([mockOrder]);
        const fetchAllResult = await manager.fetchAll();
        assert(fetchAllResult.isOk());
        const { orders, report } = fetchAllResult.value;
        expect(orders).toEqual([mockOrder]);
        expect(report.name).toBe("fetch-orders");
        expect(report.attributes[`fetchStatus.${subgraphUrl}`]).toBe("Fully fetched");
        expect(report.endTime).toBeGreaterThan(0);
    });

    it("test fetchAll: should throw if all fetches fail", async () => {
        vi.spyOn(manager, "fetchSubgraphOrders").mockRejectedValue("fail");
        const fetchAllResult = await manager.fetchAll();
        assert(fetchAllResult.isErr());
        expect(fetchAllResult.error).toMatchObject({
            orders: undefined,
            report: {
                attributes: {
                    [`fetchStatus.${subgraphUrl}`]: "Failed to fetch orders\nReason: fail",
                },
            },
        });
    });

    it("test getOrderbooks: should return orderbook addresses from all subgraphs", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: { data: { orderbooks: [{ id: "0x1" }, { id: "0x2" }] } },
        });
        const orderbooks = await manager.getOrderbooks();
        expect(orderbooks).toContain("0x1");
        expect(orderbooks).toContain("0x2");
        expect((axios.post as Mock).mock.calls[0][1].query).toContain("orderbooks {");
        expect((axios.post as Mock).mock.calls[0][1].query).not.toContain("raindices");
    });

    it("test getOrderbooks: should query raindices for v6 subgraphs", async () => {
        const v6Url = "https://v6.example.com";
        const _manager = new SubgraphManager({
            subgraphs: [subgraphUrl, `v6=${v6Url}`],
            filters: undefined,
            requestTimeout: 1000,
        });
        (axios.post as Mock).mockImplementation(async (url: string) => {
            if (url === v6Url) return { data: { data: { orderbooks: [{ id: "0x2" }] } } };
            return { data: { data: { orderbooks: [{ id: "0x1" }] } } };
        });
        const orderbooks = await _manager.getOrderbooks();
        expect(orderbooks).toEqual(new Set(["0x1", "0x2"]));

        const calls = (axios.post as Mock).mock.calls;
        const legacyCall = calls.find((c) => c[0] === subgraphUrl)!;
        const v6Call = calls.find((c) => c[0] === v6Url)!;
        expect(legacyCall[1].query).toContain("orderbooks {");
        expect(v6Call[1].query).toContain("orderbooks: raindices {");
    });

    it("test fetchSubgraphOrders: should query raindex entity for v6", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: { data: { orders: [] } },
        });
        await manager.fetchSubgraphOrders(subgraphUrl, SubgraphVersions.V6);
        expect((axios.post as Mock).mock.calls[0][1].query).toContain("orderbook: raindex {");
    });

    it("test fetchSubgraphOrders: should query orderbook entity for legacy", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: { data: { orders: [] } },
        });
        await manager.fetchSubgraphOrders(subgraphUrl, SubgraphVersions.LEGACY);
        expect((axios.post as Mock).mock.calls[0][1].query).toContain("orderbook {");
        expect((axios.post as Mock).mock.calls[0][1].query).not.toContain("raindex");
    });

    it("test statusCheck: should report OK when no indexing errors", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: { _meta: { hasIndexingErrors: false, block: { number: 1 } } } },
        });
        const statusCheckResult = await manager.statusCheck();
        assert(statusCheckResult.isOk());
        const reports = statusCheckResult.value;
        expect(reports[0].status).toEqual({ code: SpanStatusCode.OK });
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should report ERROR and HIGH severity on indexing errors", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: { _meta: { hasIndexingErrors: true, block: { number: 1 } } } },
        });
        const statusCheckResult = await manager.statusCheck();
        assert(statusCheckResult.isOk());
        const reports = statusCheckResult.value;
        expect(reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        expect(reports[0].attributes.severity).toBe(ErrorSeverity.HIGH);
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should report ERROR and MEDIUM severity on missing _meta", async () => {
        (axios.post as Mock).mockResolvedValue({ data: { data: {} } });
        const statusCheckResult = await manager.statusCheck();
        assert(statusCheckResult.isOk());
        const reports = statusCheckResult.value;
        expect(reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        expect(reports[0].attributes.severity).toBe(ErrorSeverity.MEDIUM);
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should throw when all queries fails", async () => {
        (axios.post as Mock).mockRejectedValue(new Error("fail"));
        const statusCheckResult = await manager.statusCheck();
        assert(statusCheckResult.isErr());
        expect(statusCheckResult.error).toMatchObject([
            {
                attributes: {
                    severity: ErrorSeverity.MEDIUM,
                },
                status: { code: SpanStatusCode.ERROR },
            },
        ]);
    });

    it("test getUpstreamEvents: should sync add and remove orders", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: {
                    data: {
                        transactions: [{}, {}, {}],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    data: {
                        transactions: [],
                    },
                },
            });
        const { status, result } = await manager.getUpstreamEvents();
        expect(status[subgraphUrl].status).toMatch("Fully fetched");
        expect(result[subgraphUrl].length).toBe(3);
        result[subgraphUrl].forEach((v) => {
            expect(v.__version).toBe(SubgraphVersions.LEGACY);
        });
        expect((axios.post as Mock).mock.calls[0][1].query).toContain("orderbook {");
        expect((axios.post as Mock).mock.calls[0][1].query).not.toContain("raindex");
    });

    it("test getUpstreamEvents: should query raindex entity and tag v6 for v6 subgraphs", async () => {
        const v6Url = "https://v6.example.com";
        const _manager = new SubgraphManager({
            subgraphs: [`v6=${v6Url}`],
            filters: undefined,
            requestTimeout: 1000,
        });
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: { data: { transactions: [{}] } },
            })
            .mockResolvedValueOnce({
                data: { data: { transactions: [] } },
            });
        const { status, result } = await _manager.getUpstreamEvents();
        expect(status[v6Url].status).toMatch("Fully fetched");
        expect(result[v6Url].length).toBe(1);
        expect(result[v6Url][0].__version).toBe(SubgraphVersions.V6);
        expect((axios.post as Mock).mock.calls[0][1].query).toContain("orderbook: raindex {");
        expect((axios.post as Mock).mock.calls[0][1].query).not.toContain("orderbook {");
    });

    it("test getUpstreamEvents: should handle errors and partial sync", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: {
                    data: {
                        transactions: [{}],
                    },
                },
            })
            .mockRejectedValueOnce("some error");

        const { status, result } = await manager.getUpstreamEvents();
        expect(status[subgraphUrl].status).toMatch("Partially fetched");
        expect(status[subgraphUrl].status).toMatch("some error");
        expect(result[subgraphUrl].length).toBe(1);
    });
});
