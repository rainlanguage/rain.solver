import { type PublicClient } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { OwnerProfile, type OrderbooksOwnersProfileMap } from "./types";
import {
    fetchVaultBalances,
    downscaleProtection,
    buildOrderbookTokenOwnerVaultsMap,
} from "./protection";

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

describe("Test buildOrderbookTokenOwnerVaultsMap", () => {
    it("should correctly build the map structure", () => {
        const result = buildOrderbookTokenOwnerVaultsMap(mockOrderbooksOwnersProfileMap);

        // check if orderbook exists
        expect(result.has("orderbook1")).toBe(true);

        const tokenOwnersVaults = result.get("orderbook1");
        expect(tokenOwnersVaults?.has("0xtoken1")).toBe(true);

        const ownersVaults = tokenOwnersVaults?.get("0xtoken1");
        expect(ownersVaults?.has("owner1")).toBe(true);

        const vaults = ownersVaults?.get("owner1");
        expect(vaults).toEqual([{ vaultId: 1n, balance: 0n }]);
    });

    it("should handle empty input", () => {
        const emptyMap = new Map();
        const result = buildOrderbookTokenOwnerVaultsMap(emptyMap);
        expect(result.size).toBe(0);
    });
});

describe("Test downscaleProtection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should correctly downscale owner limits based on vault balances", async () => {
        (mockPublicClient.multicall as Mock).mockResolvedValue([100n]);
        (mockPublicClient.readContract as Mock).mockResolvedValue(1000n);

        const otovMap = buildOrderbookTokenOwnerVaultsMap(mockOrderbooksOwnersProfileMap);
        await downscaleProtection(mockOrderbooksOwnersProfileMap, otovMap, mockPublicClient);

        // get the updated owner profile and verify the limit was adjusted
        const ownerProfile = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1");
        expect(ownerProfile?.limit).toBe(3);
    });

    it("should not modify limits for owners with explicit limits", async () => {
        const ownerLimits = {
            owner1: 5,
        };
        const otovMap = buildOrderbookTokenOwnerVaultsMap(mockOrderbooksOwnersProfileMap);
        const originalLimit = mockOrderbooksOwnersProfileMap
            .get("orderbook1")
            ?.get("owner1")?.limit;
        await downscaleProtection(
            mockOrderbooksOwnersProfileMap,
            otovMap,
            mockPublicClient,
            ownerLimits,
        );

        const newLimit = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1")?.limit;
        expect(newLimit).toBe(originalLimit);
    });

    it("should handle empty balances", async () => {
        (mockPublicClient.multicall as Mock).mockResolvedValue([0n]);
        (mockPublicClient.readContract as Mock).mockResolvedValue(0n);

        const otovMap = buildOrderbookTokenOwnerVaultsMap(mockOrderbooksOwnersProfileMap);
        await downscaleProtection(mockOrderbooksOwnersProfileMap, otovMap, mockPublicClient);

        // ensure minimum limit of 1 is applied
        const ownerProfile = mockOrderbooksOwnersProfileMap.get("orderbook1")?.get("owner1");
        expect(ownerProfile?.limit).toBeGreaterThanOrEqual(1);
    });
});

describe("Test fetchVaultBalances", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should correctly fetch and update vault balances", async () => {
        const vaults = [
            { vaultId: 1n, balance: 0n },
            { vaultId: 2n, balance: 0n },
        ];
        (mockPublicClient.multicall as Mock).mockResolvedValue([100n, 200n]);
        await fetchVaultBalances("0xorderbook", "0xtoken", "0xowner", vaults, mockPublicClient);

        // verify the balances were updated
        expect(vaults[0].balance).toBe(100n);
        expect(vaults[1].balance).toBe(200n);
    });
});
