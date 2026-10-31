import { NonceCache } from "./nonce";
import { RainSolverSigner } from "./index";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

describe("Test NonceCache", () => {
    let cache: NonceCache;
    let signer: RainSolverSigner;

    beforeEach(() => {
        cache = new NonceCache();
        signer = {
            account: { address: "0xAbC" },
            // the mined tx count
            getTransactionCount: vi.fn().mockResolvedValue(7),
        } as any as RainSolverSigner;
    });

    it("should have nothing cached for an unknown address", () => {
        expect(cache.get("0xabc")).toBeUndefined();
    });

    it("should set, get and invalidate the next nonce case insensitive", () => {
        cache.set("0xAbC", 3);
        expect(cache.get("0xabc")).toBe(3);
        expect(cache.get("0xABC")).toBe(3);

        cache.invalidate("0xABC");
        expect(cache.get("0xabc")).toBeUndefined();
    });

    it("should keep the nonces of different addresses apart", () => {
        cache.set("0xabc", 3);
        cache.set("0xdef", 9);
        cache.invalidate("0xabc");

        expect(cache.get("0xabc")).toBeUndefined();
        expect(cache.get("0xdef")).toBe(9);
    });

    describe("consume", () => {
        it("should take the cached nonce and move the cache up by one", async () => {
            cache.set("0xabc", 3);

            expect(await cache.consume(signer)).toBe(3);
            expect(cache.get("0xabc")).toBe(4);
            expect(await cache.consume(signer)).toBe(4);
            expect(cache.get("0xabc")).toBe(5);
            expect(signer.getTransactionCount).not.toHaveBeenCalled();
        });

        it("should take a cached zero nonce without fetching", async () => {
            cache.set("0xabc", 0);

            expect(await cache.consume(signer)).toBe(0);
            expect(cache.get("0xabc")).toBe(1);
            expect(signer.getTransactionCount).not.toHaveBeenCalled();
        });

        it("should fetch the mined tx count when the wallet has no cached nonce", async () => {
            expect(await cache.consume(signer)).toBe(7);
            expect(cache.get("0xabc")).toBe(8);
            expect(signer.getTransactionCount).toHaveBeenCalledTimes(1);
            expect(signer.getTransactionCount).toHaveBeenCalledWith({
                address: "0xAbC",
                blockTag: "latest",
            });
        });

        it("should give distinct nonces to concurrent sends of one wallet", async () => {
            cache.set("0xabc", 3);
            const nonces = await Promise.all([
                cache.consume(signer),
                cache.consume(signer),
                cache.consume(signer),
            ]);

            expect(nonces).toEqual([3, 4, 5]);
            expect(cache.get("0xabc")).toBe(6);
        });

        it("should share one fetch and give distinct nonces to concurrent misses", async () => {
            const nonces = await Promise.all([
                cache.consume(signer),
                cache.consume(signer),
                cache.consume(signer),
            ]);

            // one rpc call for the three of them, none of them reuses its number
            expect(signer.getTransactionCount).toHaveBeenCalledTimes(1);
            expect(nonces).toEqual([7, 8, 9]);
            expect(cache.get("0xabc")).toBe(10);
        });

        it("should keep a nonce set while the fetch is in flight", async () => {
            let resolveFetch!: (value: number) => void;
            (signer.getTransactionCount as Mock).mockImplementationOnce(
                () => new Promise<number>((resolve) => (resolveFetch = resolve)),
            );

            const consumed = cache.consume(signer);
            cache.set("0xabc", 20);
            resolveFetch(7);

            // the fetched count does not replace the nonce set meanwhile
            expect(await consumed).toBe(20);
            expect(cache.get("0xabc")).toBe(21);
        });

        it("should propagate a failed fetch and fetch again on the next consume", async () => {
            (signer.getTransactionCount as Mock).mockRejectedValueOnce(new Error("rpc down"));

            await expect(cache.consume(signer)).rejects.toThrow("rpc down");
            expect(cache.get("0xabc")).toBeUndefined();

            // the failed fetch is not left in flight
            expect(await cache.consume(signer)).toBe(7);
            expect(signer.getTransactionCount).toHaveBeenCalledTimes(2);
        });

        it("should fetch again when the cache is dropped right after the shared fetch wrote it", async () => {
            const fetched = Promise.resolve(7);
            (signer.getTransactionCount as Mock).mockReturnValueOnce(fetched);

            const reserved = cache.consume(signer);
            // an overlapping invalidate lands after the fetch wrote 7, before consume resumes
            fetched.then(() => cache.invalidate("0xabc"));

            // a read of the dropped entry would reserve NaN and store NaN as the next nonce
            expect(await reserved).toBe(7);
            expect(cache.get("0xabc")).toBe(8);
            expect(signer.getTransactionCount).toHaveBeenCalledTimes(2);
        });
    });

    describe("release", () => {
        it("should give the nonce back when no other send reserved after it", () => {
            cache.set("0xabc", 4);
            cache.release("0xAbC", 3);

            expect(cache.get("0xabc")).toBe(3);
        });

        it("should keep the reservation of a concurrent send", () => {
            // a concurrent send already took 4, so 3 cannot go back
            cache.set("0xabc", 5);
            cache.release("0xabc", 3);

            expect(cache.get("0xabc")).toBe(5);
        });

        it("should do nothing for a wallet with no cached nonce", () => {
            cache.release("0xabc", 3);

            expect(cache.get("0xabc")).toBeUndefined();
        });

        it("should let the next consume take the released nonce again", async () => {
            cache.set("0xabc", 3);
            const nonce = await cache.consume(signer);
            cache.release("0xabc", nonce);

            expect(await cache.consume(signer)).toBe(3);
            expect(cache.get("0xabc")).toBe(4);
        });
    });

    it("should fetch the mined tx count and cache it as the next nonce on sync", async () => {
        cache.set("0xabc", 3);
        const nonce = await cache.sync(signer);

        expect(nonce).toBe(7);
        expect(cache.get("0xabc")).toBe(7);
        expect(signer.getTransactionCount).toHaveBeenCalledTimes(1);
        expect(signer.getTransactionCount).toHaveBeenCalledWith({
            address: "0xAbC",
            blockTag: "latest",
        });
    });

    it("should propagate a failed fetch on sync and keep the cache as is", async () => {
        cache.set("0xabc", 3);
        (signer.getTransactionCount as Mock).mockRejectedValue(new Error("rpc down"));

        await expect(cache.sync(signer)).rejects.toThrow("rpc down");
        expect(cache.get("0xabc")).toBe(3);
    });

    it("should reset the cache to the mined tx count on refresh", async () => {
        cache.set("0xabc", 9);
        const result = await cache.refresh(signer);

        // the next send takes the nonce of the tx that did not mine
        expect(result).toBe(7);
        expect(cache.get("0xabc")).toBe(7);
        expect(signer.getTransactionCount).toHaveBeenCalledTimes(1);
        expect(signer.getTransactionCount).toHaveBeenCalledWith({
            address: "0xAbC",
            blockTag: "latest",
        });
    });

    it("should keep the sent txs of each address in flight until they settle", () => {
        expect(cache.inflightCount("0xabc")).toBe(0);
        cache.track("0xAbC", "0xH1");
        cache.track("0xabc", "0xh2");
        cache.track("0xdef", "0xh3");
        expect(cache.inflightCount("0xABC")).toBe(2);

        // the hashes and the addresses are matched case insensitive
        expect(cache.settle("0xabc", "0xh1")).toBe(1);
        expect(cache.settle("0xabc", "0xunknown")).toBe(1);
        expect(cache.settle("0xABC", "0xH2")).toBe(0);
        expect(cache.inflightCount("0xabc")).toBe(0);
        expect(cache.inflightCount("0xdef")).toBe(1);
        expect(cache.settle("0x123", "0xh4")).toBe(0);
    });

    it("should propagate a failed fetch on refresh and keep the cache as is", async () => {
        cache.set("0xabc", 3);
        (signer.getTransactionCount as Mock).mockRejectedValue(new Error("rpc down"));

        await expect(cache.refresh(signer)).rejects.toThrow("rpc down");
        expect(cache.get("0xabc")).toBe(3);
    });
});
