import { PublicClient } from "viem";
import { downscaleProtection } from "./protection";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { OwnerProfile, OrderbooksOwnersProfileMap, OrderbookOwnerTokenVaultsMap } from "./types";

// mock data
const orderProfile = {
    takeOrders: [
        {
            sellToken: "0xToken1",
            takeOrder: {
                takeOrder: {
                    order: {
                        validOutputs: [
                            {
                                vaultId: 1n,
                            },
                        ],
                    },
                    outputIOIndex: 0,
                },
            },
        },
    ],
};
const ownerProfile = {
    orders: new Map([["order1", orderProfile]]),
    limit: 10,
} as any as OwnerProfile;
const mockOrderbooksOwnersProfileMap: OrderbooksOwnersProfileMap = new Map([
    ["orderbook1", new Map([["owner1", ownerProfile]])],
]);

// mock PublicClient
const mockPublicClient = {
    multicall: vi.fn(),
    readContract: vi.fn(),
    chain: { id: 1 },
} as any as PublicClient;

describe("Test downscaleProtection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should correctly downscale owner limits based on vault balances", async () => {
        (mockPublicClient.multicall as Mock).mockResolvedValue([100n]);
        (mockPublicClient.readContract as Mock).mockResolvedValue(1000n);
        const ownerTokenVaultsMap: OrderbookOwnerTokenVaultsMap = new Map([
            [
                "orderbook1",
                new Map([
                    ["owner1", new Map([["0xToken1", new Map([[1n, { id: 1n, balance: 100n }]])]])],
                ]),
            ],
        ]) as any;

        await downscaleProtection(
            mockOrderbooksOwnersProfileMap,
            ownerTokenVaultsMap,
            mockPublicClient,
        );

        // get the updated owner profile and verify the limit was adjusted
        const ownerProfile = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1");
        expect(ownerProfile?.limit).toBe(3);
    });

    it("should not modify limits for owners with explicit limits", async () => {
        const ownerLimits = {
            owner1: 5,
        };
        const ownerTokenVaultsMap: OrderbookOwnerTokenVaultsMap = new Map([
            [
                "orderbook1",
                new Map([
                    ["owner1", new Map([["0xToken1", new Map([[1n, { id: 1n, balance: 100n }]])]])],
                ]),
            ],
        ]) as any;
        const originalLimit = mockOrderbooksOwnersProfileMap
            .get("orderbook1")
            ?.get("owner1")?.limit;
        await downscaleProtection(
            mockOrderbooksOwnersProfileMap,
            ownerTokenVaultsMap,
            mockPublicClient,
            ownerLimits,
        );

        const newLimit = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1")?.limit;
        expect(newLimit).toBe(originalLimit);
    });

    it("should handle empty balances", async () => {
        (mockPublicClient.multicall as Mock).mockResolvedValue([0n]);
        (mockPublicClient.readContract as Mock).mockResolvedValue(0n);
        const ownerTokenVaultsMap: OrderbookOwnerTokenVaultsMap = new Map([
            [
                "orderbook1",
                new Map([
                    ["owner1", new Map([["0xToken1", new Map([[1n, { id: 1n, balance: 100n }]])]])],
                ]),
            ],
        ]) as any;

        await downscaleProtection(
            mockOrderbooksOwnersProfileMap,
            ownerTokenVaultsMap,
            mockPublicClient,
        );

        // ensure minimum limit of 1 is applied
        const ownerProfile = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1");
        expect(ownerProfile?.limit).toBeGreaterThanOrEqual(1);
    });
});

/**
 * Discriminating tests that pin the exact arithmetic of the limit-divide
 * calculation in downscaleProtection: the per-owner-per-token ratio percent,
 * the 4-segment divide factor, the cuts averaging across tokens, the per-vault
 * balance averaging, and the final `max(round(limit/avgCut), 1)`.
 *
 * Each test builds fresh maps, so each runs against its own isolated `limit`.
 */
