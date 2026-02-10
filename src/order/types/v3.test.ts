import assert from "assert";
import { Order, OrderbookVersions } from "./index";
import { V3, PairV3 } from "./v3";
import { SgOrder } from "../../subgraph";
import { decodeAbiParameters } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    decodeAbiParameters: vi.fn(),
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
                        decimals: 18,
                        vaultId: 1n,
                    },
                ],
                validOutputs: [
                    {
                        token: "0xoutputtoken",
                        decimals: 18,
                        vaultId: 1n,
                    },
                ],
            },
        ];
        (decodeAbiParameters as Mock).mockReturnValue(decoded);
        const result = V3.tryFromBytes("0xorderBytes");
        assert(result.isOk());
        expect(result.value).toEqual({
            type: Order.Type.V3,
            ...decoded[0],
        });
    });

    it("should return error", () => {
        (decodeAbiParameters as Mock).mockImplementationOnce(() => {
            throw new Error("failed to decode");
        });
        const result = V3.tryFromBytes("0xorderBytes");
        assert(result.isErr());
        expect(result.error.message).toContain("failed to decode");
    });
});

describe("PairV3.fromArgs", () => {
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
            balance: "1000000000000000000",
        };
        mockOutputVaultMetadata = {
            token: "0xoutputtoken",
            symbol: "OUTPUT",
            decimals: 6,
            balance: "1000000",
        };
    });

    it("should return valid PairV3", () => {
        const mockV3OrderStruct = {
            type: Order.Type.V3,
        } as V3;
        const result = PairV3.fromArgs(
            mockOrderHash,
            mockV3OrderStruct,
            mockOrderDetails,
            mockInputIOIndex,
            mockOutputIOIndex,
            mockInputVaultMetadata,
            mockOutputVaultMetadata,
        );
        expect(result).toEqual({
            orderbookVersion: OrderbookVersions.V4,
            orderbook: mockOrderDetails.orderbook.id.toLowerCase(),
            buyToken: mockInputVaultMetadata.token.toLowerCase(),
            buyTokenSymbol: mockInputVaultMetadata.symbol,
            buyTokenDecimals: mockInputVaultMetadata.decimals,
            buyTokenVaultBalance: BigInt(mockInputVaultMetadata.balance),
            sellToken: mockOutputVaultMetadata.token.toLowerCase(),
            sellTokenSymbol: mockOutputVaultMetadata.symbol,
            sellTokenDecimals: mockOutputVaultMetadata.decimals,
            sellTokenVaultBalance: BigInt(mockOutputVaultMetadata.balance),
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
});
