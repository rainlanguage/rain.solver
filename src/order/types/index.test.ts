import assert from "assert";
import { V3, PairV3 } from "./v3";
import { V4, PairV4 } from "./v4";
import { Order, Pair } from "./index";
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
