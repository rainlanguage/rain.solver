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
