import { SgOrder } from "./types";
import { describe, it, expect } from "vitest";
import { applyFilters, SgFilter } from "./filter";

describe("Test applyFilters", () => {
    const order = {
        orderHash: "0xorder",
        owner: "0xowner",
        orderbook: { id: "0xorderbook" },
    } as any as SgOrder;

    it("should return true if no filters provided", () => {
        expect(applyFilters(order)).toBe(true);
    });

    it("should return false if not in includeOrderbooks", () => {
        const filters: SgFilter = { includeOrderbooks: new Set(["other"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return false if not in includeOrders", () => {
        const filters: SgFilter = { includeOrders: new Set(["otherorder"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return false if not in includeOwners", () => {
        const filters: SgFilter = { includeOwners: new Set(["otherowner"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return false if in excludeOrderbooks", () => {
        const filters: SgFilter = { excludeOrderbooks: new Set(["0xorderbook"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return false if in excludeOrders", () => {
        const filters: SgFilter = { excludeOrders: new Set(["0xorder"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return false if in excludeOwners", () => {
        const filters: SgFilter = { excludeOwners: new Set(["0xowner"]) };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should return true if passes all filters", () => {
        const filters: SgFilter = {
            includeOrderbooks: new Set(["0xorderbook"]),
            includeOrders: new Set(["0xorder"]),
            includeOwners: new Set(["0xowner"]),
        };
        expect(applyFilters(order, filters)).toBe(true);
    });

    it("exclude filters take precedence over include filters", () => {
        const filters: SgFilter = {
            includeOrderbooks: new Set(["0xorderbook"]),
            excludeOrderbooks: new Set(["0xorderbook"]),
        };
        expect(applyFilters(order, filters)).toBe(false);
    });

    it("should correctly apply filters with all fields present", async function () {
        const filters = {
            includeOrders: new Set([`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`]),
            excludeOrders: new Set([`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`]),
            includeOwners: new Set([`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`]),
            excludeOwners: new Set([`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`]),
            includeOrderbooks: new Set([`0x${"5".repeat(40)}`, `0x${"6".repeat(40)}`]),
            excludeOrderbooks: new Set([`0x${"7".repeat(40)}`, `0x${"8".repeat(40)}`]),
        };
        let order = {
            orderHash: `0x${"1".repeat(64)}`,
            owner: `0x${"1".repeat(40)}`,
            orderbook: {
                id: `0x${"7".repeat(40)}`,
            },
        } as any;
        expect(applyFilters(order, filters)).toBe(false);

        order = {
            orderHash: `0x${"1".repeat(64)}`,
            owner: `0x${"3".repeat(40)}`,
            orderbook: {
                id: `0x${"6".repeat(40)}`,
            },
        };
        expect(applyFilters(order, filters)).toBe(false);

        order = {
            orderHash: `0x${"3".repeat(64)}`,
            owner: `0x${"2".repeat(40)}`,
            orderbook: {
                id: `0x${"5".repeat(40)}`,
            },
        };
        expect(applyFilters(order, filters)).toBe(false);

        order = {
            orderHash: `0x${"1".repeat(64)}`,
            owner: `0x${"2".repeat(40)}`,
            orderbook: {
                id: `0x${"5".repeat(40)}`,
            },
        };
        expect(applyFilters(order, filters)).toBe(true);

        order = {
            orderHash: `0x${"7".repeat(64)}`,
            owner: `0x${"7".repeat(40)}`,
            orderbook: {
                id: `0x${"2".repeat(40)}`,
            },
        };
        expect(applyFilters(order, filters)).toBe(false);
    });
});
