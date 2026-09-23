import { SubgraphVersions } from "./types";
import { describe, it, expect } from "vitest";
import {
    getTxsQuery,
    DEFAULT_PAGE_SIZE,
    getQueryPaginated,
    getOrderbooksQuery,
    getOrderbookEntityName,
} from "./query";

describe("Test getOrderbookEntityName", () => {
    it("should return orderbook for legacy and raindex for v6", () => {
        expect(getOrderbookEntityName(SubgraphVersions.LEGACY)).toBe("orderbook");
        expect(getOrderbookEntityName(SubgraphVersions.V6)).toBe("raindex");
    });
});

describe("Test getQueryPaginated", () => {
    it("should generate query with no filters", () => {
        const query = getQueryPaginated(0);
        expect(query).toContain(`first: ${DEFAULT_PAGE_SIZE}`);
        expect(query).toContain("skip: 0");
        expect(query).toContain("active: true");
        expect(query).toContain("orderbook {");
        expect(query).not.toContain("raindex");
    });

    it("should use raindex entity aliased as orderbook for v6", () => {
        const filters = {
            includeOrderbooks: new Set(["0xbook"]),
            excludeOrderbooks: new Set(["0xnotbook"]),
        };
        const query = getQueryPaginated(0, filters, SubgraphVersions.V6);
        expect(query).toContain("orderbook: raindex {");
        expect(query).not.toContain("orderbook {");
        expect(query).toContain('raindex_in: ["0xbook"]');
        expect(query).toContain('raindex_not_in: ["0xnotbook"]');
        expect(query).not.toContain("orderbook_in");
        expect(query).not.toContain("orderbook_not_in");
    });

    it("should generate query with include/exclude filters", () => {
        const filters = {
            includeOwners: new Set(["0xowner"]),
            excludeOwners: new Set(["0xnotowner"]),
            includeOrders: new Set(["0xorder"]),
            excludeOrders: new Set(["0xnotorder"]),
            includeOrderbooks: new Set(["0xbook"]),
            excludeOrderbooks: new Set(["0xnotbook"]),
        };
        const query = getQueryPaginated(10, filters);
        expect(query).toContain('owner_in: ["0xowner"]');
        expect(query).toContain('owner_not_in: ["0xnotowner"]');
        expect(query).toContain('orderHash_in: ["0xorder"]');
        expect(query).toContain('orderHash_not_in: ["0xnotorder"]');
        expect(query).toContain('orderbook_in: ["0xbook"]');
        expect(query).toContain('orderbook_not_in: ["0xnotbook"]');
        expect(query).toContain("skip: 10");
    });
});

describe("Test getOrderbooksQuery", () => {
    it("should query orderbooks for legacy", () => {
        const query = getOrderbooksQuery();
        expect(query).toContain("orderbooks {");
        expect(query).not.toContain("raindices");
    });

    it("should query raindices aliased as orderbooks for v6", () => {
        const query = getOrderbooksQuery(SubgraphVersions.V6);
        expect(query).toContain("orderbooks: raindices {");
    });
});

describe("Test getTxsQuery", () => {
    it("should generate a transaction query with correct skip and timestamp", () => {
        const query = getTxsQuery(123456, 20);
        expect(query).toContain('timestamp_gt: "123456"');
        expect(query).toContain("skip: 20");
        expect(query).toContain(`first: ${DEFAULT_PAGE_SIZE}`);
        expect(query).toContain("orderbook {");
        expect(query).not.toContain("raindex");
    });

    it("should use raindex entity aliased as orderbook for v6", () => {
        const query = getTxsQuery(123456, 20, 654321, SubgraphVersions.V6);
        expect(query).toContain('timestamp_lte: "654321"');
        expect(query).toContain("orderbook: raindex {");
        expect(query).not.toContain("orderbook {");
        // one for each of AddOrder, RemoveOrder, Deposit, Withdrawal and
        // the two vault balance changes of TradeEvent
        expect(query.match(/orderbook: raindex \{/g)?.length).toBe(6);
    });
});
