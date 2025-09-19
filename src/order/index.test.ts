import { SharedState } from "../state";
import { SubgraphManager } from "../subgraph";
import { OrderManager, DEFAULT_OWNER_LIMIT } from "./index";
import { describe, it, expect, beforeEach, vi, Mock } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    erc20Abi: [],
    encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
    decodeFunctionResult: vi.fn().mockReturnValue([null, 100n, 2n]),
}));

vi.mock("../subgraph", () => ({
    SubgraphManager: vi.fn().mockImplementation(() => ({
        fetchAll: vi.fn().mockResolvedValue({ orders: [], report: { status: "ok" } }),
        syncOrders: vi.fn().mockResolvedValue({ result: {}, report: { status: "ok" } }),
    })),
}));

vi.mock("../state", () => ({
    SharedState: vi.fn().mockImplementation(() => ({
        watchedTokens: new Map(),
        client: {
            readContract: vi.fn().mockResolvedValue("MOCK"),
            call: vi.fn().mockResolvedValue({ data: "0x" }),
        },
        watchToken: vi.fn(),
    })),
}));

vi.mock("./types", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        Order: {
            fromBytes: vi.fn().mockImplementation((value: any) => ({
                owner: value === "0xadminBytes" ? "0xadmin" : "0xowner",
                validInputs: [{ token: "0xinput", decimals: 18 }],
                validOutputs: [{ token: "0xoutput", decimals: 18 }],
            })),
        },
    };
});

