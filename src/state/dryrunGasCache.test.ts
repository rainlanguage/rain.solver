import { DryrunGasCache } from "./dryrunGasCache";
import { describe, it, expect, vi, afterEach } from "vitest";

describe("Test DryrunGasCache", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("should build the key from the pair orderbook, order id and tokens", () => {
        const pair = {
            orderbook: "0xOrderBook",
            takeOrder: { id: "0xOrderId" },
            sellToken: "0xSell",
            buyToken: "0xBuy",
        } as any;
        expect(DryrunGasCache.key(pair)).toBe("0xorderbook-0xorderid-0xsell-0xbuy");
    });

    it("should return undefined until the minimum init samples are in", () => {
        const cache = new DryrunGasCache(0);
        for (let i = 0; i < DryrunGasCache.MIN_INIT_SAMPLES - 1; i++) {
            cache.recordInit("key", 100n, 10n);
            expect(cache.get("key")).toBeUndefined();
        }
        // final samples dont count towards the init minimum
        cache.recordFinal("key", 100n, 10n);
        expect(cache.get("key")).toBeUndefined();

        cache.recordInit("key", 100n, 10n);
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });
        expect(cache.get("other")).toBeUndefined();
    });

    it("should average init and final samples and cap the init samples", () => {
        const cache = new DryrunGasCache(0);
        for (let i = 0; i < DryrunGasCache.MIN_INIT_SAMPLES; i++) {
            cache.recordInit("key", 100n, 10n);
        }
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });

        // extra init samples are ignored
        cache.recordInit("key", 1000n, 100n);
        expect(cache.entries.get("key")!.initCount).toBe(DryrunGasCache.MIN_INIT_SAMPLES);
        expect(cache.entries.get("key")!.count).toBe(DryrunGasCache.MIN_INIT_SAMPLES);
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });

        // final samples keep moving the average
        cache.recordFinal("key", 700n, 70n);
        expect(cache.entries.get("key")!.count).toBe(DryrunGasCache.MIN_INIT_SAMPLES + 1);
        expect(cache.get("key")).toEqual({ gas: 200n, l1Cost: 20n });
    });

    it("should reset all entries after the reset interval", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new DryrunGasCache(60_000);
        for (let i = 0; i < DryrunGasCache.MIN_INIT_SAMPLES; i++) {
            cache.recordInit("key", 100n, 10n);
        }
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });

        vi.setSystemTime(1_000_000 + 59_999);
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });

        vi.setSystemTime(1_000_000 + 60_000);
        expect(cache.get("key")).toBeUndefined();
        expect(cache.entries.size).toBe(0);
        expect(cache.lastReset).toBe(1_000_000 + 60_000);

        // recording after the reset starts over
        cache.recordFinal("key", 100n, 10n);
        expect(cache.entries.get("key")).toEqual({
            gasSum: 100n,
            l1CostSum: 10n,
            count: 1,
            initCount: 0,
        });
    });

    it("should never reset when the reset interval is not greater than 0", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new DryrunGasCache(0);
        for (let i = 0; i < DryrunGasCache.MIN_INIT_SAMPLES; i++) {
            cache.recordInit("key", 100n, 10n);
        }
        vi.setSystemTime(1_000_000 + 100 * 60_000);
        expect(cache.get("key")).toEqual({ gas: 100n, l1Cost: 10n });
    });

    it("should clear entries and stamp the reset time", () => {
        vi.useFakeTimers();
        vi.setSystemTime(5_000);
        const cache = new DryrunGasCache(0);
        cache.recordFinal("key", 100n, 10n);
        vi.setSystemTime(9_000);
        cache.clear();
        expect(cache.entries.size).toBe(0);
        expect(cache.lastReset).toBe(9_000);
    });
});
