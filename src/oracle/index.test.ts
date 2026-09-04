import { Result } from "../common";
import { SharedState } from "../state";
import { fetchOracleContext } from "./index";
import { Order, Pair } from "../order/types";
import { fetchSignedContext } from "./fetch";
import { OracleError, OracleErrorType } from "./error";
import { assert, describe, it, expect, vi, beforeEach, Mock } from "vitest";

// Mock the fetchSignedContext function
vi.mock("./fetch", () => ({
    fetchSignedContext: vi.fn(),
}));

describe("fetchOracleContext", () => {
    let mockState: SharedState;
    let mockOrderDetails: Pair;

    const testOwner = "0x1234567890123456789012345678901234567890";

    beforeEach(() => {
        vi.clearAllMocks();
        mockState = {
            oracleHealth: new Map(),
            appOptions: {},
        } as SharedState;

        mockOrderDetails = {
            oracleUrl: "https://example.com",
            takeOrder: {
                id: "0xOrderHash",
                struct: {
                    order: {
                        type: Order.Type.V4,
                        owner: testOwner,
                    },
                    inputIOIndex: 0,
                    outputIOIndex: 0,
                    signedContext: [],
                },
            },
        } as any;
    });

    it("returns ok when no oracle URL is present", async () => {
        mockOrderDetails.oracleUrl = undefined;
        const result = await fetchOracleContext.call(mockState, mockOrderDetails);

        assert(result.isOk());
        expect(result.value).toBeUndefined();
        expect(fetchSignedContext as Mock).not.toHaveBeenCalled();
    });

    it("returns ok when Order V3", async () => {
        mockOrderDetails.takeOrder.struct.order.type = Order.Type.V3;
        const result = await fetchOracleContext.call(mockState, mockOrderDetails);

        assert(result.isOk());
        expect(result.value).toBeUndefined();
        expect(fetchSignedContext as Mock).not.toHaveBeenCalled();
    });

    it("returns correctly call fetchSignedContext when Order V4 when it returns error", async () => {
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchSignedContext as Mock).mockResolvedValueOnce(Result.err(error));
        const result = await fetchOracleContext.call(mockState, mockOrderDetails);

        assert(result.isErr());
        expect(result.error).toEqual(error);
        expect(fetchSignedContext as Mock).toHaveBeenNthCalledWith(
            1,
            mockOrderDetails.oracleUrl,
            {
                order: mockOrderDetails.takeOrder.struct.order,
                inputIOIndex: mockOrderDetails.takeOrder.struct.inputIOIndex,
                outputIOIndex: mockOrderDetails.takeOrder.struct.outputIOIndex,
                counterparty: "0x0000000000000000000000000000000000000000",
            },
            mockState.oracleHealth,
            false,
        );
    });

    it("returns correctly call fetchSignedContext when Order V4 when it returns ok", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: [
                "0x0000000000000000000000000000000000000000000000000000000000000001",
                "0x0000000000000000000000000000000000000000000000000000000000000002",
            ],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValueOnce(Result.ok(validSignedContext));
        const result = await fetchOracleContext.call(mockState, mockOrderDetails);

        assert(result.isOk());
        expect(result.value).toBeUndefined();
        expect(fetchSignedContext as Mock).toHaveBeenNthCalledWith(
            1,
            mockOrderDetails.oracleUrl,
            {
                order: mockOrderDetails.takeOrder.struct.order,
                inputIOIndex: mockOrderDetails.takeOrder.struct.inputIOIndex,
                outputIOIndex: mockOrderDetails.takeOrder.struct.outputIOIndex,
                counterparty: "0x0000000000000000000000000000000000000000",
            },
            mockState.oracleHealth,
            false,
        );
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("returns cached result for unchanged block number without refetching", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        // first call fetches and caches
        const result1 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result1.isOk());
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);

        // second call with same block number hits the cache
        mockOrderDetails.takeOrder.struct.signedContext = [];
        const result2 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result2.isOk());
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("caches independently per IO indexes of the same order", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        // first call for pair with IO indexes 0/0 fetches and caches
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);

        // same order hash with different IO indexes at same block fetches again
        mockOrderDetails.takeOrder.struct.inputIOIndex = 1;
        mockOrderDetails.takeOrder.struct.outputIOIndex = 2;
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);

        // both combinations now hit their own cache at the same block
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        mockOrderDetails.takeOrder.struct.inputIOIndex = 0;
        mockOrderDetails.takeOrder.struct.outputIOIndex = 0;
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
    });

    it("caches independently per oracle url for the same order pair", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        // first call for the pair on the first oracle fetches and caches
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);

        // same order pair and block number on another oracle url fetches again
        mockOrderDetails.oracleUrl = "https://other-oracle.example.com";
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);

        // both oracle urls now have their own cached entry at the same block
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        mockOrderDetails.oracleUrl = "https://example.com";
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
    });

    it("caches error results independently per IO indexes of the same order", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchSignedContext as Mock)
            .mockResolvedValueOnce(Result.err(error))
            .mockResolvedValueOnce(Result.ok(validSignedContext));

        // pair with IO indexes 0/0 fails and the error gets cached
        const result1 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result1.isErr());

        // pair with IO indexes 1/2 at the same block is not affected
        // by the cached error of the 0/0 pair and fetches successfully
        mockOrderDetails.takeOrder.struct.inputIOIndex = 1;
        mockOrderDetails.takeOrder.struct.outputIOIndex = 2;
        const result2 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result2.isOk());
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);

        // both pairs keep their own cached outcome at the same block
        const result3 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result3.isOk());
        mockOrderDetails.takeOrder.struct.inputIOIndex = 0;
        mockOrderDetails.takeOrder.struct.outputIOIndex = 0;
        const result4 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result4.isErr());
        expect(result4.error).toEqual(error);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
    });

    it("uses the same cache entry regardless of order hash and owner casing", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);

        // same order pair with different hash and owner casing hits the same cache entry
        mockOrderDetails.takeOrder.id = mockOrderDetails.takeOrder.id.toUpperCase();
        mockOrderDetails.takeOrder.struct.order.owner = testOwner.toUpperCase() as any;
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("overwrites the cached entry when block number changes", async () => {
        const oldSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xoldsignature",
        };
        const newSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x02"],
            signature: "0xnewsignature",
        };
        (fetchSignedContext as Mock)
            .mockResolvedValueOnce(Result.ok(oldSignedContext))
            .mockResolvedValueOnce(Result.ok(newSignedContext));

        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        await fetchOracleContext.call(mockState, mockOrderDetails, 101n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);

        // repeated call at the new block hits the overwritten cache entry
        // holding the new result, and the old block entry is gone entirely,
        // so calling with the old block number again fetches anew
        mockOrderDetails.takeOrder.struct.signedContext = [];
        await fetchOracleContext.call(mockState, mockOrderDetails, 101n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([newSignedContext]);
        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(3);
    });

    it("refetches at a new block after a cached error", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchSignedContext as Mock)
            .mockResolvedValueOnce(Result.err(error))
            .mockResolvedValueOnce(Result.ok(validSignedContext));

        const result1 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result1.isErr());

        // the cached error does not stick across blocks
        const result2 = await fetchOracleContext.call(mockState, mockOrderDetails, 101n);
        assert(result2.isOk());
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("fetches again when block number changes", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        await fetchOracleContext.call(mockState, mockOrderDetails, 101n);

        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
    });

    it("returns cached error for unchanged block number without refetching", async () => {
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchSignedContext as Mock).mockResolvedValue(Result.err(error));

        const result1 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result1.isErr());

        const result2 = await fetchOracleContext.call(mockState, mockOrderDetails, 100n);
        assert(result2.isErr());
        expect(result2.error).toEqual(error);
        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(1);
    });

    it("does not cache when block number is not provided", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        await fetchOracleContext.call(mockState, mockOrderDetails);
        await fetchOracleContext.call(mockState, mockOrderDetails);

        expect(fetchSignedContext as Mock).toHaveBeenCalledTimes(2);
        expect(mockState.oracleHealth.size).toBe(0);
    });

    it("passes max owner profile flag to fetchSignedContext", async () => {
        (mockState as any).appOptions = {
            ownerProfile: { [testOwner]: Number.MAX_SAFE_INTEGER },
        };
        (fetchSignedContext as Mock).mockResolvedValueOnce(
            Result.err(new OracleError("some error", OracleErrorType.FetchError)),
        );

        await fetchOracleContext.call(mockState, mockOrderDetails);

        expect(fetchSignedContext as Mock).toHaveBeenLastCalledWith(
            mockOrderDetails.oracleUrl,
            expect.any(Object),
            mockState.oracleHealth,
            true,
        );
    });
});
