import * as pairFns from "./pair";
import { Result } from "../common";
import * as common from "../common";
import { syncOrders } from "./sync";
import { SharedState } from "../state";
import { OrderManagerError } from "./error";
import { SubgraphManager, SubgraphVersions } from "../subgraph";
import { downscaleProtection } from "./protection";
import { CounterpartySource, Order, Pair } from "./types";
import { OrderManager, DEFAULT_OWNER_LIMIT, OrderbookVersions } from "./index";
import { describe, it, expect, beforeEach, vi, Mock, assert } from "vitest";

vi.mock("./sync", () => ({
    syncOrders: vi.fn(),
}));

vi.mock("./protection", () => ({
    downscaleProtection: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    erc20Abi: [],
    encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
    decodeFunctionResult: vi.fn().mockReturnValue([null, 100n, 2n]),
}));

vi.mock("../subgraph", async (importOriginal) => ({
    ...(await importOriginal()),
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
            Type: {
                V3: "V3",
                V4: "V4",
            },
            tryFromBytes: vi.fn().mockImplementation((value: any) =>
                Result.ok({
                    type: Order.Type.V3,
                    owner: value === "0xadminBytes" ? "0xadmin" : "0xowner",
                    validInputs: [{ token: "0xinput", decimals: 18, vaultId: 1n }],
                    validOutputs: [{ token: "0xoutput", decimals: 18, vaultId: 1n }],
                }),
            ),
        },
    };
});

