import { ChainId } from "sushi";
import { Result } from "../common";
import { SharedState } from "../state";
import { OrderSpanEvents } from "../core/types";
import { Attributes } from "@opentelemetry/api";
import { fetchOracleContext } from "../oracle";
import { OracleError, OracleErrorType } from "../oracle/error";
import { BundledOrders, Order, Pair } from "./types";
import { decodeFunctionResult, PublicClient } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import {
    getQuoteGas,
    quoteSingleOrder,
    quoteSingleOrderV3,
    quoteSingleOrderV4,
    fetchOracleContextWithSpan,
} from "./quote";

vi.mock("../oracle", () => ({
    fetchOracleContext: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
    decodeFunctionResult: vi.fn().mockReturnValue([null, 100n, 2n]),
}));

vi.mock("./types", async (importOriginal) => ({
    ...(await importOriginal()),
    TakeOrder: {
        getQuoteConfig: vi.fn().mockResolvedValue({}),
    },
}));

describe("Test quoteSingleOrder", () => {
    const state = {
        client: {
            call: vi.fn().mockResolvedValue({ data: "0x" }),
        } as any as PublicClient,
    } as any as SharedState;

    beforeEach(() => {
        vi.clearAllMocks();
        (fetchOracleContext as Mock).mockResolvedValue(Result.ok(undefined));
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        const orderDetails: Pair = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: { type: Order.Type.V3 },
                },
            },
        } as any;
        await quoteSingleOrder(orderDetails, state, {}, {});

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(state.client.call).toHaveBeenCalled();
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xffffffee00000000000000000000000000000000000000000000000000000064",
            "0xffffffee00000000000000000000000000000000000000000000000000000002",
        ]);
        const orderDetails: Pair = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: { type: Order.Type.V4 },
                },
            },
        } as any;
        await quoteSingleOrder(orderDetails, state, {}, {});

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(state.client.call).toHaveBeenCalled();
    });
});

describe("Test quoteSingleOrderV3", () => {
    let orderDetails: Pair;
    const state = {
        client: {
            call: vi.fn().mockResolvedValue({ data: "0x" }),
        } as any as PublicClient,
    } as any as SharedState;

    beforeEach(() => {
        vi.clearAllMocks();
        orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: { type: Order.Type.V3 },
                },
            },
        } as any;
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        await quoteSingleOrderV3(orderDetails, state, {}, {});

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(state.client.call).toHaveBeenCalled();
    });

    it("should reject if no data is returned", async () => {
        (state.client.call as Mock).mockResolvedValueOnce({ data: undefined });
        await expect(quoteSingleOrderV3(orderDetails, state, {}, {})).rejects.toMatch(
            /Failed to quote order/,
        );
    });
});

describe("Test quoteSingleOrderV4", () => {
    let orderDetails: Pair;
    const state = {
        client: {
            call: vi.fn().mockResolvedValue({ data: "0x" }),
        } as any as PublicClient,
    } as any as SharedState;

    beforeEach(() => {
        vi.clearAllMocks();
        orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {
                    order: { type: Order.Type.V4 },
                },
            },
        } as any;
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xffffffee00000000000000000000000000000000000000000000000000000064",
            "0xffffffee00000000000000000000000000000000000000000000000000000002",
        ]);
        await quoteSingleOrderV4(orderDetails, state, {}, {});

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(state.client.call).toHaveBeenCalled();
    });

    it("should reject if no data is returned", async () => {
        (state.client.call as Mock).mockResolvedValueOnce({ data: undefined });
        await expect(quoteSingleOrderV4(orderDetails, state, {}, {})).rejects.toMatch(
            /Failed to quote order/,
        );
    });

    it("should reject if fails to parse maxoutput float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xinvalid",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ]);
        await expect(quoteSingleOrderV4(orderDetails, state, {}, {})).rejects.toContain(
            "Invalid hex string",
        );
    });

    it("should reject if fails to parse ratio float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0xinvalid",
        ]);
        await expect(quoteSingleOrderV4(orderDetails, state, {}, {})).rejects.toContain(
            "Invalid hex string",
        );
    });

    it("should record the used rpc url in span attributes when the quote call fails", async () => {
        const spanAttributes: Attributes = {};
        const error = new Error("execution reverted: InvalidSignature");
        (state.client.call as Mock).mockRejectedValueOnce(error);
        (state as any).rpc = { lastUsedUrl: "https://rpc.example.com" };
        orderDetails.takeOrder.quote = { maxOutput: 1n, ratio: 1n };

        await expect(quoteSingleOrderV4(orderDetails, state, spanAttributes, {})).rejects.toBe(
            error,
        );

        expect(orderDetails.takeOrder.quote).toBeUndefined();
        expect(spanAttributes["details.oracle.quoteRpcUrl"]).toBe("https://rpc.example.com");
    });
});

