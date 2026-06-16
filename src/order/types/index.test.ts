import assert from "assert";
import { V3, PairV3 } from "./v3";
import { V4, PairV4 } from "./v4";
import {
    Order,
    Pair,
    TakeOrderDetails,
    TakeOrder,
    OrderProfile,
    TakeOrdersConfigType,
    OrderbookVersions,
} from "./index";
import { Result } from "../../common";
import { SgOrder } from "../../subgraph";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the V3 and V4 modules
vi.mock("./v3", () => ({
    V3: {
        tryFromBytes: vi.fn(),
    },
    PairV3: {
        fromArgs: vi.fn(),
    },
}));

vi.mock("./v4", () => ({
    V4: {
        tryFromBytes: vi.fn(),
    },
    PairV4: {
        fromArgs: vi.fn(),
    },
}));

describe("Order.tryFromBytes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should return V3 order when V3.tryFromBytes succeeds", () => {
        const orderBytes = "0xv3Order";
        const mockV3Order = {
            type: Order.Type.V3,
        };

        const v3Result = Result.ok(mockV3Order);
        (V3.tryFromBytes as any).mockReturnValue(v3Result);
        (V4.tryFromBytes as any).mockReturnValue(Result.err(new Error("V4 failed")));

        const result = Order.tryFromBytes(orderBytes);

        assert(result.isOk());
        expect(result.value).toBe(mockV3Order);
        expect(V3.tryFromBytes).toHaveBeenCalledWith(orderBytes);
        expect(V3.tryFromBytes).toHaveBeenCalledTimes(1);
        expect(V4.tryFromBytes).not.toHaveBeenCalled();
    });

    it("should return V4 order when V3 fails but V4 succeeds", () => {
        const orderBytes = "0xv4Order";
        const mockV4Order = {
            type: Order.Type.V4,
        };

        const v3Result = Result.err(new Error("V3 decode failed"));
        const v4Result = Result.ok(mockV4Order);
        (V3.tryFromBytes as any).mockReturnValue(v3Result);
        (V4.tryFromBytes as any).mockReturnValue(v4Result);

        const result = Order.tryFromBytes(orderBytes);

        assert(result.isOk());
        expect(result.value).toBe(mockV4Order);
        expect(V3.tryFromBytes).toHaveBeenCalledWith(orderBytes);
        expect(V4.tryFromBytes).toHaveBeenCalledWith(orderBytes);
        expect(V3.tryFromBytes).toHaveBeenCalledTimes(1);
        expect(V4.tryFromBytes).toHaveBeenCalledTimes(1);
    });

    it("should return error when both V3 and V4 fail", () => {
        const orderBytes = "0xinvalidbytes";
        const v3Error = new Error("V3 decode failed");
        const v4Error = new Error("V4 decode failed");

        (V3.tryFromBytes as any).mockReturnValue(Result.err(v3Error));
        (V4.tryFromBytes as any).mockReturnValue(Result.err(v4Error));

        const result = Order.tryFromBytes(orderBytes);

        assert(result.isErr());
        expect(result.error.message).toBe(
            "Failed to decode the given order bytes as OrderV3 and OrderV4",
        );
        expect(V3.tryFromBytes).toHaveBeenCalledWith(orderBytes);
        expect(V4.tryFromBytes).toHaveBeenCalledWith(orderBytes);
        expect(V3.tryFromBytes).toHaveBeenCalledTimes(1);
        expect(V4.tryFromBytes).toHaveBeenCalledTimes(1);
    });
});

