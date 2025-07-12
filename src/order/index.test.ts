import { Order } from "./types";
import { Result } from "../common";
import { SharedState } from "../state";
import { SubgraphManager } from "../subgraph";
import { OrderManager, DEFAULT_OWNER_LIMIT, sortPairList } from "./index";
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
            tryFromBytes: vi.fn().mockImplementation((value: any) =>
                Result.ok({
                    owner: value === "0xadminBytes" ? "0xadmin" : "0xowner",
                    validInputs: [{ token: "0xinput", decimals: 18 }],
                    validOutputs: [{ token: "0xoutput", decimals: 18 }],
                }),
            ),
        },
    };
});

describe("Test OrderManager", () => {
    const orderbook1 = "0xorderbook1";
    const orderbook2 = "0xorderbook2";
    const tkn1 = "0xtoken1";
    const tkn2 = "0xtoken2";
    const tkn3 = "0xtoken3";
    const tkn4 = "0xtoken4";
    const hash1 = "0xhash1";
    const hash2 = "0xhash2";
    const hash3 = "0xhash3";

    let orderManager: OrderManager;
    let state: SharedState;
    let subgraphManager: SubgraphManager;

    const getPair = (orderbook: string, hash: string, output: string, input: string) =>
        ({
            orderbook,
            buyToken: input,
            sellToken: output,
            takeOrder: { id: hash },
        }) as any;

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
        expect(Array.isArray(pairArr1)).toBe(true);
        expect(pairArr1?.length).toBeGreaterThan(0);
        expect(pairArr1?.[0].buyToken).toBe("0xinput");
        expect(pairArr1?.[0].sellToken).toBe("0xoutput");
        expect(pairArr1?.[0].takeOrder.id).toBe("0xhash1");

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
        expect(Array.isArray(pairArr2)).toBe(true);
        expect(pairArr2?.length).toBeGreaterThan(0);
        expect(pairArr2?.[0].buyToken).toBe("0xinput");
        expect(pairArr2?.[0].sellToken).toBe("0xoutput");
        expect(pairArr2?.[0].takeOrder.id).toBe("0xhash2");
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
        expect(orderManager.ownersMap.size).toBe(1);

        // check pairMap before removal
        const pairMapBefore = orderManager.oiPairMap.get("0xorderbook");
        expect(pairMapBefore).toBeDefined();
        const pairArrBefore = pairMapBefore?.get("0xoutput")?.get("0xinput");
        expect(Array.isArray(pairArrBefore)).toBe(true);
        expect(pairArrBefore?.length).toBeGreaterThan(0);
        expect(pairArrBefore?.[0].takeOrder.id).toBe("0xhash");

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
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        await orderManager.addOrders([mockOrder as any]);
        const result = orderManager.getNextRoundOrders(false);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);

        // Check the structure of the first orderbook's bundled orders
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
        // expect(Array.isArray(bundle.takeOrders)).toBe(true);
        // expect(bundle.takeOrders.length).toBeGreaterThan(0);

        const takeOrder = bundle.takeOrder;
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

        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
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
            takeOrder: {
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
        } as any;
        await orderManager.quoteOrder(bundledOrder as any);
        expect(bundledOrder.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
    });

    it("should rotate owner orders correctly across getNextRoundOrders() calls", async () => {
        // add four orders for the same owner/orderbook with different hashes
        const orders = [
            {
                orderHash: "0xhash1",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes1",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
            {
                orderHash: "0xhash2",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes2",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
            {
                orderHash: "0xhash3",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes3",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
            {
                orderHash: "0xhash4",
                orderbook: { id: "0xorderbook" },
                orderBytes: "0xbytes4",
                outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
                inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            },
        ];
        await orderManager.addOrders(orders as any);

        // set owner limit to 3 so only three orders are returned per round
        const ownerProfileMap = orderManager.ownersMap.get("0xorderbook");
        ownerProfileMap!.get("0xowner")!.limit = 3;

        // helper to get the order hashes returned in the round
        const getRoundHashes = () => {
            const roundOrders = orderManager.getNextRoundOrders(false);
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
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        await orderManager.addOrders([mockOrder as any]);

        // get the takeOrder object from getNextRoundOrders
        const roundOrders = orderManager.getNextRoundOrders(false);
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
        const pairArr = pairMap?.get("0xoutput")?.get("0xinput");
        const takeOrderFromPairMap = pairArr?.[0];

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
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        const orderB = {
            orderHash: "0xhashB",
            orderbook: { id: "0xorderbook" },
            orderBytes: "0xbytesB",
            outputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            inputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
        };
        (Order.tryFromBytes as Mock)
            .mockReturnValueOnce(
                Result.ok({
                    owner: "0xowner",
                    validInputs: [{ token: "0xinput", decimals: 18 }],
                    validOutputs: [{ token: "0xoutput", decimals: 18 }],
                }),
            )
            .mockReturnValueOnce(
                Result.ok({
                    owner: "0xowner",
                    validInputs: [{ token: "0xoutput", decimals: 18 }],
                    validOutputs: [{ token: "0xinput", decimals: 18 }],
                }),
            );
        await orderManager.addOrders([orderA as any, orderB as any]);

        // get a bundled order for orderA (buyToken: 0xinput, sellToken: 0xoutput)
        const roundOrders = orderManager.getNextRoundOrders(false);

        // should find orderB as opposing order for orderA in the same orderbook
        const opposing = orderManager.getCounterpartyOrders(roundOrders[0], true);
        expect(Array.isArray(opposing)).toBe(true);
        expect(opposing.length).toBe(1);
        expect(opposing[0].buyToken).toBe("0xoutput");
        expect(opposing[0].sellToken).toBe("0xinput");
        expect(opposing[0].takeOrder.id).toBe("0xhashb");
    });

    it("should get opposing orders across different orderbooks", async () => {
        // add two orders in different orderbooks with opposing buy/sell tokens
        const orderA = {
            orderHash: "0xhashA",
            orderbook: { id: "0xorderbookA" },
            orderBytes: "0xbytesA",
            outputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
            inputs: [{ token: { address: "0xinput", symbol: "IN" } }],
        };
        const orderB = {
            orderHash: "0xhashB",
            orderbook: { id: "0xorderbookB" },
            orderBytes: "0xbytesB",
            outputs: [{ token: { address: "0xinput", symbol: "IN" } }],
            inputs: [{ token: { address: "0xoutput", symbol: "OUT" } }],
        };
        (Order.tryFromBytes as Mock)
            .mockReturnValueOnce(
                Result.ok({
                    owner: "0xowner",
                    validInputs: [{ token: "0xinput", decimals: 18 }],
                    validOutputs: [{ token: "0xoutput", decimals: 18 }],
                }),
            )
            .mockReturnValueOnce(
                Result.ok({
                    owner: "0xowner",
                    validInputs: [{ token: "0xoutput", decimals: 18 }],
                    validOutputs: [{ token: "0xinput", decimals: 18 }],
                }),
            );
        await orderManager.addOrders([orderA as any, orderB as any]);

        // get a bundled order for orderA (buyToken: 0xinput, sellToken: 0xoutput)
        const roundOrders = orderManager.getNextRoundOrders(false);

        // should find orderB as opposing order for orderA across orderbooks
        const opposing = orderManager.getCounterpartyOrders(roundOrders[0], false);
        for (const counteryparties of opposing) {
            expect(Array.isArray(counteryparties)).toBe(true);
            expect(counteryparties.length).toBe(1);
            expect(counteryparties[0].buyToken).toBe("0xoutput");
            expect(counteryparties[0].sellToken).toBe("0xinput");
            expect(counteryparties[0].takeOrder.id).toBe("0xhashb");
        }
    });

    describe("Test addToPairMap method", () => {
        it("should add pair to empty pair map", async () => {
            const pair = getPair(orderbook1, hash1, tkn1, tkn2);

            // OI map
            orderManager.addToPairMap(pair, false);
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap).toBeDefined();

            const outputMap = oiMap!.get(tkn1);
            expect(outputMap).toBeDefined();

            const oiPairList = outputMap!.get(tkn2);
            expect(oiPairList).toBeDefined();
            expect(oiPairList).toHaveLength(1);
            expect(oiPairList![0]).toBe(pair);

            // IO map
            orderManager.addToPairMap(pair, true);
            const ioMap = orderManager.ioPairMap.get(orderbook1);
            expect(ioMap).toBeDefined();

            const inputMap = ioMap!.get(tkn2);
            expect(inputMap).toBeDefined();

            const ioPairList = inputMap!.get(tkn1);
            expect(ioPairList).toBeDefined();
            expect(ioPairList).toHaveLength(1);
            expect(ioPairList![0]).toBe(pair);
        });

        it("should add pair to existing orderbook map", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn3, tkn4);

            // add first pair
            orderManager.addToPairMap(existingPair, false);
            orderManager.addToPairMap(existingPair, true);

            // OI map
            orderManager.addToPairMap(existingPair, false);
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap).toBeDefined();

            const outputMap = oiMap!.get(tkn1);
            expect(outputMap).toBeDefined();

            const oiPairList = outputMap!.get(tkn2);
            expect(oiPairList).toBeDefined();
            expect(oiPairList).toHaveLength(1);
            expect(oiPairList![0]).toBe(existingPair);

            // IO map
            orderManager.addToPairMap(existingPair, true);
            const ioMap = orderManager.ioPairMap.get(orderbook1);
            expect(ioMap).toBeDefined();

            const inputMap = ioMap!.get(tkn2);
            expect(inputMap).toBeDefined();

            const ioPairList = inputMap!.get(tkn1);
            expect(ioPairList).toBeDefined();
            expect(ioPairList).toHaveLength(1);
            expect(ioPairList![0]).toBe(existingPair);

            // add second pair
            orderManager.addToPairMap(newPair, false);
            orderManager.addToPairMap(newPair, true);

            // OI map
            orderManager.addToPairMap(newPair, false);
            const oiMap2 = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap2).toBeDefined();

            const outputMap2 = oiMap2!.get(tkn3);
            expect(outputMap2).toBeDefined();

            const oiPairList2 = outputMap2!.get(tkn4);
            expect(oiPairList2).toBeDefined();
            expect(oiPairList2).toHaveLength(1);
            expect(oiPairList2![0]).toBe(newPair);

            // IO map
            orderManager.addToPairMap(newPair, true);
            const ioMap2 = orderManager.ioPairMap.get(orderbook1);
            expect(ioMap2).toBeDefined();

            const inputMap2 = ioMap2!.get(tkn4);
            expect(inputMap2).toBeDefined();

            const ioPairList2 = inputMap2!.get(tkn3);
            expect(ioPairList2).toBeDefined();
            expect(ioPairList2).toHaveLength(1);
            expect(ioPairList2![0]).toBe(newPair);
        });

        it("should add pair to existing output token map", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn1, tkn3);

            orderManager.addToPairMap(existingPair, false);
            orderManager.addToPairMap(existingPair, true);

            // OI map
            orderManager.addToPairMap(newPair, false);
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap).toBeDefined();

            const outputMap = oiMap!.get(tkn1);
            expect(outputMap).toBeDefined();
            expect(outputMap!.size).toBe(2);

            orderManager.addToPairMap(existingPair, false);
            orderManager.addToPairMap(existingPair, true);

            // OI map
            const newPair2 = getPair(orderbook1, hash2, tkn3, tkn2);
            orderManager.addToPairMap(newPair2, true);
            const ioMap = orderManager.ioPairMap.get(orderbook1);
            expect(ioMap).toBeDefined();

            const outputMap2 = ioMap!.get(tkn2);
            expect(outputMap2).toBeDefined();
            expect(outputMap2!.size).toBe(2);
        });

        it("should add pair to existing buy token list", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn1, tkn2);

            // OI map
            orderManager.addToPairMap(existingPair, false);
            orderManager.addToPairMap(newPair, false);
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap).toBeDefined();

            const outputMap = oiMap!.get(tkn1);
            expect(outputMap).toBeDefined();
            expect(outputMap!.size).toBe(1);
            const oiPairList = outputMap!.get(tkn2);
            expect(oiPairList).toBeDefined();
            expect(oiPairList).toHaveLength(2);

            // OI map
            orderManager.addToPairMap(existingPair, true);
            orderManager.addToPairMap(newPair, true);
            const ioMap = orderManager.ioPairMap.get(orderbook1);
            expect(ioMap).toBeDefined();

            const outputMap2 = ioMap!.get(tkn2);
            expect(outputMap2).toBeDefined();
            expect(outputMap2!.size).toBe(1);
            const ioPairList = outputMap2!.get(tkn1);
            expect(ioPairList).toBeDefined();
            expect(ioPairList).toHaveLength(2);
        });

        it("should not duplicate pairs with same takeOrder id", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash1, tkn1, tkn2);
            orderManager.addToPairMap(existingPair, false);

            orderManager.addToPairMap(newPair, false);
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap).toBeDefined();

            const outputMap = oiMap!.get(tkn1);
            expect(outputMap).toBeDefined();
            expect(outputMap!.size).toBe(1);
        });

        it("should handle different orderbooks independently", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook2, hash1, tkn1, tkn2);
            orderManager.addToPairMap(pairs1, false);
            orderManager.addToPairMap(pairs2, false);

            expect(orderManager.oiPairMap.size).toBe(2);
            expect(orderManager.oiPairMap.get(orderbook1)).toBeDefined();
            expect(orderManager.oiPairMap.get(orderbook2)).toBeDefined();

            // check that each orderbook has its own pairs
            expect(orderManager.oiPairMap.get(orderbook1)!.get(tkn1)).toBeDefined();
            expect(orderManager.oiPairMap.get(orderbook2)!.get(tkn1)).toBeDefined();
        });
    });

    describe("Test deleteFromPairMap method", () => {
        it("should delete pair from io and oi pair maps when order is removed", async () => {
            const pairs = getPair(orderbook1, hash1, tkn1, tkn2);

            // add pair first
            orderManager.addToPairMap(pairs, false);
            orderManager.addToPairMap(pairs, true);

            // verify pair exists
            const oiMapBefore = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(1);

            const ioMapBefore = orderManager.ioPairMap.get(orderbook1);
            expect(ioMapBefore?.get(tkn2)?.get(tkn1)).toHaveLength(1);

            // delete pair
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, false);
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, true);

            // verify pair is deleted
            const oiMapAfter = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapAfter?.get(tkn1)?.get(tkn2)).toBeUndefined();
            expect(oiMapAfter?.get(tkn1)).toBeUndefined();
            expect(oiMapAfter?.size).toBe(0);

            const ioMapAfter = orderManager.ioPairMap.get(orderbook1);
            expect(ioMapAfter?.get(tkn2)?.get(tkn1)).toBeUndefined();
            expect(ioMapAfter?.get(tkn2)).toBeUndefined();
            expect(ioMapAfter?.size).toBe(0);
        });

        it("should only remove specific order from list when multiple orders exist for same pair", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook1, hash2, tkn1, tkn2);

            // add two pairs with same tokens but different order hashes
            orderManager.addToPairMap(pairs1, false);
            orderManager.addToPairMap(pairs2, false);

            // verify both pairs exist
            const oiMapBefore = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(2);

            // delete only the first order
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, false);

            // verify only one pair remains
            const oiMapAfter = orderManager.oiPairMap.get(orderbook1);
            const remainingPairs = oiMapAfter?.get(tkn1)?.get(tkn2);
            expect(remainingPairs).toHaveLength(1);
            expect(remainingPairs![0].takeOrder.id).toBe(hash2);
        });

        it("should skip same token pairs during deletion", async () => {
            const pairs = [
                getPair(orderbook1, hash1, tkn1, tkn2), // different tokens
                getPair(orderbook1, hash1, tkn1, tkn1), // same tokens (should be skipped)
            ];

            // add pairs
            orderManager.addToPairMap(pairs[0], false);
            orderManager.addToPairMap(pairs[1], false);

            // verify only the different token pair exists (same token pairs are skipped in addToPairMap)
            const oiMapBefore = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(1);
            expect(oiMapBefore?.get(tkn1)?.get(tkn1)).toHaveLength(1);

            // delete the order
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, false);

            // verify the different token pair is deleted and tkn1/tkn1 still exists
            const oiMapAfter = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapAfter?.size).toBe(1);
            expect(oiMapAfter?.get(tkn1)?.get(tkn1)).toBeDefined();
        });

        it("should not affect other orderbooks when deleting from one", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook2, hash2, tkn1, tkn2);

            // add pairs to both orderbooks
            orderManager.addToPairMap(pairs1, false);
            orderManager.addToPairMap(pairs2, false);

            // verify both orderbooks have pairs
            expect(orderManager.oiPairMap.get(orderbook1)?.get(tkn1)?.get(tkn2)).toHaveLength(1);
            expect(orderManager.oiPairMap.get(orderbook2)?.get(tkn1)?.get(tkn2)).toHaveLength(1);

            // delete from orderbook1 only
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, false);

            // verify orderbook1 is empty but orderbook2 still has pairs
            expect(orderManager.oiPairMap.get(orderbook1)?.size).toBe(0);
            expect(orderManager.oiPairMap.get(orderbook2)?.get(tkn1)?.get(tkn2)).toHaveLength(1);
        });

        it("should handle deletion from non-existent orderbook gracefully", async () => {
            // Should not throw error when deleting from non-existent orderbook
            expect(() => {
                orderManager.deleteFromPairMap("0xnonexistent", hash1, tkn1, tkn2, false);
            }).not.toThrow();
        });

        it("should handle deletion of non-existent order gracefully", async () => {
            const pairs = getPair(orderbook1, hash1, tkn1, tkn2);

            // add pair
            orderManager.addToPairMap(pairs, false);

            // Try to delete non-existent order
            orderManager.deleteFromPairMap(orderbook1, hash2, tkn1, tkn2, false);

            // verify original pair still exists
            const oiMap = orderManager.oiPairMap.get(orderbook1);
            expect(oiMap?.get(tkn1)?.get(tkn2)).toHaveLength(1);
            expect(oiMap?.get(tkn1)?.get(tkn2)![0].takeOrder.id).toBe(hash1);
        });

        it("should handle complex deletion scenario with mixed pairs", async () => {
            const pairs = [
                getPair(orderbook1, hash1, tkn1, tkn2),
                getPair(orderbook1, hash2, tkn1, tkn2), // Same pair, different order
                getPair(orderbook1, hash1, tkn1, tkn3), // Same output, different input
                getPair(orderbook1, hash3, tkn2, tkn1), // different output-input combination
            ];

            // add all pairs
            for (const pair of pairs) {
                orderManager.addToPairMap(pair, false);
            }

            // verify initial state
            const oiMapBefore = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(2); // hash1 and hash2
            expect(oiMapBefore?.get(tkn1)?.get(tkn3)).toHaveLength(1); // hash1
            expect(oiMapBefore?.get(tkn2)?.get(tkn1)).toHaveLength(1); // hash3

            // delete hash1 order (should affect tkn1->tkn2 and tkn1->tkn3)
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn2, false);
            orderManager.deleteFromPairMap(orderbook1, hash1, tkn1, tkn3, false);

            // verify final state
            const oiMapAfter = orderManager.oiPairMap.get(orderbook1);
            expect(oiMapAfter?.get(tkn1)?.get(tkn2)).toHaveLength(1); // Only hash2 remains
            expect(oiMapAfter?.get(tkn1)?.get(tkn2)![0].takeOrder.id).toBe(hash2);
            expect(oiMapAfter?.get(tkn1)?.get(tkn3)).toBeUndefined(); // hash1 removed, list deleted
            expect(oiMapAfter?.get(tkn2)?.get(tkn1)).toHaveLength(1); // hash3 unaffected
            expect(oiMapAfter?.get(tkn2)?.get(tkn1)![0].takeOrder.id).toBe(hash3);
        });
    });

    describe("Test sortPairList function", () => {
        it("should sort pairs correctly in descending order by ratio then by maxOutput", () => {
            const createPair = (quote?: { ratio: bigint; maxOutput: bigint }): any => ({
                takeOrder: { quote },
            });

            // create pairs with different combinations of quotes
            const pairs: any[] = [
                createPair(undefined), // no quote - should be last
                createPair({ ratio: 5n, maxOutput: 500n }), // lower ratio, lower maxOutput
                createPair({ ratio: 5n, maxOutput: 1000n }), // lower ratio, higher maxOutput
                createPair({ ratio: 10n, maxOutput: 200n }), // higher ratio, lower maxOutput
                createPair({ ratio: 10n, maxOutput: 800n }), // higher ratio, higher maxOutput
                createPair({ ratio: 20n, maxOutput: 300n }), // highest ratio, medium maxOutput
                createPair(undefined), // another no quote - should be last
            ];
            const sorted = [...pairs].sort(sortPairList);

            // expected order (descending by ratio, then descending by maxOutput for same ratios):
            // 1. ratio: 20n, maxOutput: 300n
            // 2. ratio: 10n, maxOutput: 800n
            // 3. ratio: 10n, maxOutput: 200n
            // 4. ratio: 5n, maxOutput: 1000n
            // 5. ratio: 5n, maxOutput: 500n
            // 6. undefined quote
            // 7. undefined quote

            expect(sorted[0].takeOrder.quote?.ratio).toBe(20n);
            expect(sorted[0].takeOrder.quote?.maxOutput).toBe(300n);

            expect(sorted[1].takeOrder.quote?.ratio).toBe(10n);
            expect(sorted[1].takeOrder.quote?.maxOutput).toBe(800n);

            expect(sorted[2].takeOrder.quote?.ratio).toBe(10n);
            expect(sorted[2].takeOrder.quote?.maxOutput).toBe(200n);

            expect(sorted[3].takeOrder.quote?.ratio).toBe(5n);
            expect(sorted[3].takeOrder.quote?.maxOutput).toBe(1000n);

            expect(sorted[4].takeOrder.quote?.ratio).toBe(5n);
            expect(sorted[4].takeOrder.quote?.maxOutput).toBe(500n);

            // Last two should have no quotes
            expect(sorted[5].takeOrder.quote).toBeUndefined();
            expect(sorted[6].takeOrder.quote).toBeUndefined();
        });
    });
});