describe("Test fetchOracleContextWithSpan", () => {
    let orderDetails: Pair;
    let spanAttributes: Attributes;
    let spanEvents: OrderSpanEvents;
    const state = {} as any as SharedState;
    const validSignedContext = {
        signer: "0x000000000000000000000000abcdef1234567890",
        context: ["0x01", "0x02"],
        signature: "0xsignature",
    };

    beforeEach(() => {
        vi.clearAllMocks();
        spanAttributes = {};
        spanEvents = {};
        orderDetails = {
            orderbook: "0xorderbook",
            oracleUrl: "https://oracle.example.com",
            takeOrder: {
                struct: {
                    order: { type: Order.Type.V4 },
                },
            },
        } as any;
    });

    it("should record fetch event and new signed context on success", async () => {
        (fetchOracleContext as Mock).mockImplementationOnce(async function (details: Pair) {
            details.takeOrder.struct.signedContext = [validSignedContext];
            return Result.ok(undefined);
        });

        await fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents);

        expect(fetchOracleContext).toHaveBeenCalledWith(orderDetails, spanAttributes);
        expect(spanEvents["oracleFetch"]).toEqual({
            startTime: expect.any(Number),
            duration: expect.any(Number),
        });
        expect(spanAttributes["events.duration.oracleFetch"]).toBeTypeOf("number");
        expect(spanAttributes["details.oracle.new"]).toBe(JSON.stringify([validSignedContext]));
    });

    it("should record fetch event and rethrow the oracle error on failure", async () => {
        const error = new OracleError("some error", OracleErrorType.FetchError);
        (fetchOracleContext as Mock).mockResolvedValueOnce(Result.err(error));

        await expect(
            fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents),
        ).rejects.toBe(error);

        expect(spanEvents["oracleFetch"]).toEqual({
            startTime: expect.any(Number),
            duration: expect.any(Number),
        });
        expect(spanAttributes["events.duration.oracleFetch"]).toBeTypeOf("number");
        expect(spanAttributes["details.oracle.new"]).toBeUndefined();
    });

    it("should record N/A as new signed context when none is set after fetch", async () => {
        (fetchOracleContext as Mock).mockResolvedValueOnce(Result.ok(undefined));

        await fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents);

        expect(spanAttributes["details.oracle.new"]).toBe("N/A");
    });

    it("should not record anything for orders without oracle url", async () => {
        orderDetails.oracleUrl = undefined;
        (fetchOracleContext as Mock).mockResolvedValueOnce(Result.ok(undefined));

        await fetchOracleContextWithSpan(orderDetails, state, spanAttributes, spanEvents);

        expect(fetchOracleContext).toHaveBeenCalledWith(orderDetails, spanAttributes);
        expect(spanEvents).toEqual({});
        expect(spanAttributes).toEqual({});
    });
});

describe("Test getQuoteGas", () => {
    it("should get quote gas", async function () {
        const limitGas = 1_000_000n;
        const arbitrumL1Gas = 2_000_000n;

        // mock order and bot config and viem client
        const orderDetails = {
            takeOrders: [{ struct: {} }],
        } as any as BundledOrders;
        const config = {
            chainConfig: {
                id: ChainId.ARBITRUM,
            },
            client: {
                simulateContract: async () => ({ result: [arbitrumL1Gas, 1_500_000n, 123_000n] }),
            },
        } as any;

        // arbitrum chain
        let result = await getQuoteGas(config, orderDetails, { quoteGas: limitGas } as any);
        expect(result).toEqual(limitGas + arbitrumL1Gas);

        // other chains
        config.chainConfig.id = 1;
        result = await getQuoteGas(config, orderDetails, { quoteGas: limitGas } as any);
        expect(result).toEqual(limitGas);
    });
});