describe("Test downscaleProtection limit-divide arithmetic", () => {
    // builds a fresh owners-profile map with a single owner whose limit is `limit`
    function makeOwnersProfileMap(limit: number): OrderbooksOwnersProfileMap {
        const ownerProfile = { orders: new Map(), limit } as any as OwnerProfile;
        return new Map([["orderbook1", new Map([["owner1", ownerProfile]])]]);
    }

    // builds a vaults map for owner1 with the given token -> balances entries
    function makeVaultsMap(tokenBalances: Record<string, bigint[]>): OrderbookOwnerTokenVaultsMap {
        const tokenVaultMap = new Map(
            Object.entries(tokenBalances).map(([token, balances]) => [
                token,
                new Map(balances.map((balance, i) => [BigInt(i), { id: BigInt(i), balance }])),
            ]),
        );
        return new Map([["orderbook1", new Map([["owner1", tokenVaultMap]])]]) as any;
    }

    // mock readContract resolving the orderbook token balance keyed by token address
    function mockObBalances(balances: Record<string, bigint>) {
        (mockPublicClient.readContract as Mock).mockImplementation(
            async (params: any) => balances[params.address],
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ratio percent => segment => divide factor, exercising every segment:
    //   [0,25)->4   [25,50)->3   [50,75)->2   [75,100)->1   >=100->1
    // single vault so avgBalance == ownerTotalBalance, single token so
    // avgCut == that single factor, initial limit chosen so round() is exact.
    it.each([
        // ownerBal, obBal, otherOwners, pct, factor, initialLimit, expected
        { ownerBal: 100n, obBal: 1000n, pct: 11n, factor: 4, limit: 12, expected: 3 }, // round(3)
        { ownerBal: 300n, obBal: 1300n, pct: 30n, factor: 3, limit: 12, expected: 4 }, // round(4)
        { ownerBal: 600n, obBal: 1600n, pct: 60n, factor: 2, limit: 12, expected: 6 }, // round(6)
        { ownerBal: 800n, obBal: 1800n, pct: 80n, factor: 1, limit: 12, expected: 12 }, // round(12)
        { ownerBal: 2000n, obBal: 3000n, pct: 200n, factor: 1, limit: 7, expected: 7 }, // >=100 -> 1
    ])(
        "computes divide factor $factor at ratio ~$pct% (limit $limit -> $expected)",
        async ({ ownerBal, obBal, limit, expected }) => {
            const ownersProfileMap = makeOwnersProfileMap(limit);
            const vaults = makeVaultsMap({ "0xToken1": [ownerBal] });
            mockObBalances({ "0xToken1": obBal });

            await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

            expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(expected);
        },
    );

    // otherOwnersBalances === 0n short-circuits ratio percent to 100n -> factor 1,
    // so the limit is left unchanged (round(limit/1) === limit). ownerTotal == obBal.
    it("treats ratio as 100% (factor 1, unchanged limit) when no other-owner balance", async () => {
        const ownersProfileMap = makeOwnersProfileMap(9);
        const vaults = makeVaultsMap({ "0xToken1": [500n] });
        mockObBalances({ "0xToken1": 500n }); // otherOwnersBalances = 500 - 500 = 0

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(9);
    });

    // averages vault balances: two vaults [200n, 400n] -> total 600, avg 300.
    // ob = 1200 => otherOwners = 1200 - 600 = 600 => pct = (300*100)/600 = 50 => factor 2.
    it("averages multiple vault balances (total/count) before computing the ratio", async () => {
        const ownersProfileMap = makeOwnersProfileMap(8);
        const vaults = makeVaultsMap({ "0xToken1": [200n, 400n] });
        mockObBalances({ "0xToken1": 1200n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        // factor 2 => round(8/2) = 4
        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(4);
    });

    // averages the per-token divide factors:
    //   token1: ownerBal 100, ob 1000 => pct 11 => factor 4
    //   token2: ownerBal 800, ob 1800 => pct 80 => factor 1
    //   avgCut = (4 + 1) / 2 = 2.5 => round(10 / 2.5) = 4
    it("averages divide factors across an owner's tokens", async () => {
        const ownersProfileMap = makeOwnersProfileMap(10);
        const vaults = makeVaultsMap({
            "0xToken1": [100n],
            "0xToken2": [800n],
        });
        mockObBalances({ "0xToken1": 1000n, "0xToken2": 1800n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(4);
    });

    // enforces the minimum limit of 1: limit 1 / factor 4 = 0.25 => round = 0 => max(0,1) = 1.
    it("clamps the reduced limit to a minimum of 1", async () => {
        const ownersProfileMap = makeOwnersProfileMap(1);
        const vaults = makeVaultsMap({ "0xToken1": [100n] }); // factor 4
        mockObBalances({ "0xToken1": 1000n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(1);
    });

    // rounds the reduced limit to the nearest integer: limit 10 / factor 4 = 2.5 => round = 3.
    it("rounds the reduced limit to the nearest integer", async () => {
        const ownersProfileMap = makeOwnersProfileMap(10);
        const vaults = makeVaultsMap({ "0xToken1": [100n] }); // factor 4
        mockObBalances({ "0xToken1": 1000n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(3);
    });

    // owners whose limit is admin-configured (case-insensitive key) are skipped
    // entirely: no readContract, limit untouched even with a low-balance vault.
    it("skips owners with an admin-configured limit (case-insensitive)", async () => {
        const ownersProfileMap = makeOwnersProfileMap(25);
        const vaults = makeVaultsMap({ "0xToken1": [100n] });
        mockObBalances({ "0xToken1": 1000n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient, { owner1: 5 });

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(25);
        expect(mockPublicClient.readContract as Mock).not.toHaveBeenCalled();
    });

    // when the orderbook token balance read fails (undefined), that token is
    // skipped so it contributes no cut; with only that token the limit is unchanged.
    it("skips a token whose orderbook balance read fails", async () => {
        const ownersProfileMap = makeOwnersProfileMap(13);
        const vaults = makeVaultsMap({ "0xToken1": [100n] });
        (mockPublicClient.readContract as Mock).mockRejectedValue(new Error("rpc down"));

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(ownersProfileMap.get("orderbook1")?.get("owner1")?.limit).toBe(13);
    });

    // caches the orderbook token balance per (orderbook, token): two vaults of the
    // same token trigger only a single readContract call.
    it("reads each (orderbook, token) balance only once", async () => {
        const ownersProfileMap = makeOwnersProfileMap(10);
        const vaults = makeVaultsMap({ "0xToken1": [200n, 400n] });
        mockObBalances({ "0xToken1": 1200n });

        await downscaleProtection(ownersProfileMap, vaults, mockPublicClient);

        expect(mockPublicClient.readContract as Mock).toHaveBeenCalledTimes(1);
    });
});