describe("Test OrderManager", () => {
    let orderManager: OrderManager;
    let state: SharedState;
    let subgraphManager: SubgraphManager;

    beforeEach(async () => {
        state = new (SharedState as Mock)();
        (state as any).orderManagerConfig = {
            quoteGas: 1000000n,
            ownerLimits: {
                "0xadmin": 75,
            },
        };
        subgraphManager = new (SubgraphManager as Mock)();
        orderManager = new OrderManager(state, subgraphManager);
    });

    it("should correctly fetch orders", async () => {
        const mockOrder = {
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        (orderManager.subgraphManager.fetchAll as Mock).mockResolvedValueOnce({
            orders: [mockOrder],
            report: { status: "ok" },
        });
        const report = await orderManager.fetch();

        expect(report).toEqual({ status: "ok" });
        expect(orderManager.orderMap.size).toBe(1);
        expect(
            orderManager.orderMap.get("0xorderbook")?.get("0xowner")?.orders.get("0xhash")
                ?.takeOrders[0].buyToken,
        ).toBe("0xinput");
        expect(
            orderManager.orderMap.get("0xorderbook")?.get("0xowner")?.orders.get("0xhash")
                ?.takeOrders[0].sellToken,
        ).toBe("0xoutput");
    });

    it("should correctly sync orders", async () => {
        const addOrder = {
            order: {
                orderHash: "0xadd",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
        };
        const removeOrder = {
            order: {
                orderHash: "0xremove",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
        };
        // mock syncOrders to return addOrders and removeOrders
        (orderManager.subgraphManager.syncOrders as Mock).mockResolvedValueOnce({
            result: {
                "0xorderbook": {
                    addOrders: [addOrder],
                    removeOrders: [removeOrder],
                },
            },
            report: { status: "synced" },
        });

        // spy on addOrders and removeOrders
        const addOrdersSpy = vi.spyOn(orderManager, "addOrders");
        const removeOrdersSpy = vi.spyOn(orderManager, "removeOrders");
        const downscaleSpy = vi.spyOn(orderManager, "downscaleProtection");
        const report = await orderManager.sync();

        expect(addOrdersSpy).toHaveBeenCalledWith([addOrder.order]);
        expect(removeOrdersSpy).toHaveBeenCalledWith([removeOrder.order]);
        expect(downscaleSpy).toHaveBeenCalledWith(true);
        expect(report).toEqual({ status: "synced" });

        // clean up spies
        addOrdersSpy.mockRestore();
        removeOrdersSpy.mockRestore();
        downscaleSpy.mockRestore();
    });

    it("should not call downscaleProtection if no orders changed", async () => {
        (orderManager.subgraphManager.syncOrders as Mock).mockResolvedValueOnce({
            result: {
                "0xorderbook": {
                    addOrders: [],
                    removeOrders: [],
                },
            },
            report: { status: "synced" },
        });
        const downscaleSpy = vi.spyOn(orderManager, "downscaleProtection");
        await orderManager.sync();

        expect(downscaleSpy).not.toHaveBeenCalled();

        downscaleSpy.mockRestore();
    });

    it("should correctly add orders", async () => {
        const orders = [
            {
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook1" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
            {
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook2" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
        ];
        await orderManager.addOrders(orders as any);

        expect(orderManager.orderMap.size).toBe(2);
        expect(orderManager.orderMap.get("0xorderbook1")).toBeDefined();
        expect(orderManager.orderMap.get("0xorderbook2")).toBeDefined();

        // check first order
        const ownerProfileMap1 = orderManager.orderMap.get("0xorderbook1");
        expect(ownerProfileMap1).toBeDefined();
        const ownerProfile1 = ownerProfileMap1?.get("0xowner");
        expect(ownerProfile1).toBeDefined();
        expect(ownerProfile1?.orders.size).toBe(1);
        const orderProfile1 = ownerProfile1?.orders.get("0xhash1");
        expect(orderProfile1).toBeDefined();
        expect(orderProfile1?.active).toBe(true);
        expect(orderProfile1?.order).toBeDefined();
        expect(Array.isArray(orderProfile1?.takeOrders)).toBe(true);
        expect(orderProfile1?.takeOrders.length).toBeGreaterThan(0);

        // check second order
        const ownerProfileMap2 = orderManager.orderMap.get("0xorderbook2");
        expect(ownerProfileMap2).toBeDefined();
        const ownerProfile2 = ownerProfileMap2?.get("0xowner");
        expect(ownerProfile2).toBeDefined();
        expect(ownerProfile2?.orders.size).toBe(1);
        const orderProfile2 = ownerProfile2?.orders.get("0xhash2");
        expect(orderProfile2).toBeDefined();
        expect(orderProfile2?.active).toBe(true);
        expect(orderProfile2?.order).toBeDefined();
        expect(Array.isArray(orderProfile2?.takeOrders)).toBe(true);
        expect(orderProfile2?.takeOrders.length).toBeGreaterThan(0);
    });

    it("should remove orders", async () => {
        const mockOrder = {
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        await orderManager.addOrders([mockOrder as any]);
        expect(orderManager.orderMap.size).toBe(1);

        await orderManager.removeOrders([mockOrder as any]);
        const ownerProfileMap = orderManager.orderMap.get("0xorderbook");
        expect(ownerProfileMap?.get("0xowner")?.orders.size).toBe(0);
    });

    it("should get next round orders", async () => {
        const mockOrder = {
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        await orderManager.addOrders([mockOrder as any]);
        const result = orderManager.getNextRoundOrders(false);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);

        // Check the structure of the first orderbook's bundled orders
        const bundledOrders = result[0];
        expect(Array.isArray(bundledOrders)).toBe(true);
        expect(bundledOrders.length).toBeGreaterThan(0);

        const bundle = bundledOrders[0];
        expect(bundle).toHaveProperty("orderbook", "0xorderbook");
        expect(bundle).toHaveProperty("buyToken", "0xinput");
        expect(bundle).toHaveProperty("buyTokenDecimals", 18);
        expect(bundle).toHaveProperty("buyTokenSymbol", "IN");
        expect(bundle).toHaveProperty("sellToken", "0xoutput");
        expect(bundle).toHaveProperty("sellTokenDecimals", 18);
        expect(bundle).toHaveProperty("sellTokenSymbol", "OUT");
        expect(Array.isArray(bundle.takeOrders)).toBe(true);
        expect(bundle.takeOrders.length).toBeGreaterThan(0);

        const takeOrder = bundle.takeOrders[0];
        expect(takeOrder).toHaveProperty("id", "0xhash");
        expect(takeOrder).toHaveProperty("takeOrder");
        expect(takeOrder.takeOrder).toHaveProperty("order");
        expect(takeOrder.takeOrder).toHaveProperty("inputIOIndex", 0);
        expect(takeOrder.takeOrder).toHaveProperty("outputIOIndex", 0);
        expect(takeOrder.takeOrder).toHaveProperty("signedContext");
        expect(Array.isArray(takeOrder.takeOrder.signedContext)).toBe(true);
    });

    it("should reset limits to default", async () => {
        const mockOrder = {
            owner: "0xowner",
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        const adminOrder = {
            owner: "0xadmin",
            orderHash: "0xadmin",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xadminBytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        await orderManager.addOrders([mockOrder as any, adminOrder as any]);
        await orderManager.resetLimits();

        const ownerProfileMap = orderManager.orderMap.get("0xorderbook");
        expect(ownerProfileMap?.get("0xowner")?.limit).toBe(DEFAULT_OWNER_LIMIT);
        expect(ownerProfileMap?.get("0xadmin")?.limit).toBe(75); // admin set limit should not reset
    });

    it("getOrderPairs should return all valid input/output pairs", async () => {
        const orderStruct = {
            owner: "0xowner",
            validInputs: [
                { token: "0xinput1", decimals: 18 },
                { token: "0xinput2", decimals: 6 },
            ],
            validOutputs: [
                { token: "0xoutput1", decimals: 18 },
                { token: "0xoutput2", decimals: 6 },
            ],
        };
        const orderDetails = {
            orderbook: { id: "0xorderbook" },
            outputs: [
                { token: { address: "0xoutput1", symbol: "OUT1" } },
                { token: { address: "0xoutput2", symbol: "OUT2" } },
            ],
            inputs: [
                { token: { address: "0xinput1", symbol: "IN1" } },
                { token: { address: "0xinput2", symbol: "IN2" } },
            ],
        };
        const pairs = await orderManager.getOrderPairs(
            "0xhash",
            orderStruct as any,
            orderDetails as any,
        );

        // should be 4 pairs (2 inputs x 2 outputs)
        expect(pairs.length).toBe(4);
        expect(pairs).toMatchObject([
            {
                buyToken: "0xinput1",
                buyTokenSymbol: "IN1",
                buyTokenDecimals: 18,
                sellToken: "0xoutput1",
                sellTokenSymbol: "OUT1",
                sellTokenDecimals: 18,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput1",
                sellTokenSymbol: "OUT1",
                sellTokenDecimals: 18,
            },
            {
                buyToken: "0xinput1",
                buyTokenSymbol: "IN1",
                buyTokenDecimals: 18,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
            },
        ]);
    });

    it("quoteOrder should set quote on the takeOrder", async () => {
        const bundledOrder = {
            orderbook: "0xorderbook",
            buyToken: "0xinput",
            buyTokenDecimals: 18,
            buyTokenSymbol: "IN",
            sellToken: "0xoutput",
            sellTokenDecimals: 18,
            sellTokenSymbol: "OUT",
            takeOrders: [
                {
                    id: "0xhash",
                    takeOrder: {
                        order: {
                            owner: "0xowner",
                            validInputs: [{ token: "0xinput", decimals: 18 }],
                            validOutputs: [{ token: "0xoutput", decimals: 18 }],
                        },
                        inputIOIndex: 0,
                        outputIOIndex: 0,
                        signedContext: [],
                    },
                },
            ],
        } as any;
        await orderManager.quoteOrder(bundledOrder as any);
        expect(bundledOrder.takeOrders[0].quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
    });
});
