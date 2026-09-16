import { Result } from "../common";
import { SharedState } from "../state";
import { fetchOracleContext } from "./index";
import { Order, Pair } from "../order/types";
import { fetchSignedContext } from "./fetch";
import { Attributes } from "@opentelemetry/api";
import { OracleError, OracleErrorType } from "./error";
import { assert, describe, it, expect, vi, beforeEach, Mock } from "vitest";

// Mock the fetchSignedContext function
vi.mock("./fetch", () => ({
    fetchSignedContext: vi.fn(),
}));

describe("fetchOracleContext", () => {
    let mockState: SharedState;
    let mockOrderDetails: Pair;
    let spanAttributes: Attributes;

    const testOwner = "0x1234567890123456789012345678901234567890";

    beforeEach(() => {
        vi.clearAllMocks();
        spanAttributes = {};
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
        const result = await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

        assert(result.isOk());
        expect(result.value).toBeUndefined();
        expect(fetchSignedContext as Mock).not.toHaveBeenCalled();
    });

    it("returns ok when Order V3", async () => {
        mockOrderDetails.takeOrder.struct.order.type = Order.Type.V3;
        const result = await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

        assert(result.isOk());
        expect(result.value).toBeUndefined();
        expect(fetchSignedContext as Mock).not.toHaveBeenCalled();
    });

    it("returns correctly call fetchSignedContext when Order V4 when it returns error", async () => {
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchSignedContext as Mock).mockResolvedValueOnce(Result.err(error));
        const result = await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

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
            spanAttributes,
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
        const result = await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

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
            spanAttributes,
            false,
        );
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("fetches on every call without caching results", async () => {
        const validSignedContext = {
            signer: "0x000000000000000000000000abcdef1234567890",
            context: ["0x01"],
            signature: "0xsignature",
        };
        (fetchSignedContext as Mock).mockResolvedValue(Result.ok(validSignedContext));

        await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);
        await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

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

        await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

        expect(fetchSignedContext as Mock).toHaveBeenLastCalledWith(
            mockOrderDetails.oracleUrl,
            expect.any(Object),
            mockState.oracleHealth,
            spanAttributes,
            true,
        );
    });

    it("passes the same span attributes object through to fetchSignedContext", async () => {
        (fetchSignedContext as Mock).mockImplementationOnce(async (_url, _req, _map, attrs) => {
            attrs["details.oracle.rawResponse"] = "raw";
            return Result.err(new OracleError("some error", OracleErrorType.FetchError));
        });

        await fetchOracleContext.call(mockState, mockOrderDetails, spanAttributes);

        expect(spanAttributes["details.oracle.rawResponse"]).toBe("raw");
    });
});