describe("Pair.tryFromArgs", () => {
    let mockOrderHash: string;
    let mockOrderDetails: SgOrder;
    let mockInputIOIndex: number;
    let mockOutputIOIndex: number;
    let mockInputVaultMetadata: any;
    let mockOutputVaultMetadata: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup mock parameters
        mockOrderHash = "0xorderhash123";
        mockOrderDetails = {
            id: "order1",
            orderbook: "0xorderbook",
            owner: "0xowner",
        } as any as SgOrder;
        mockInputIOIndex = 0;
        mockOutputIOIndex = 1;
        mockInputVaultMetadata = {
            token: "0xinputtoken",
            symbol: "INPUT",
            decimals: 18,
            balance: "1000000000000000000",
        };
        mockOutputVaultMetadata = {
            token: "0xoutputtoken",
            symbol: "OUTPUT",
            decimals: 6,
            balance: "1000000",
        };
    });

    it("should call PairV3.fromArgs and return Ok result when orderStruct is V3", () => {
        const mockV3OrderStruct = {
            type: Order.Type.V3,
        } as Order;
        const mockV3Pair = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: mockV3OrderStruct,
                },
            },
        } as PairV3;
        (PairV3.fromArgs as any).mockReturnValue(mockV3Pair);

        const result = Pair.tryFromArgs(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );

        assert(result.isOk());
        expect(result.value).toBe(mockV3Pair);
        expect(PairV3.fromArgs).toHaveBeenCalledWith(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        expect(PairV3.fromArgs).toHaveBeenCalledTimes(1);
        expect(PairV4.fromArgs).not.toHaveBeenCalled();
    });

    it("should call PairV4.fromArgs and return result when orderStruct is V4", () => {
        const mockV4OrderStruct = {
            type: Order.Type.V4,
        } as Order;
        const mockV4Result = Result.ok({
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: mockV4OrderStruct,
                },
            },
        } as PairV4);
        (PairV4.fromArgs as any).mockReturnValue(mockV4Result);

        const result = Pair.tryFromArgs(
            mockOrderHash,
            mockV4OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );

        expect(result).toBe(mockV4Result);
        expect(PairV4.fromArgs).toHaveBeenCalledWith(
            mockOrderHash,
            mockV4OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        expect(PairV4.fromArgs).toHaveBeenCalledTimes(1);
        expect(PairV3.fromArgs).not.toHaveBeenCalled();
    });

    it("should return exact result from PairV4.fromArgs without modification", () => {
        const mockV4OrderStruct = {
            type: Order.Type.V4,
        } as Order;
        const expectedResult = Result.err(new Error("V4 fromArgs failed"));
        (PairV4.fromArgs as any).mockReturnValue(expectedResult);

        const result = Pair.tryFromArgs(
            mockOrderHash,
            mockV4OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        expect(result).toBe(expectedResult);
        assert(result.isErr());
    });
});

describe("TakeOrderDetails type guards", () => {
    const makeTakeOrderDetails = (type: Order.Type): any => ({
        id: "0xid",
        struct: {
            order: { type },
            inputIOIndex: 0,
            outputIOIndex: 1,
            signedContext: [],
        },
    });

    it("isV3 should be true only for V3 take order details", () => {
        expect(TakeOrderDetails.isV3(makeTakeOrderDetails(Order.Type.V3))).toBe(true);
        expect(TakeOrderDetails.isV3(makeTakeOrderDetails(Order.Type.V4))).toBe(false);
    });

    it("isV4 should be true only for V4 take order details", () => {
        expect(TakeOrderDetails.isV4(makeTakeOrderDetails(Order.Type.V4))).toBe(true);
        expect(TakeOrderDetails.isV4(makeTakeOrderDetails(Order.Type.V3))).toBe(false);
    });
});

describe("TakeOrder namespace", () => {
    const makeTakeOrder = (type: Order.Type, inputIOIndex: number, outputIOIndex: number): any => ({
        order: { type },
        inputIOIndex,
        outputIOIndex,
        signedContext: ["ctx"],
    });

    describe("getQuoteConfig", () => {
        it("should convert input/output IO indices to bigint without swapping them", () => {
            const takeOrder = makeTakeOrder(Order.Type.V4, 2, 5);
            const result = TakeOrder.getQuoteConfig(takeOrder);

            // exact computed values: indices coerced to bigint, preserving which is which
            expect(result.inputIOIndex).toBe(2n);
            expect(result.outputIOIndex).toBe(5n);
            expect(typeof result.inputIOIndex).toBe("bigint");
            expect(typeof result.outputIOIndex).toBe("bigint");
        });

        it("should preserve all other take order fields unchanged", () => {
            const takeOrder = makeTakeOrder(Order.Type.V3, 7, 3);
            const result = TakeOrder.getQuoteConfig(takeOrder);

            expect(result.order).toBe(takeOrder.order);
            expect(result.signedContext).toBe(takeOrder.signedContext);
            // distinct values prove input/output are not crossed over
            expect(result.inputIOIndex).toBe(7n);
            expect(result.outputIOIndex).toBe(3n);
        });
    });

    it("isV3 should be true only for V3 take orders", () => {
        expect(TakeOrder.isV3(makeTakeOrder(Order.Type.V3, 0, 0))).toBe(true);
        expect(TakeOrder.isV3(makeTakeOrder(Order.Type.V4, 0, 0))).toBe(false);
    });

    it("isV4 should be true only for V4 take orders", () => {
        expect(TakeOrder.isV4(makeTakeOrder(Order.Type.V4, 0, 0))).toBe(true);
        expect(TakeOrder.isV4(makeTakeOrder(Order.Type.V3, 0, 0))).toBe(false);
    });
});

