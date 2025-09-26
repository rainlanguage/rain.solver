import assert from "assert";
import { Order } from "./index";
import { V4, PairV4 } from "./v4";
import { SgOrder } from "../../subgraph";
import { decodeAbiParameters } from "viem";
import { normalizeFloat, Result } from "../../common";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    decodeAbiParameters: vi.fn(),
}));

vi.mock("../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    normalizeFloat: vi.fn((value) => value),
}));

describe("OrderV3.tryFromBytes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should return ok", () => {
        const decoded = [
            {
                owner: "0xowner",
                nonce: "0xnonce",
                evaluable: {
                    interpreter: "0xinterpreter",
                    store: "0xstore",
                    bytecode: "0xbytecode",
                },
                validInputs: [
                    {
                        token: "0xinputtoken",
                        vaultId: "0xinputvaultid",
                    },
                ],
                validOutputs: [
                    {
                        token: "0xoutputtoken",
                        vaultId: "0xoutputvaultid",
                    },
                ],
            },
        ];
        (decodeAbiParameters as Mock).mockReturnValue(decoded);
        const result = V4.tryFromBytes("0xorderBytes");
        assert(result.isOk());
        expect(result.value).toEqual({
            type: Order.Type.V4,
            ...decoded[0],
        });
    });

    it("should return error", () => {
        (decodeAbiParameters as Mock).mockImplementationOnce(() => {
            throw new Error("failed to decode");
        });
        const result = V4.tryFromBytes("0xorderBytes");
        assert(result.isErr());
        expect(result.error.message).toContain("failed to decode");
    });
});

describe("PairV4.fromArgs", () => {
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
            orderbook: { id: "0xorderbook" },
            owner: "0xowner",
        } as any as SgOrder;
        mockInputIOIndex = 0;
        mockOutputIOIndex = 1;
        mockInputVaultMetadata = {
            token: "0xinputtoken",
            symbol: "INPUT",
            decimals: 18,
            balance: "0x1234",
        };
        mockOutputVaultMetadata = {
            token: "0xoutputtoken",
            symbol: "OUTPUT",
            decimals: 6,
            balance: "0x5678",
        };
    });

    it("should return valid PairV4", () => {
        const mockV3OrderStruct = {
            type: Order.Type.V4,
        } as V4;
        (normalizeFloat as Mock).mockReturnValue(Result.ok(1000000000000000000n));
        const result = PairV4.fromArgs(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        expect(normalizeFloat).toHaveBeenCalledTimes(2);
        expect(normalizeFloat).toHaveBeenNthCalledWith(
            1,
            mockInputVaultMetadata.balance,
            mockInputVaultMetadata.decimals,
        );
        expect(normalizeFloat).toHaveBeenNthCalledWith(
            2,
            mockOutputVaultMetadata.balance,
            mockOutputVaultMetadata.decimals,
        );
        assert(result.isOk());
        expect(result.value).toEqual({
            orderbook: mockOrderDetails.orderbook.id.toLowerCase(),
            buyToken: mockInputVaultMetadata.token.toLowerCase(),
            buyTokenSymbol: mockInputVaultMetadata.symbol,
            buyTokenDecimals: mockInputVaultMetadata.decimals,
            buyTokenVaultBalance: 1000000000000000000n,
            sellToken: mockOutputVaultMetadata.token.toLowerCase(),
            sellTokenSymbol: mockOutputVaultMetadata.symbol,
            sellTokenDecimals: mockOutputVaultMetadata.decimals,
            sellTokenVaultBalance: 1000000000000000000n,
            takeOrder: {
                id: mockOrderHash,
                struct: {
                    order: mockV3OrderStruct,
                    inputIOIndex: mockInputIOIndex,
                    outputIOIndex: mockOutputIOIndex,
                    signedContext: [],
                },
            },
        });
    });

    it("should return error when normalizeFloat fails once", () => {
        const mockV3OrderStruct = {
            type: Order.Type.V4,
        } as V4;
        (normalizeFloat as Mock).mockReturnValueOnce(
            Result.err({ readableMsg: " failed to normalize" }),
        );
        const result = PairV4.fromArgs(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        assert(result.isErr());
        expect(result.error.readableMsg).toContain("failed to normalize");
    });

    it("should return error when normalizeFloat fails twice", () => {
        const mockV3OrderStruct = {
            type: Order.Type.V4,
        } as V4;
        (normalizeFloat as Mock)
            .mockReturnValueOnce(Result.ok(1000000000000000000n))
            .mockReturnValueOnce(Result.err({ readableMsg: " failed to normalize" }));
        const result = PairV4.fromArgs(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        assert(result.isErr());
        expect(result.error.readableMsg).toContain("failed to normalize");
    });
});
