import { OracleConstants, OracleMarketHours } from "./types";
import { describe, it, expect, vi } from "vitest";

describe("Test OracleConstants.isKnown", () => {
    it("should accept the known urls", () => {
        for (const url of OracleConstants.KnownUrls) {
            expect(OracleConstants.isKnown(url)).toBe(true);
            expect(OracleConstants.isKnown(`${url}?chain=1`)).toBe(true);
        }
    });

    it("should accept any https subdomain of a known domain", () => {
        for (const url of [
            "https://t0trade.com/context",
            "https://oracle.t0trade.com/context",
            "https://oracle-base.t0trade.com/context",
            "https://a.b.c.t0trade.com/some/path?x=1",
            "https://T0TRADE.com/context",
        ]) {
            expect(OracleConstants.isKnown(url)).toBe(true);
        }
    });

    it("should reject lookalike hosts, other domains and non https urls", () => {
        for (const url of [
            "https://t0trade.com.evil.com/context",
            "https://evil-t0trade.com/context",
            "https://evil.com/oracle.t0trade.com/context",
            "https://evil.com/?u=https://oracle.t0trade.com/context",
            "http://oracle.t0trade.com/context",
            "https://example.com/context",
            "not a url",
            "",
        ]) {
            expect(OracleConstants.isKnown(url)).toBe(false);
        }
    });
});

describe("Test OracleMarketHours.isOpen", () => {
    // 2026-10-05 is a monday, so 2026-10-09 is a friday, 2026-10-10 a saturday and 2026-10-11 a sunday
    const at = (iso: string) => new Date(iso).getTime();
    const hours = OracleMarketHours.DEFAULT;

    it("should have 08:00-23:59 as the default market hours", () => {
        expect(OracleMarketHours.DEFAULT).toEqual({ open: 480, close: 1439 });
    });

    it("should be open on weekdays inside the market hours", () => {
        for (const day of ["05", "06", "07", "08", "09"]) {
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T08:00:00Z`))).toBe(true);
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T15:30:00Z`))).toBe(true);
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T23:59:59.999Z`))).toBe(true);
        }
    });

    it("should be closed on weekdays out of the market hours", () => {
        for (const day of ["05", "06", "07", "08", "09"]) {
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T00:00:00Z`))).toBe(false);
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T03:00:00Z`))).toBe(false);
            expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T07:59:59.999Z`))).toBe(false);
        }
    });

    it("should be closed all day on weekends", () => {
        for (const day of ["10", "11"]) {
            for (const time of ["00:00:00", "08:00:00", "12:00:00", "23:59:59.999"]) {
                expect(OracleMarketHours.isOpen(hours, at(`2026-10-${day}T${time}Z`))).toBe(false);
            }
        }
        // even with the whole day as the market hours, 00:00-23:59
        const allDay = { open: 0, close: 1439 };
        expect(OracleMarketHours.isOpen(allDay, at("2026-10-10T12:00:00Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(allDay, at("2026-10-11T12:00:00Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(allDay, at("2026-10-12T00:00:00Z"))).toBe(true);
    });

    it("should be closed from friday close until monday open", () => {
        expect(OracleMarketHours.isOpen(hours, at("2026-10-09T23:59:59.999Z"))).toBe(true);
        expect(OracleMarketHours.isOpen(hours, at("2026-10-10T00:00:00Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(hours, at("2026-10-12T00:00:00Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(hours, at("2026-10-12T07:59:59.999Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(hours, at("2026-10-12T08:00:00Z"))).toBe(true);
    });

    it("should respect custom market hours as the current day times with inclusive close", () => {
        // 08:30-20:15
        const custom = { open: 8 * 60 + 30, close: 20 * 60 + 15 };
        expect(OracleMarketHours.isOpen(custom, at("2026-10-06T08:29:59.999Z"))).toBe(false);
        expect(OracleMarketHours.isOpen(custom, at("2026-10-06T08:30:00Z"))).toBe(true);
        expect(OracleMarketHours.isOpen(custom, at("2026-10-06T20:15:00Z"))).toBe(true);
        expect(OracleMarketHours.isOpen(custom, at("2026-10-06T20:15:59.999Z"))).toBe(true);
        expect(OracleMarketHours.isOpen(custom, at("2026-10-06T20:16:00Z"))).toBe(false);
    });

    it("should check against now when no time is given", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
            expect(OracleMarketHours.isOpen(hours)).toBe(true);
            vi.setSystemTime(new Date("2026-10-06T06:00:00Z"));
            expect(OracleMarketHours.isOpen(hours)).toBe(false);
            vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
            expect(OracleMarketHours.isOpen(hours)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