describe("Pair type guards", () => {
    const makePair = (type: Order.Type, orderbookVersion: OrderbookVersions): any => ({
        orderbookVersion,
        takeOrder: {
            struct: {
                order: { type },
            },
        },
    });

    it("isV3 should be true only when order type is V3", () => {
        expect(Pair.isV3(makePair(Order.Type.V3, OrderbookVersions.V4))).toBe(true);
        expect(Pair.isV3(makePair(Order.Type.V4, OrderbookVersions.V5))).toBe(false);
        expect(Pair.isV3(makePair(Order.Type.V4, OrderbookVersions.V6))).toBe(false);
    });

    it("isV4OrderbookV5 requires both V4 order type AND V5 orderbook version", () => {
        // both conditions met
        expect(Pair.isV4OrderbookV5(makePair(Order.Type.V4, OrderbookVersions.V5))).toBe(true);
        // right type, wrong orderbook version
        expect(Pair.isV4OrderbookV5(makePair(Order.Type.V4, OrderbookVersions.V6))).toBe(false);
        expect(Pair.isV4OrderbookV5(makePair(Order.Type.V4, OrderbookVersions.V4))).toBe(false);
        // wrong type, right orderbook version
        expect(Pair.isV4OrderbookV5(makePair(Order.Type.V3, OrderbookVersions.V5))).toBe(false);
    });

    it("isV4OrderbookV6 requires both V4 order type AND V6 orderbook version", () => {
        // both conditions met
        expect(Pair.isV4OrderbookV6(makePair(Order.Type.V4, OrderbookVersions.V6))).toBe(true);
        // right type, wrong orderbook version
        expect(Pair.isV4OrderbookV6(makePair(Order.Type.V4, OrderbookVersions.V5))).toBe(false);
        expect(Pair.isV4OrderbookV6(makePair(Order.Type.V4, OrderbookVersions.V4))).toBe(false);
        // wrong type, right orderbook version
        expect(Pair.isV4OrderbookV6(makePair(Order.Type.V3, OrderbookVersions.V6))).toBe(false);
    });
});

describe("OrderProfile type guards", () => {
    const makeOrderProfile = (type: Order.Type): any => ({
        active: true,
        order: { type },
        takeOrders: [],
    });

    it("isV3 should be true only for V3 order profiles", () => {
        expect(OrderProfile.isV3(makeOrderProfile(Order.Type.V3))).toBe(true);
        expect(OrderProfile.isV3(makeOrderProfile(Order.Type.V4))).toBe(false);
    });

    it("isV4 should be true only for V4 order profiles", () => {
        expect(OrderProfile.isV4(makeOrderProfile(Order.Type.V4))).toBe(true);
        expect(OrderProfile.isV4(makeOrderProfile(Order.Type.V3))).toBe(false);
    });
});

describe("TakeOrdersConfigType type guards", () => {
    // V3 config: orders[0].order.type === V3
    const v3Config: any = {
        minimumInput: 0n,
        maximumInput: 0n,
        maximumIORatio: 0n,
        orders: [{ order: { type: Order.Type.V3 } }],
        data: "0x",
    };
    // V4 config (orderbook v5): V4 order type AND has "minimumInput"
    const v4Config: any = {
        minimumInput: "0x0",
        maximumInput: "0x0",
        maximumIORatio: "0x0",
        orders: [{ order: { type: Order.Type.V4 } }],
        data: "0x",
    };
    // V5 config (orderbook v6): V4 order type AND has "minimumIO"
    const v5Config: any = {
        minimumIO: "0x0",
        maximumIO: "0x0",
        maximumIORatio: "0x0",
        IOIsInput: true,
        orders: [{ order: { type: Order.Type.V4 } }],
        data: "0x",
    };

    it("isV3 should be true only when first order is V3", () => {
        expect(TakeOrdersConfigType.isV3(v3Config)).toBe(true);
        expect(TakeOrdersConfigType.isV3(v4Config)).toBe(false);
        expect(TakeOrdersConfigType.isV3(v5Config)).toBe(false);
    });

    it("isV4 requires first order V4 AND minimumInput field present", () => {
        expect(TakeOrdersConfigType.isV4(v4Config)).toBe(true);
        // V4 order type but with minimumIO (not minimumInput) => not V4
        expect(TakeOrdersConfigType.isV4(v5Config)).toBe(false);
        // has minimumInput but V3 order type => not V4
        expect(TakeOrdersConfigType.isV4(v3Config)).toBe(false);
    });

    it("isV5 requires first order V4 AND minimumIO field present", () => {
        expect(TakeOrdersConfigType.isV5(v5Config)).toBe(true);
        // V4 order type but with minimumInput (not minimumIO) => not V5
        expect(TakeOrdersConfigType.isV5(v4Config)).toBe(false);
        // V3 order type => not V5 even if it had minimumIO
        const v3WithMinimumIO: any = { ...v5Config, orders: [{ order: { type: Order.Type.V3 } }] };
        expect(TakeOrdersConfigType.isV5(v3WithMinimumIO)).toBe(false);
    });
});
