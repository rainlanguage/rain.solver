import axios from "axios";
import { SgOrder } from "./types";
import { ErrorSeverity } from "../error";
import { SpanStatusCode } from "@opentelemetry/api";
import { SubgraphManager } from "./index";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

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
    const mockRemoveOrder = {
        id: "3",
        orderHash: "0xdef",
        active: false,
        orderbook: { id: "0xob2" },
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

        const orders = await manager.fetchSubgraphOrders(subgraphUrl);
        expect(orders).toEqual([mockOrder]);
        expect(manager.syncState[subgraphUrl].lastFetchTimestamp).toBeGreaterThan(0);
    });

    it("test fetchSubgraphOrders: should throw on invalid response", async () => {
        (axios.post as Mock).mockResolvedValueOnce({ data: { data: {} } });
        await expect(manager.fetchSubgraphOrders(subgraphUrl)).rejects.toBe(
            "Received invalid response",
        );
    });

    it("test fetchAll: should fetch all orders and report", async () => {
        vi.spyOn(manager, "fetchSubgraphOrders").mockResolvedValue([mockOrder]);
        const { orders, report } = await manager.fetchAll();
        expect(orders).toEqual([mockOrder]);
        expect(report.name).toBe("fetch-orders");
        expect(report.attributes[`fetchStatus.${subgraphUrl}`]).toBe("Fully fetched");
        expect(report.endTime).toBeGreaterThan(0);
    });

    it("test fetchAll: should throw if all fetches fail", async () => {
        vi.spyOn(manager, "fetchSubgraphOrders").mockRejectedValue("fail");
        await expect(manager.fetchAll()).rejects.toMatchObject({
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
    });

    it("test statusCheck: should report OK when no indexing errors", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: { _meta: { hasIndexingErrors: false, block: { number: 1 } } } },
        });
        const reports = await manager.statusCheck();
        expect(reports[0].status).toEqual({ code: SpanStatusCode.OK });
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should report ERROR and HIGH severity on indexing errors", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: { _meta: { hasIndexingErrors: true, block: { number: 1 } } } },
        });
        const reports = await manager.statusCheck();
        expect(reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        expect(reports[0].attributes.severity).toBe(ErrorSeverity.HIGH);
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should report ERROR and MEDIUM severity on missing _meta", async () => {
        (axios.post as Mock).mockResolvedValue({ data: { data: {} } });
        const reports = await manager.statusCheck();
        expect(reports[0].status?.code).toBe(SpanStatusCode.ERROR);
        expect(reports[0].attributes.severity).toBe(ErrorSeverity.MEDIUM);
        expect(reports[0].endTime).toBeGreaterThan(0);
    });

    it("test statusCheck: should throw when all queries fails", async () => {
        (axios.post as Mock).mockRejectedValue(new Error("fail"));
        await expect(manager.statusCheck()).rejects.toMatchObject([
            {
                attributes: {
                    severity: ErrorSeverity.MEDIUM,
                },
                status: { code: SpanStatusCode.ERROR },
            },
        ]);
    });

    it("test syncOrders: should sync add and remove orders", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: {
                    data: {
                        transactions: [
                            {
                                timestamp: 123,
                                events: [
                                    { __typename: "AddOrder", order: mockOrder },
                                    { __typename: "RemoveOrder", order: mockRemoveOrder },
                                ],
                            },
                        ],
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
        const { report, result } = await manager.syncOrders();
        const reportStatus = JSON.parse(report.attributes.syncStatus as string)[subgraphUrl];
        expect(report.name).toBe("sync-orders");
        expect(reportStatus.status).toMatch("Fully synced");
        expect(reportStatus[mockOrder.orderbook.id].added.length).toBe(1);
        expect(reportStatus[mockRemoveOrder.orderbook.id].removed.length).toBe(1);
        expect(report.endTime).toBeGreaterThan(0);
        expect(result[subgraphUrl].addOrders.length).toBe(1);
        expect(result[subgraphUrl].removeOrders.length).toBe(1);
    });

    it("test syncOrders: should handle errors and partial sync", async () => {
        (axios.post as Mock)
            .mockResolvedValueOnce({
                data: {
                    data: {
                        transactions: [
                            {
                                timestamp: 123,
                                events: [{ __typename: "AddOrder", order: mockOrder }],
                            },
                        ],
                    },
                },
            })
            .mockRejectedValueOnce("some error");

        const { report, result } = await manager.syncOrders();
        const reportStatus = JSON.parse(report.attributes.syncStatus as string)[subgraphUrl];
        expect(report.name).toBe("sync-orders");
        expect(reportStatus.status).toMatch("Partially synced");
        expect(reportStatus.status).toMatch("some error");
        expect(reportStatus[mockOrder.orderbook.id].added.length).toBe(1);
        expect(reportStatus[mockOrder.orderbook.id].removed).toBeUndefined();
        expect(report.endTime).toBeGreaterThan(0);
        expect(result[subgraphUrl].addOrders.length).toBe(1);
    });
});
