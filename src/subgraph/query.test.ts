import { describe, it, expect } from "vitest";
import { getQueryPaginated, getTxsQuery, DEFAULT_PAGE_SIZE } from "./query";

describe("Test getQueryPaginated", () => {
    it("should generate query with no filters", () => {
        const query = getQueryPaginated(0);
        expect(query).toContain(`first: ${DEFAULT_PAGE_SIZE}`);
        expect(query).toContain("skip: 0");
        expect(query).toContain("active: true");
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

describe("Test getTxsQuery", () => {
    it("should generate a transaction query with correct skip and timestamp", () => {
        const query = getTxsQuery(123456, 20);
        expect(query).toContain('timestamp_gt: "123456"');
        expect(query).toContain("skip: 20");
        expect(query).toContain(`first: ${DEFAULT_PAGE_SIZE}`);
    });
});
