import { OracleConstants } from "./types";
import { describe, it, expect } from "vitest";

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
