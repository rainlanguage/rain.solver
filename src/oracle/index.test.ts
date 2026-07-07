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

    beforeEach(() => {
        mockState = {
            oracleHealth: new Map(),
        } as SharedState;

        mockOrderDetails = {
            oracleUrl: "https://example.com",
            takeOrder: {
                struct: {
                    order: {
                        type: Order.Type.V4,
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
        );
        expect(mockOrderDetails.takeOrder.struct.signedContext).toEqual([validSignedContext]);
    });

    it("passes the counterparty address to fetchSignedContext when provided", async () => {
        const counterparty = "0x00000000000000000000000000000000000000ab" as const;
        (fetchSignedContext as Mock).mockResolvedValueOnce(
            Result.ok({
                signer: "0x000000000000000000000000abcdef1234567890",
                context: ["0x01"],
                signature: "0xsignature",
            }),
        );

        const result = await fetchOracleContext.call(mockState, mockOrderDetails, counterparty);

        assert(result.isOk());
        expect(fetchSignedContext as Mock).toHaveBeenCalledWith(
            mockOrderDetails.oracleUrl,
            expect.objectContaining({ counterparty }),
            mockState.oracleHealth,
        );
    });
});
