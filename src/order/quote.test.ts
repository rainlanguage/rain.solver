import { ChainId } from "sushi";
import { BundledOrders, Order, Pair } from "./types";
import { decodeFunctionResult, PublicClient } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { getQuoteGas, quoteSingleOrder, quoteSingleOrderV3, quoteSingleOrderV4 } from "./quote";

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
    const client = {
        call: vi.fn().mockResolvedValue({ data: "0x" }),
    } as any as PublicClient;

    beforeEach(() => {
        vi.clearAllMocks();
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
        await quoteSingleOrder(orderDetails, client);

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(client.call).toHaveBeenCalled();
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
        await quoteSingleOrder(orderDetails, client);

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(client.call).toHaveBeenCalled();
    });
});

describe("Test quoteSingleOrderV3", () => {
    let orderDetails: Pair;
    const client = {
        call: vi.fn().mockResolvedValueOnce({ data: "0x" }),
    } as any as PublicClient;

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
        await quoteSingleOrderV3(orderDetails, client);

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(client.call).toHaveBeenCalled();
    });

    it("should reject if no data is returned", async () => {
        (client.call as Mock).mockResolvedValueOnce({ data: undefined });
        await expect(quoteSingleOrderV3(orderDetails, client)).rejects.toMatch(
            /Failed to quote order/,
        );
    });
});

describe("Test quoteSingleOrderV4", () => {
    let orderDetails: Pair;
    const client = {
        call: vi.fn().mockResolvedValue({ data: "0x" }),
    } as any as PublicClient;

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
        await quoteSingleOrderV4(orderDetails, client);

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(client.call).toHaveBeenCalled();
    });

    it("should reject if no data is returned", async () => {
        (client.call as Mock).mockResolvedValueOnce({ data: undefined });
        await expect(quoteSingleOrderV4(orderDetails, client)).rejects.toMatch(
            /Failed to quote order/,
        );
    });

    it("should reject if fails to parse maxoutput float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xinvalid",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ]);
        await expect(quoteSingleOrderV4(orderDetails, client)).rejects.toContain(
            "Invalid hex string",
        );
    });

    it("should reject if fails to parse ratio float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0xinvalid",
        ]);
        await expect(quoteSingleOrderV4(orderDetails, client)).rejects.toContain(
            "Invalid hex string",
        );
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
