import { OrderManager } from ".";
import { Result } from "../common";
import { syncOrders } from "./sync";
import { PreAssembledSpan } from "../logger";
import { applyFilters } from "../subgraph/filter";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("../logger", () => ({
    PreAssembledSpan: vi.fn().mockImplementation((name) => ({
        name,
        setAttr: vi.fn(),
        end: vi.fn(),
    })),
}));

vi.mock("../subgraph/filter", () => ({
    applyFilters: vi.fn(),
}));

describe("Test syncOrders", () => {
    let mockOrderManager: OrderManager;
    let mockSubgraphManager: any;
    let mockUpdateVault: Mock;
    let mockAddOrder: Mock;
    let mockRemoveOrders: Mock;

    beforeEach(() => {
        vi.clearAllMocks();

        mockUpdateVault = vi.fn();
        mockAddOrder = vi.fn();
        mockRemoveOrders = vi.fn();

        mockSubgraphManager = {
            getUpstreamEvents: vi.fn(),
            filters: { someFilter: "test" },
        };

        mockOrderManager = {
            subgraphManager: mockSubgraphManager,
            updateVault: mockUpdateVault,
            addOrder: mockAddOrder,
            removeOrders: mockRemoveOrders,
        } as any;
    });

    it("should handle Deposit events correctly", async () => {
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "Deposit",
                            orderbook: { id: "0xorderbook1" },
                            vault: {
                                owner: "0xowner1",
                                token: {
                                    address: "0xtoken1",
                                    symbol: "TOKEN1",
                                    decimals: "18",
                                },
                                vaultId: "123",
                                balance: "1000000000000000000",
                            },
                        },
                    ],
                },
            ],
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: {},
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockUpdateVault).toHaveBeenCalledWith(
            "0xorderbook1",
            "0xowner1",
            {
                address: "0xtoken1",
                symbol: "TOKEN1",
                decimals: 18,
            },
            123n,
            1000000000000000000n,
        );
        expect(mockUpdateVault).toHaveBeenCalledTimes(1);
    });

    it("should handle Withdrawal events correctly", async () => {
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "Withdrawal",
                            orderbook: { id: "0xorderbook2" },
                            vault: {
                                owner: "0xowner2",
                                token: {
                                    address: "0xtoken2",
                                    symbol: "TOKEN2",
                                    decimals: "6",
                                },
                                vaultId: "456",
                                balance: "500000000",
                            },
                        },
                    ],
                },
            ],
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: {},
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockUpdateVault).toHaveBeenCalledWith(
            "0xorderbook2",
            "0xowner2",
            {
                address: "0xtoken2",
                symbol: "TOKEN2",
                decimals: 6,
            },
            456n,
            500000000n,
        );
        expect(mockUpdateVault).toHaveBeenCalledTimes(1);
    });

    it("should handle Clear events with trades correctly", async () => {
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "Clear",
                            trades: [
                                {
                                    inputVaultBalanceChange: {
                                        orderbook: { id: "0xorderbook1" },
                                        vault: {
                                            owner: "0xowner1",
                                            token: {
                                                address: "0xinputtoken",
                                                symbol: "INPUT",
                                                decimals: "18",
                                            },
                                            vaultId: "100",
                                            balance: "2000000000000000000",
                                        },
                                    },
                                    outputVaultBalanceChange: {
                                        orderbook: { id: "0xorderbook1" },
                                        vault: {
                                            owner: "0xowner2",
                                            token: {
                                                address: "0xoutputtoken",
                                                symbol: "OUTPUT",
                                                decimals: "6",
                                            },
                                            vaultId: "200",
                                            balance: "1000000000",
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: {},
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockUpdateVault).toHaveBeenCalledTimes(2);
        expect(mockUpdateVault).toHaveBeenNthCalledWith(
            1,
            "0xorderbook1",
            "0xowner1",
            {
                address: "0xinputtoken",
                symbol: "INPUT",
                decimals: 18,
            },
            100n,
            2000000000000000000n,
        );
        expect(mockUpdateVault).toHaveBeenNthCalledWith(
            2,
            "0xorderbook1",
            "0xowner2",
            {
                address: "0xoutputtoken",
                symbol: "OUTPUT",
                decimals: 6,
            },
            200n,
            1000000000n,
        );
    });

    it("should handle TakeOrder events with trades correctly", async () => {
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "TakeOrder",
                            trades: [
                                {
                                    inputVaultBalanceChange: {
                                        orderbook: { id: "0xorderbook3" },
                                        vault: {
                                            owner: "0xowner3",
                                            token: {
                                                address: "0xtoken3",
                                                symbol: "TOKEN3",
                                                decimals: "8",
                                            },
                                            vaultId: "789",
                                            balance: "50000000",
                                        },
                                    },
                                    outputVaultBalanceChange: {
                                        orderbook: { id: "0xorderbook3" },
                                        vault: {
                                            owner: "0xowner4",
                                            token: {
                                                address: "0xtoken4",
                                                symbol: "TOKEN4",
                                                decimals: "18",
                                            },
                                            vaultId: "101112",
                                            balance: "3000000000000000000",
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: {},
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockUpdateVault).toHaveBeenCalledTimes(2);
        expect(mockUpdateVault).toHaveBeenNthCalledWith(
            1,
            "0xorderbook3",
            "0xowner3",
            {
                address: "0xtoken3",
                symbol: "TOKEN3",
                decimals: 8,
            },
            789n,
            50000000n,
        );
        expect(mockUpdateVault).toHaveBeenNthCalledWith(
            2,
            "0xorderbook3",
            "0xowner4",
            {
                address: "0xtoken4",
                symbol: "TOKEN4",
                decimals: 18,
            },
            101112n,
            3000000000000000000n,
        );
    });

    it("should handle AddOrder events", async () => {
        const mockOrder = {
            orderHash: "0xorderhash1",
            orderbook: { id: "0xorderbook1" },
            active: true,
        };
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "AddOrder",
                            order: mockOrder,
                        },
                    ],
                },
            ],
        };
        const mockSyncStatus: any = {
            "https://subgraph1.com": {},
        };
        (applyFilters as Mock).mockReturnValue(true);
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: mockSyncStatus,
            result: mockResult,
        });
        mockAddOrder.mockResolvedValue(Result.ok(undefined));

        await syncOrders.call(mockOrderManager);
        expect(applyFilters).toHaveBeenCalledWith(mockOrder, mockSubgraphManager.filters);
        expect(mockAddOrder).toHaveBeenCalledWith(mockOrder);
        expect(mockSyncStatus["https://subgraph1.com"]["0xorderbook1"]).toEqual({
            added: ["0xorderhash1"],
            removed: [],
            failedAdds: {},
        });
    });

    it("should handle AddOrder events with failed addOrder and record error in syncStatus", async () => {
        const mockOrder = {
            orderHash: "0xorderhash1",
            orderbook: { id: "0xorderbook1" },
            active: true,
        };

        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "AddOrder",
                            order: mockOrder,
                        },
                    ],
                },
            ],
        };

        const mockSyncStatus: any = {
            "https://subgraph1.com": {},
        };
        const mockError = new Error("Failed to add order to database");

        (applyFilters as Mock).mockReturnValue(true);
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: mockSyncStatus,
            result: mockResult,
        });
        mockAddOrder.mockResolvedValue(Result.err(mockError));

        await syncOrders.call(mockOrderManager);

        expect(applyFilters).toHaveBeenCalledWith(mockOrder, mockSubgraphManager.filters);
        expect(mockAddOrder).toHaveBeenCalledWith(mockOrder);
        expect(mockSyncStatus["https://subgraph1.com"]["0xorderbook1"]).toEqual({
            added: [],
            removed: [],
            failedAdds: {
                "0xorderhash1": expect.stringContaining(mockError.message),
            },
        });
    });

    it("should handle RemoveOrder events correctly", async () => {
        const mockOrder = {
            orderHash: "0xorderhash4",
            orderbook: { id: "0xorderbook4" },
            active: false,
        };
        const mockResult = {
            "https://subgraph2.com": [
                {
                    timestamp: "1640995200",
                    events: [
                        {
                            __typename: "RemoveOrder",
                            order: mockOrder,
                        },
                    ],
                },
            ],
        };
        const mockSyncStatus: any = {
            "https://subgraph2.com": {},
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: mockSyncStatus,
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockRemoveOrders).toHaveBeenCalledWith([mockOrder]);
        expect(mockSyncStatus["https://subgraph2.com"]["0xorderbook4"]).toEqual({
            added: [],
            removed: ["0xorderhash4"],
        });
    });

    it("should skip transactions with no events", async () => {
        const mockResult = {
            "https://subgraph1.com": [
                {
                    timestamp: "1640995200",
                    events: [],
                },
                {
                    timestamp: "1640995300",
                    // events: undefined
                },
            ],
        };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: {},
            result: mockResult,
        });

        await syncOrders.call(mockOrderManager);
        expect(mockUpdateVault).not.toHaveBeenCalled();
        expect(mockAddOrder).not.toHaveBeenCalled();
        expect(mockRemoveOrders).not.toHaveBeenCalled();
    });

    it("should properly conclude report with syncStatus", async () => {
        const mockReport = {
            name: "",
            setAttr: vi.fn(),
            end: vi.fn(),
        };
        (PreAssembledSpan as Mock).mockReturnValue(mockReport);
        const mockSyncStatus = { "https://subgraph1.com": {} };
        mockSubgraphManager.getUpstreamEvents.mockResolvedValue({
            status: mockSyncStatus,
            result: {},
            failedAdds: {},
        });

        const result = await syncOrders.call(mockOrderManager);
        expect(mockReport.name).toBe("sync-orders");
        expect(mockReport.setAttr).toHaveBeenCalledWith(
            "syncStatus",
            JSON.stringify(mockSyncStatus),
        );
        expect(mockReport.end).toHaveBeenCalled();
        expect(result).toBe(mockReport);
    });
});