describe("Test OrderManager", () => {
    let orderManager: OrderManager;
    let state: SharedState;
    let subgraphManager: SubgraphManager;

    const getPair = (orderbook: string, hash: string, output: string, input: string): Pair =>
        ({
            orderbook,
            buyToken: input,
            sellToken: output,
            takeOrder: { id: hash },
        }) as any;

    beforeEach(async () => {
        vi.clearAllMocks();
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
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        (orderManager.subgraphManager.fetchAll as Mock).mockResolvedValueOnce(
            Result.ok({
                orders: [mockOrder],
                report: { status: "ok" },
            }),
        );
        const fetchResult = await orderManager.fetch();
        assert(fetchResult.isOk());
        const report = fetchResult.value;

        expect(report).toEqual({ status: "ok" });
        expect(orderManager.ownersMap.size).toBe(1);
        expect(
            orderManager.ownersMap.get("0xorderbook")?.get("0xowner")?.orders.get("0xhash")
                ?.takeOrders[0].buyToken,
        ).toBe("0xinput");
        expect(
            orderManager.ownersMap.get("0xorderbook")?.get("0xowner")?.orders.get("0xhash")
                ?.takeOrders[0].sellToken,
        ).toBe("0xoutput");
    });

    it("should correctly sync orders", async () => {
        // mock syncOrders to return addOrder and removeOrders
        (syncOrders as Mock).mockResolvedValueOnce(undefined);
        await orderManager.sync();

        expect(syncOrders).toHaveBeenCalledOnce();
    });

    it("should correctly add v3 orders", async () => {
        const orders = [
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook1" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 2n }],
            },
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook2" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 3n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 4n }],
            },
        ];
        await orderManager.addOrder(orders[0] as any);
        await orderManager.addOrder(orders[1] as any);

        expect(orderManager.ownersMap.size).toBe(2);
        expect(orderManager.ownersMap.get("0xorderbook1")).toBeDefined();
        expect(orderManager.ownersMap.get("0xorderbook2")).toBeDefined();

        // check first order in owner map
        const ownerProfileMap1 = orderManager.ownersMap.get("0xorderbook1");
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

        // check pairMap for first order
        const pairMap1 = orderManager.oiPairMap.get("0xorderbook1");
        expect(pairMap1).toBeDefined();
        const pairArr1 = pairMap1?.get("0xoutput")?.get("0xinput");
        expect(pairArr1).toBeInstanceOf(Map);
        expect(pairArr1?.size).toBeGreaterThan(0);
        expect(pairArr1?.get("0xhash1")?.buyToken).toBe("0xinput");
        expect(pairArr1?.get("0xhash1")?.sellToken).toBe("0xoutput");
        expect(pairArr1?.get("0xhash1")?.takeOrder.id).toBe("0xhash1");

        // check second order in owner map
        const ownerProfileMap2 = orderManager.ownersMap.get("0xorderbook2");
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

        // check pairMap for second order
        const pairMap2 = orderManager.oiPairMap.get("0xorderbook2");
        expect(pairMap2).toBeDefined();
        const pairArr2 = pairMap2?.get("0xoutput")?.get("0xinput");
        expect(pairArr2).toBeInstanceOf(Map);
        expect(pairArr2?.size).toBeGreaterThan(0);
        expect(pairArr2?.get("0xhash2")?.buyToken).toBe("0xinput");
        expect(pairArr2?.get("0xhash2")?.sellToken).toBe("0xoutput");
        expect(pairArr2?.get("0xhash2")?.takeOrder.id).toBe("0xhash2");

        // check ownerTokenVaultMap for first order (orderbook1)
        const orderbookVaultMap1 = orderManager.ownerTokenVaultMap.get("0xorderbook1");
        expect(orderbookVaultMap1).toBeDefined();
        const ownerVaultMap1 = orderbookVaultMap1?.get("0xowner");
        expect(ownerVaultMap1).toBeDefined();

        // check output vault for first order
        const outputTokenVaultMap1 = ownerVaultMap1?.get("0xoutput");
        expect(outputTokenVaultMap1).toBeDefined();
        const outputVault1 = outputTokenVaultMap1?.get(1n);
        expect(outputVault1).toBeDefined();
        expect(outputVault1?.id).toBe(1n);
        expect(outputVault1?.balance).toBe(1n);
        expect(outputVault1?.token).toEqual({
            address: "0xoutput",
            symbol: "OUT",
            decimals: 18,
        });

        // check input vault for first order
        const inputTokenVaultMap1 = ownerVaultMap1?.get("0xinput");
        expect(inputTokenVaultMap1).toBeDefined();
        const inputVault1 = inputTokenVaultMap1?.get(1n);
        expect(inputVault1).toBeDefined();
        expect(inputVault1?.id).toBe(1n);
        expect(inputVault1?.balance).toBe(2n);
        expect(inputVault1?.token).toEqual({
            address: "0xinput",
            symbol: "IN",
            decimals: 18,
        });

        // check ownerTokenVaultMap for second order (orderbook2)
        const orderbookVaultMap2 = orderManager.ownerTokenVaultMap.get("0xorderbook2");
        expect(orderbookVaultMap2).toBeDefined();
        const ownerVaultMap2 = orderbookVaultMap2?.get("0xowner");
        expect(ownerVaultMap2).toBeDefined();

        // check output vault for second order
        const outputTokenVaultMap2 = ownerVaultMap2?.get("0xoutput");
        expect(outputTokenVaultMap2).toBeDefined();
        const outputVault2 = outputTokenVaultMap2?.get(1n);
        expect(outputVault2).toBeDefined();
        expect(outputVault2?.id).toBe(1n);
        expect(outputVault2?.balance).toBe(3n);
        expect(outputVault2?.token).toEqual({
            address: "0xoutput",
            symbol: "OUT",
            decimals: 18,
        });

        // check input vault for second order
        const inputTokenVaultMap2 = ownerVaultMap2?.get("0xinput");
        expect(inputTokenVaultMap2).toBeDefined();
        const inputVault2 = inputTokenVaultMap2?.get(1n);
        expect(inputVault2).toBeDefined();
        expect(inputVault2?.id).toBe(1n);
        expect(inputVault2?.balance).toBe(4n);
        expect(inputVault2?.token).toEqual({
            address: "0xinput",
            symbol: "IN",
            decimals: 18,
        });
    });

    it("should correctly add v4 orders", async () => {
        const res = Result.ok({
            type: Order.Type.V4,
            owner: "0xowner",
            validInputs: [
                {
                    token: "0xinput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
            validOutputs: [
                {
                    token: "0xoutput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
        });
        (Order.tryFromBytes as Mock).mockReturnValueOnce(res).mockReturnValueOnce(res);
        const orders = [
            {
                __version: SubgraphVersions.V6,
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook1" },
                orderBytes: "0xbytes",
                outputs: [
                    {
                        token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000001",
                    },
                ],
                inputs: [
                    {
                        token: { address: "0xinput", symbol: "IN", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000002",
                    },
                ],
            },
            {
                __version: SubgraphVersions.V6,
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook2" },
                orderBytes: "0xbytes",
                outputs: [
                    {
                        token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000003",
                    },
                ],
                inputs: [
                    {
                        token: { address: "0xinput", symbol: "IN", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000004",
                    },
                ],
            },
        ];
        await orderManager.addOrder(orders[0] as any);
        await orderManager.addOrder(orders[1] as any);

        expect(orderManager.ownersMap.size).toBe(2);
        expect(orderManager.ownersMap.get("0xorderbook1")).toBeDefined();
        expect(orderManager.ownersMap.get("0xorderbook2")).toBeDefined();

        // check first order in owner map
        const ownerProfileMap1 = orderManager.ownersMap.get("0xorderbook1");
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

        // check pairMap for first order
        const pairMap1 = orderManager.oiPairMap.get("0xorderbook1");
        expect(pairMap1).toBeDefined();
        const pairArr1 = pairMap1?.get("0xoutput")?.get("0xinput");
        expect(pairArr1).toBeInstanceOf(Map);
        expect(pairArr1?.size).toBeGreaterThan(0);
        expect(pairArr1?.get("0xhash1")?.buyToken).toBe("0xinput");
        expect(pairArr1?.get("0xhash1")?.sellToken).toBe("0xoutput");
        expect(pairArr1?.get("0xhash1")?.takeOrder.id).toBe("0xhash1");

        // check second order in owner map
        const ownerProfileMap2 = orderManager.ownersMap.get("0xorderbook2");
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

        // check pairMap for second order
        const pairMap2 = orderManager.oiPairMap.get("0xorderbook2");
        expect(pairMap2).toBeDefined();
        const pairArr2 = pairMap2?.get("0xoutput")?.get("0xinput");
        expect(pairArr2).toBeInstanceOf(Map);
        expect(pairArr2?.size).toBeGreaterThan(0);
        expect(pairArr2?.get("0xhash2")?.buyToken).toBe("0xinput");
        expect(pairArr2?.get("0xhash2")?.sellToken).toBe("0xoutput");
        expect(pairArr2?.get("0xhash2")?.takeOrder.id).toBe("0xhash2");

        // check ownerTokenVaultMap for first order (orderbook1)
        const orderbookVaultMap1 = orderManager.ownerTokenVaultMap.get("0xorderbook1");
        expect(orderbookVaultMap1).toBeDefined();
        const ownerVaultMap1 = orderbookVaultMap1?.get("0xowner");
        expect(ownerVaultMap1).toBeDefined();

        // check output vault for first order
        const outputTokenVaultMap1 = ownerVaultMap1?.get("0xoutput");
        expect(outputTokenVaultMap1).toBeDefined();
        const outputVault1 = outputTokenVaultMap1?.get(1n);
        expect(outputVault1).toBeDefined();
        expect(outputVault1?.id).toBe(1n);
        expect(outputVault1?.balance).toBe(1n);
        expect(outputVault1?.token).toEqual({
            address: "0xoutput",
            symbol: "OUT",
            decimals: 18,
        });

        // check input vault for first order
        const inputTokenVaultMap1 = ownerVaultMap1?.get("0xinput");
        expect(inputTokenVaultMap1).toBeDefined();
        const inputVault1 = inputTokenVaultMap1?.get(1n);
        expect(inputVault1).toBeDefined();
        expect(inputVault1?.id).toBe(1n);
        expect(inputVault1?.balance).toBe(2n);
        expect(inputVault1?.token).toEqual({
            address: "0xinput",
            symbol: "IN",
            decimals: 18,
        });

        // check ownerTokenVaultMap for second order (orderbook2)
        const orderbookVaultMap2 = orderManager.ownerTokenVaultMap.get("0xorderbook2");
        expect(orderbookVaultMap2).toBeDefined();
        const ownerVaultMap2 = orderbookVaultMap2?.get("0xowner");
        expect(ownerVaultMap2).toBeDefined();

        // check output vault for second order
        const outputTokenVaultMap2 = ownerVaultMap2?.get("0xoutput");
        expect(outputTokenVaultMap2).toBeDefined();
        const outputVault2 = outputTokenVaultMap2?.get(1n);
        expect(outputVault2).toBeDefined();
        expect(outputVault2?.id).toBe(1n);
        expect(outputVault2?.balance).toBe(3n);
        expect(outputVault2?.token).toEqual({
            address: "0xoutput",
            symbol: "OUT",
            decimals: 18,
        });

        // check input vault for second order
        const inputTokenVaultMap2 = ownerVaultMap2?.get("0xinput");
        expect(inputTokenVaultMap2).toBeDefined();
        const inputVault2 = inputTokenVaultMap2?.get(1n);
        expect(inputVault2).toBeDefined();
        expect(inputVault2?.id).toBe(1n);
        expect(inputVault2?.balance).toBe(4n);
        expect(inputVault2?.token).toEqual({
            address: "0xinput",
            symbol: "IN",
            decimals: 18,
        });
    });

    it("should return error when add order fails", async () => {
        const order = {
            orderHash: "0xhash1",
            orderbook: { id: "0xorderbook1" },
            orderBytes: "0xbytes",
            outputs: [
                {
                    token: { address: "0xoutput", symbol: "OUT" },
                    balance: 1n,
                },
            ],
            inputs: [
                {
                    token: { address: "0xinput", symbol: "IN" },
                    balance: 1n,
                },
            ],
        };

        (Order.tryFromBytes as Mock).mockReturnValueOnce(Result.err("some error"));
        const result = await orderManager.addOrder(order as any);
        assert(result.isErr());
        expect(result.error).instanceOf(OrderManagerError);
        expect(Order.tryFromBytes).toHaveBeenCalledTimes(1);

        const getOrderPairsSpy = vi.spyOn(orderManager, "getOrderPairs");
        getOrderPairsSpy.mockResolvedValueOnce(Result.err(new OrderManagerError("err", 1)));
        const result2 = await orderManager.addOrder(order as any);
        assert(result2.isErr());
        expect(result2.error).instanceOf(OrderManagerError);

        getOrderPairsSpy.mockRestore();
    });

    it("should remove v3 orders", async () => {
        const mockOrder = {
            __version: SubgraphVersions.OLD_V,
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        await orderManager.addOrder(mockOrder as any);
        expect(orderManager.ownersMap.size).toBe(1);

        // check pairMap before removal
        const pairMapBefore = orderManager.oiPairMap.get("0xorderbook");
        expect(pairMapBefore).toBeDefined();
        const pairArrBefore = pairMapBefore?.get("0xoutput")?.get("0xinput");
        expect(pairArrBefore).toBeInstanceOf(Map);
        expect(pairArrBefore?.size).toBeGreaterThan(0);
        expect(pairArrBefore?.get("0xhash")?.takeOrder.id).toBe("0xhash");

        await orderManager.removeOrders([mockOrder as any]);
        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
        expect(ownerProfileMap?.get("0xowner")?.orders.size).toBe(0);

        // check pairMap after removal
        const pairMapAfter = orderManager.oiPairMap.get("0xorderbook");
        // the pair should be deleted from the map after removal
        expect(pairMapAfter?.get("0xinput/0xoutput")).toBeUndefined();
    });

    it("should remove v4 orders", async () => {
        const res = Result.ok({
            type: Order.Type.V4,
            owner: "0xowner",
            validInputs: [
                {
                    token: "0xinput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
            validOutputs: [
                {
                    token: "0xoutput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
        });
        (Order.tryFromBytes as Mock).mockReturnValueOnce(res);
        const mockOrder = {
            __version: SubgraphVersions.OLD_V,
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [
                {
                    token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
            ],
            inputs: [
                {
                    token: { address: "0xinput", symbol: "IN", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
            ],
        };
        await orderManager.addOrder(mockOrder as any);
        expect(orderManager.ownersMap.size).toBe(1);

        // check pairMap before removal
        const pairMapBefore = orderManager.oiPairMap.get("0xorderbook");
        expect(pairMapBefore).toBeDefined();
        const pairArrBefore = pairMapBefore?.get("0xoutput")?.get("0xinput");
        expect(pairArrBefore).toBeInstanceOf(Map);
        expect(pairArrBefore?.size).toBeGreaterThan(0);
        expect(pairArrBefore?.get("0xhash")?.takeOrder.id).toBe("0xhash");

        await orderManager.removeOrders([mockOrder as any]);
        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
        expect(ownerProfileMap?.get("0xowner")?.orders.size).toBe(0);

        // check pairMap after removal
        const pairMapAfter = orderManager.oiPairMap.get("0xorderbook");
        // the pair should be deleted from the map after removal
        expect(pairMapAfter?.get("0xinput/0xoutput")).toBeUndefined();
    });

    it("should get next round orders", async () => {
        const mockOrder = {
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 2n }],
        };
        await orderManager.addOrder(mockOrder as any);

        const result = orderManager.getNextRoundOrders();
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);

        // check the structure of the first orderbook's bundled orders
        const bundledOrders = result;
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
        expect(bundle).toHaveProperty("sellTokenVaultBalance", 1n);
        expect(bundle).toHaveProperty("buyTokenVaultBalance", 2n);

        const takeOrder = bundle.takeOrder;
        expect(takeOrder).toHaveProperty("id", "0xhash");
        expect(takeOrder).toHaveProperty("struct");
        expect(takeOrder.struct).toHaveProperty("order");
        expect(takeOrder.struct).toHaveProperty("inputIOIndex", 0);
        expect(takeOrder.struct).toHaveProperty("outputIOIndex", 0);
        expect(takeOrder.struct).toHaveProperty("signedContext");
        expect(Array.isArray(takeOrder.struct.signedContext)).toBe(true);
    });

    it("should reset limits to default", async () => {
        const mockOrder = {
            owner: "0xowner",
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        const adminOrder = {
            owner: "0xadmin",
            orderHash: "0xadmin",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xadminBytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        await orderManager.addOrder(mockOrder as any);
        await orderManager.addOrder(adminOrder as any);
        await orderManager.resetLimits();

        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
        expect(ownerProfileMap?.get("0xowner")?.limit).toBe(DEFAULT_OWNER_LIMIT);
        expect(ownerProfileMap?.get("0xadmin")?.limit).toBe(75); // admin set limit should not reset
    });

    it("getOrderPairs should return all valid input/output v3 pairs", async () => {
        const orderStruct = {
            type: Order.Type.V3,
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
                { token: { address: "0xoutput1", symbol: "OUT1" }, balance: 1n },
                { token: { address: "0xoutput2", symbol: "OUT2" }, balance: 1n },
            ],
            inputs: [
                { token: { address: "0xinput1", symbol: "IN1" }, balance: 1n },
                { token: { address: "0xinput2", symbol: "IN2" }, balance: 1n },
            ],
        };
        const pairsResult = await orderManager.getOrderPairs(
            "0xhash",
            orderStruct as any,
            orderDetails as any,
        );
        assert(pairsResult.isOk());
        const pairs = pairsResult.value;

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
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput1",
                sellTokenSymbol: "OUT1",
                sellTokenDecimals: 18,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput1",
                buyTokenSymbol: "IN1",
                buyTokenDecimals: 18,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
        ]);
    });

    it("getOrderPairs should return all valid input/output v4 pairs", async () => {
        const orderStruct = {
            type: Order.Type.V4,
            owner: "0xowner",
            validInputs: [{ token: "0xinput1" }, { token: "0xinput2" }],
            validOutputs: [{ token: "0xoutput1" }, { token: "0xoutput2" }],
        };
        const orderDetails = {
            __version: SubgraphVersions.OLD_V,
            orderbook: { id: "0xorderbook" },
            outputs: [
                {
                    token: { address: "0xoutput1", symbol: "OUT1", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
                {
                    token: { address: "0xoutput2", symbol: "OUT2", decimals: "6" },
                    balance: "0xfffffffa00000000000000000000000000000000000000000000000000000001",
                },
            ],
            inputs: [
                {
                    token: { address: "0xinput1", symbol: "IN1", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
                {
                    token: { address: "0xinput2", symbol: "IN2", decimals: "6" },
                    balance: "0xfffffffa00000000000000000000000000000000000000000000000000000001",
                },
            ],
        };
        const pairsResult = await orderManager.getOrderPairs(
            "0xhash",
            orderStruct as any,
            orderDetails as any,
        );
        assert(pairsResult.isOk());
        const pairs = pairsResult.value;

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
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput1",
                sellTokenSymbol: "OUT1",
                sellTokenDecimals: 18,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput1",
                buyTokenSymbol: "IN1",
                buyTokenDecimals: 18,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
            {
                buyToken: "0xinput2",
                buyTokenSymbol: "IN2",
                buyTokenDecimals: 6,
                sellToken: "0xoutput2",
                sellTokenSymbol: "OUT2",
                sellTokenDecimals: 6,
                sellTokenVaultBalance: 1n,
                buyTokenVaultBalance: 1n,
            },
        ]);
    });

    it("getOrderPairs should return error when fails to get decimals", async () => {
        const orderStruct = {
            owner: "0xowner",
            validInputs: [{ token: "0xinput" }],
            validOutputs: [{ token: "0xoutput" }],
        };
        const orderDetails = {
            orderbook: { id: "0xorderbook" },
            outputs: [
                {
                    token: { address: "0xoutput", symbol: "OUT1" },
                    balance: 1n,
                },
            ],
            inputs: [
                {
                    token: { address: "0xinput", symbol: "IN1" },
                    balance: 1n,
                },
            ],
        };
        (orderManager.state.client.readContract as Mock).mockRejectedValueOnce("some error");
        const pairsResult = await orderManager.getOrderPairs(
            "0xhash",
            orderStruct as any,
            orderDetails as any,
        );
        assert(pairsResult.isErr());
        expect(pairsResult.error).instanceOf(OrderManagerError);
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
            takeOrder: {
                id: "0xhash",
                struct: {
                    order: {
                        type: Order.Type.V3,
                        owner: "0xowner",
                        validInputs: [{ token: "0xinput", decimals: 18 }],
                        validOutputs: [{ token: "0xoutput", decimals: 18 }],
                    },
                    inputIOIndex: 0,
                    outputIOIndex: 0,
                    signedContext: [],
                },
            },
        } as any;
        await orderManager.quoteOrder(bundledOrder as any);
        expect(bundledOrder.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
    });

    it("should rotate owner orders correctly across getNextRoundOrders() calls", async () => {
        const res = Result.ok({
            type: Order.Type.V4,
            owner: "0xowner",
            validInputs: [
                {
                    token: "0xinput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
            validOutputs: [
                {
                    token: "0xoutput",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
        });
        (Order.tryFromBytes as Mock).mockReturnValueOnce(res).mockReturnValueOnce(res);
        // add four orders for the same owner/orderbook with different hashes
        const orders = [
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes1",
                outputs: [
                    {
                        token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000001",
                    },
                ],
                inputs: [
                    {
                        token: { address: "0xinput", symbol: "IN", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000001",
                    },
                ],
            },
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes2",
                outputs: [
                    {
                        token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000001",
                    },
                ],
                inputs: [
                    {
                        token: { address: "0xinput", symbol: "IN", decimals: "18" },
                        balance:
                            "0xffffffee00000000000000000000000000000000000000000000000000000001",
                    },
                ],
            },
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash3",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes3",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
            },
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash4",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes4",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
            },
        ];
        for (const order of orders) {
            await orderManager.addOrder(order as any);
        }

        // set owner limit to 3 so only three orders are returned per round
        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
        ownerProfileMap!.get("0xowner")!.limit = 3;

        // helper to get the order hashes returned in the round
        const getRoundHashes = () => {
            const roundOrders = orderManager.getNextRoundOrders();
            return roundOrders.map((o) => o.takeOrder.id);
        };

        // first call: should return the first 3 orders
        expect(getRoundHashes()).toEqual(["0xhash1", "0xhash2", "0xhash3"]);

        // second call: should return the last order (0xhash4) and then the first two (rotation)
        expect(getRoundHashes()).toEqual(["0xhash4", "0xhash1", "0xhash2"]);

        // third call: should return the last two and the first one (rotation)
        expect(getRoundHashes()).toEqual(["0xhash3", "0xhash4", "0xhash1"]);

        // fourth call: should return the next three in rotation
        expect(getRoundHashes()).toEqual(["0xhash2", "0xhash3", "0xhash4"]);
    });

    it("should keep quote reference consistent: update quote via getNextRoundOrders and reflect in ownersMap and pairMap", async () => {
        const mockOrder = {
            orderHash: "0xhash",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytes",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        await orderManager.addOrder(mockOrder as any);

        // get the takeOrder object from getNextRoundOrders
        const roundOrders = orderManager.getNextRoundOrders();
        const orderDetails = roundOrders[0];

        // update the quote field via the object from getNextRoundOrders
        orderDetails.takeOrder.quote = { maxOutput: 999n, ratio: 888n };

        // now check that the update is reflected in both ownersMap and pairMap
        const orderbookKey = "0xorderbook";
        const ownerKey = "0xowner";
        const orderHash = "0xhash";

        const ownersMap = orderManager.ownersMap.get(orderbookKey);
        const ownerProfile = ownersMap?.get(ownerKey);
        const orderEntry = ownerProfile?.orders.get(orderHash);
        const takeOrderFromOwnersMap = orderEntry?.takeOrders[0];

        const pairMap = orderManager.oiPairMap.get(orderbookKey);
        const takeOrderFromPairMap = pairMap?.get("0xoutput")?.get("0xinput")?.get("0xhash");

        expect(takeOrderFromOwnersMap?.takeOrder.quote).toEqual({ maxOutput: 999n, ratio: 888n });
        expect(takeOrderFromPairMap?.takeOrder.quote).toEqual({ maxOutput: 999n, ratio: 888n });
        // and all references are the same object
        expect(orderDetails.takeOrder).toBe(takeOrderFromOwnersMap?.takeOrder);
        expect(orderDetails.takeOrder).toBe(takeOrderFromPairMap?.takeOrder);
    });

    it("should get opposing orders in the same orderbook", async () => {
        // add two orders in the same orderbook with opposing buy/sell tokens
        const orderA = {
            orderHash: "0xhashA",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytesA",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
        };
        const orderB = {
            orderHash: "0xhashB",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytesB",
            outputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
            inputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
        };
        (Order.tryFromBytes as Mock)
            .mockReturnValueOnce(
                Result.ok({
                    type: Order.Type.V3,
                    owner: "0xowner",
                    validInputs: [{ token: "0xinput", decimals: 18, vaultId: 1n }],
                    validOutputs: [{ token: "0xoutput", decimals: 18, vaultId: 1n }],
                }),
            )
            .mockReturnValueOnce(
                Result.ok({
                    type: Order.Type.V3,
                    owner: "0xowner",
                    validInputs: [{ token: "0xoutput", decimals: 18, vaultId: 1n }],
                    validOutputs: [{ token: "0xinput", decimals: 18, vaultId: 1n }],
                }),
            );
        await orderManager.addOrder(orderA as any);
        await orderManager.addOrder(orderB as any);
        expect(Order.tryFromBytes).toHaveBeenCalledTimes(2);

        // get a bundled order for orderA (buyToken: 0xinput, sellToken: 0xoutput)
        const roundOrders = orderManager.getNextRoundOrders();

        // should find orderB as opposing order for orderA in the same orderbook
        const opposing = orderManager.getCounterpartyOrders(
            roundOrders[0],
            CounterpartySource.IntraOrderbook,
        );
        expect(Array.isArray(opposing)).toBe(true);
        expect(opposing.length).toBe(1);
        expect(opposing[0].buyToken).toBe("0xoutput");
        expect(opposing[0].sellToken).toBe("0xinput");
        expect(opposing[0].takeOrder.id).toBe("0xhashb");
    });

    it("should get opposing orders across different orderbooks", async () => {
        // add two orders in different orderbooks with opposing buy/sell tokens
        const orderA = {
            __version: SubgraphVersions.OLD_V,
            orderHash: "0xhashA",
            orderbook: { id: "0xorderbookA" },
            orderBytes: "0xbytesA",
            outputs: [
                {
                    token: { address: "0xoutput", symbol: "OUT", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
            ],
            inputs: [
                {
                    token: { address: "0xinput", symbol: "IN", decimals: "18" },
                    balance: "0xffffffee00000000000000000000000000000000000000000000000000000001",
                },
            ],
        };
        const orderB = {
            __version: SubgraphVersions.OLD_V,
            orderHash: "0xhashB",
            orderbook: { id: "0xorderbookB" },
            orderBytes: "0xbytesB",
            outputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 1n }],
            inputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
        };
        (Order.tryFromBytes as Mock)
            .mockReturnValueOnce(
                Result.ok({
                    type: Order.Type.V4,
                    owner: "0xowner",
                    validInputs: [
                        {
                            token: "0xinput",
                            vaultId:
                                "0x0000000000000000000000000000000000000000000000000000000000000001",
                        },
                    ],
                    validOutputs: [
                        {
                            token: "0xoutput",
                            vaultId:
                                "0x0000000000000000000000000000000000000000000000000000000000000001",
                        },
                    ],
                }),
            )
            .mockReturnValueOnce(
                Result.ok({
                    type: Order.Type.V3,
                    owner: "0xowner",
                    validInputs: [{ token: "0xoutput", decimals: 18, vaultId: 1n }],
                    validOutputs: [{ token: "0xinput", decimals: 18, vaultId: 1n }],
                }),
            );
        await orderManager.addOrder(orderA as any);
        await orderManager.addOrder(orderB as any);
        expect(Order.tryFromBytes).toHaveBeenCalledTimes(2);

        // get a bundled order for orderA (buyToken: 0xinput, sellToken: 0xoutput)
        const roundOrders = orderManager.getNextRoundOrders();

        // should find orderB as opposing order for orderA across orderbooks
        const opposing = orderManager.getCounterpartyOrders(
            roundOrders[0],
            CounterpartySource.InterOrderbook,
        );
        for (const counteryparties of opposing) {
            expect(Array.isArray(counteryparties)).toBe(true);
            expect(counteryparties.length).toBe(1);
            expect(counteryparties[0].buyToken).toBe("0xoutput");
            expect(counteryparties[0].sellToken).toBe("0xinput");
            expect(counteryparties[0].takeOrder.id).toBe("0xhashb");
        }
    });

    it("should call addToPairMap with correct params", async () => {
        const pair = getPair("0xorderbook", "0xhash", "0xtkn1", "0xtkn2");
        const addToPairMapSpy = vi.spyOn(pairFns, "addToPairMap");
        orderManager.addToPairMaps(pair);

        expect(addToPairMapSpy).toHaveBeenCalledTimes(2);
        expect(addToPairMapSpy).toHaveBeenCalledWith(
            orderManager.oiPairMap,
            "0xorderbook",
            "0xhash",
            "0xtkn1",
            "0xtkn2",
            pair,
        );
        expect(addToPairMapSpy).toHaveBeenCalledWith(
            orderManager.ioPairMap,
            "0xorderbook",
            "0xhash",
            "0xtkn2",
            "0xtkn1",
            pair,
        );
        addToPairMapSpy.mockRestore();
    });

    it("should call removeFromPairMaps with correct params", async () => {
        const pair = getPair("0xorderbook", "0xhash", "0xtkn1", "0xtkn2");
        orderManager.addToPairMaps(pair);

        const removeFromPairMapSpy = vi.spyOn(pairFns, "removeFromPairMap");
        orderManager.removeFromPairMaps(pair);

        expect(removeFromPairMapSpy).toHaveBeenCalledTimes(2);
        expect(removeFromPairMapSpy).toHaveBeenCalledWith(
            orderManager.oiPairMap,
            "0xorderbook",
            "0xhash",
            "0xtkn1",
            "0xtkn2",
        );
        expect(removeFromPairMapSpy).toHaveBeenCalledWith(
            orderManager.ioPairMap,
            "0xorderbook",
            "0xhash",
            "0xtkn2",
            "0xtkn1",
        );
        removeFromPairMapSpy.mockRestore();
    });

    it("should return undefined when balance is invalid float", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId = 123n;
        const balance = "0x1234";
        const spy = vi.spyOn(common, "normalizeFloat");

        const result = orderManager.updateVault(orderbook, owner, token, vaultId, balance);
        expect(result).toBeUndefined();
        expect(spy).toHaveBeenCalledWith(balance, token.decimals);

        spy.mockRestore();
    });

    it("should update vault correctly when vault doesn't exist", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId = 123n;
        const balance = 1000000000000000000n;

        orderManager.updateVault(orderbook, owner, token, vaultId, balance);

        const orderbookMap = orderManager.ownerTokenVaultMap.get(orderbook);
        expect(orderbookMap).toBeDefined();

        const ownerMap = orderbookMap?.get(owner);
        expect(ownerMap).toBeDefined();

        const tokenMap = ownerMap?.get(token.address);
        expect(tokenMap).toBeDefined();

        const vault = tokenMap?.get(vaultId);
        expect(vault).toBeDefined();
        expect(vault?.id).toBe(vaultId);
        expect(vault?.balance).toBe(balance);
        expect(vault?.token).toEqual(token);
    });

    it("should update vault correctly when balance is float", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId = 123n;
        const balance = "0xffffffee00000000000000000000000000000000000000000000000000000001";
        const spy = vi.spyOn(common, "normalizeFloat");

        orderManager.updateVault(orderbook, owner, token, vaultId, balance);

        expect(spy).toHaveBeenCalledWith(balance, token.decimals);

        const orderbookMap = orderManager.ownerTokenVaultMap.get(orderbook);
        expect(orderbookMap).toBeDefined();

        const ownerMap = orderbookMap?.get(owner);
        expect(ownerMap).toBeDefined();

        const tokenMap = ownerMap?.get(token.address);
        expect(tokenMap).toBeDefined();

        const vault = tokenMap?.get(vaultId);
        expect(vault).toBeDefined();
        expect(vault?.id).toBe(vaultId);
        expect(vault?.balance).toBe(1n);
        expect(vault?.token).toEqual(token);

        spy.mockRestore();
    });

    it("should update vault correctly when balance is decimal string", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId = 123n;
        const balance = "1000000000000000000";
        const spy = vi.spyOn(common, "normalizeFloat");

        orderManager.updateVault(orderbook, owner, token, vaultId, balance);

        expect(spy).not.toHaveBeenCalled();

        const orderbookMap = orderManager.ownerTokenVaultMap.get(orderbook);
        expect(orderbookMap).toBeDefined();

        const ownerMap = orderbookMap?.get(owner);
        expect(ownerMap).toBeDefined();

        const tokenMap = ownerMap?.get(token.address);
        expect(tokenMap).toBeDefined();

        const vault = tokenMap?.get(vaultId);
        expect(vault).toBeDefined();
        expect(vault?.id).toBe(vaultId);
        expect(vault?.balance).toBe(BigInt(balance));
        expect(vault?.token).toEqual(token);

        spy.mockRestore();
    });

    it("should update existing vault balance", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId = 123n;
        const initialBalance = 1000000000000000000n;
        const newBalance = 2000000000000000000n;

        // First update - create vault
        orderManager.updateVault(orderbook, owner, token, vaultId, initialBalance);

        // verify initial state
        const vault = orderManager.ownerTokenVaultMap
            .get(orderbook)
            ?.get(owner)
            ?.get(token.address)
            ?.get(vaultId);
        expect(vault?.balance).toBe(initialBalance);

        // second update - update balance
        orderManager.updateVault(orderbook, owner, token, vaultId, newBalance);

        // verify updated balance
        const updatedVault = orderManager.ownerTokenVaultMap
            .get(orderbook)
            ?.get(owner)
            ?.get(token.address)
            ?.get(vaultId);
        expect(updatedVault?.balance).toBe(newBalance);
        expect(updatedVault?.id).toBe(vaultId);
        expect(updatedVault?.token).toEqual(token);
    });

    it("should handle multiple vaults for same owner and token", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const vaultId1 = 123n;
        const vaultId2 = 456n;
        const balance1 = 1000000000000000000n;
        const balance2 = 2000000000000000000n;

        orderManager.updateVault(orderbook, owner, token, vaultId1, balance1);
        orderManager.updateVault(orderbook, owner, token, vaultId2, balance2);

        const tokenMap = orderManager.ownerTokenVaultMap
            .get(orderbook)
            ?.get(owner)
            ?.get(token.address);

        expect(tokenMap?.size).toBe(2);
        expect(tokenMap?.get(vaultId1)?.balance).toBe(balance1);
        expect(tokenMap?.get(vaultId2)?.balance).toBe(balance2);
    });

    it("should preserve existing vaults when adding new ones", () => {
        const orderbook = "0xorderbook1";
        const owner = "0xowner1";
        const token1 = {
            address: "0xtoken1",
            symbol: "TOKEN1",
            decimals: 18,
        };
        const token2 = {
            address: "0xtoken2",
            symbol: "TOKEN2",
            decimals: 6,
        };
        const vaultId1 = 123n;
        const vaultId2 = 456n;
        const balance1 = 1000000000000000000n;
        const balance2 = 500000000n;

        // Add first vault
        orderManager.updateVault(orderbook, owner, token1, vaultId1, balance1);

        // Add second vault with different token
        orderManager.updateVault(orderbook, owner, token2, vaultId2, balance2);

        // verify both vaults exist
        const ownerMap = orderManager.ownerTokenVaultMap.get(orderbook)?.get(owner);
        expect(ownerMap?.size).toBe(2);

        const vault1 = ownerMap?.get(token1.address)?.get(vaultId1);
        const vault2 = ownerMap?.get(token2.address)?.get(vaultId2);

        expect(vault1?.balance).toBe(balance1);
        expect(vault1?.token).toEqual(token1);
        expect(vault2?.balance).toBe(balance2);
        expect(vault2?.token).toEqual(token2);
    });

    it("should call updateVault with correct parameters for both input and output vaults", () => {
        const mockPair: Pair = {
            orderbookVersion: OrderbookVersions.V5,
            orderbook: "0xOrderBook",
            buyToken: "0xToken1",
            sellToken: "0xToken2",
            buyTokenSymbol: "T1",
            sellTokenSymbol: "T2",
            buyTokenDecimals: 18,
            sellTokenDecimals: 6,
            buyTokenVaultBalance: 1000n,
            sellTokenVaultBalance: 2000n,
            takeOrder: {
                id: "0xHash",
                struct: {
                    order: {
                        type: Order.Type.V3,
                        owner: "0xOwner",
                        validOutputs: [
                            { token: "0xToken0", decimals: 8, vaultId: 10n },
                            { token: "0xToken2", decimals: 6, vaultId: 20n }, // outputIOIndex: 1
                        ],
                        validInputs: [
                            { token: "0xToken1", decimals: 18, vaultId: 30n }, // inputIOIndex: 0
                            { token: "0xToken3", decimals: 12, vaultId: 40n },
                        ],
                    } as any,
                    outputIOIndex: 1, // should use second output
                    inputIOIndex: 0, // should use first input
                    signedContext: [],
                },
            },
        };
        const updateVaultSpy = vi.spyOn(orderManager, "updateVault");
        orderManager.addToTokenVaultsMap(mockPair);

        expect(updateVaultSpy).toHaveBeenCalledTimes(2);

        // should use outputIOIndex: 1 (second output)
        expect(updateVaultSpy).toHaveBeenNthCalledWith(
            1,
            "0xorderbook",
            "0xowner",
            {
                address: "0xtoken2", // From validOutputs[1]
                decimals: 6, // From validOutputs[1]
                symbol: "T2",
            },
            20n, // From validOutputs[1].vaultId
            2000n, // sellTokenVaultBalance
        );

        // should use inputIOIndex: 0 (first input)
        expect(updateVaultSpy).toHaveBeenNthCalledWith(
            2,
            "0xorderbook",
            "0xowner",
            {
                address: "0xtoken1", // From validInputs[0]
                decimals: 18, // From validInputs[0]
                symbol: "T1",
            },
            30n, // From validInputs[0].vaultId
            1000n, // buyTokenVaultBalance
        );

        updateVaultSpy.mockRestore();
    });

    it("test downscaleProtection method with reset", async () => {
        const resetLimitsSpy = vi.spyOn(orderManager, "resetLimits");
        (downscaleProtection as Mock).mockResolvedValue(undefined);

        await orderManager.downscaleProtection();

        expect(resetLimitsSpy).toHaveBeenCalledTimes(1);
        expect(downscaleProtection).toHaveBeenCalledTimes(1);
        expect(downscaleProtection).toHaveBeenCalledWith(
            orderManager.ownersMap,
            orderManager.ownerTokenVaultMap,
            orderManager.state.client,
            orderManager.ownerLimits,
        );
        resetLimitsSpy.mockRestore();
    });

    it("test downscaleProtection method without reset", async () => {
        const resetLimitsSpy = vi.spyOn(orderManager, "resetLimits");
        (downscaleProtection as Mock).mockResolvedValue(undefined);

        await orderManager.downscaleProtection(false);

        expect(resetLimitsSpy).not.toHaveBeenCalled();
        expect(downscaleProtection).toHaveBeenCalledTimes(1);
        expect(downscaleProtection).toHaveBeenCalledWith(
            orderManager.ownersMap,
            orderManager.ownerTokenVaultMap,
            orderManager.state.client,
            orderManager.ownerLimits,
        );

        resetLimitsSpy.mockRestore();
    });

    it("test getCurrentMetadata method", async () => {
        const orders = [
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook1" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 1n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 2n }],
            },
            {
                __version: SubgraphVersions.OLD_V,
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook2" },
                orderBytes: "0xbytes",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" }, balance: 3n }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" }, balance: 4n }],
            },
        ];
        await orderManager.addOrder(orders[0] as any);
        await orderManager.addOrder(orders[1] as any);

        const metadata = orderManager.getCurrentMetadata();

        expect(metadata).toEqual({
            totalCount: 2,
            totalOwnersCount: 2,
            totalPairsCount: 2,
            totalDistinctPairsCount: 1,
        });
    });
});
