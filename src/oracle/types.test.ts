import { OracleHealthMap } from "./types";
import { describe, it, expect } from "vitest";

describe("Test OracleHealthMap namespace", () => {
    describe("key", () => {
        it("should build the key from the url and lowercased owner", () => {
            expect(OracleHealthMap.key("https://oracle.example.com", "0xAbCd")).toBe(
                "https://oracle.example.com-0xabcd",
            );
        });

        it("should build identical keys regardless of owner casing", () => {
            expect(OracleHealthMap.key("https://oracle.example.com", "0xABCD")).toBe(
                OracleHealthMap.key("https://oracle.example.com", "0xabcd"),
            );
        });
    });

    describe("getOrCreate", () => {
        it("should create and store a fresh state when none exists", () => {
            const map: OracleHealthMap = new Map();
            const state = OracleHealthMap.getOrCreate(map, "https://oracle.example.com", "0xAbCd");

            expect(state).toEqual({ consecutiveFailures: 0, cooloffUntil: 0 });
            expect(map.get("https://oracle.example.com-0xabcd")).toBe(state);
            expect(map.size).toBe(1);
        });

        it("should return the existing state without replacing it", () => {
            const map: OracleHealthMap = new Map();
            const existing = {
                consecutiveFailures: 3,
                cooloffUntil: 123,
                cache: new Map([["0xhash-0-0", { blockNumber: 1n, result: {} as any }]]),
            };
            map.set("https://oracle.example.com-0xabcd", existing);

            const state = OracleHealthMap.getOrCreate(map, "https://oracle.example.com", "0xAbCd");

            expect(state).toBe(existing);
            expect(state.cache?.size).toBe(1);
            expect(map.size).toBe(1);
        });
    });
});
