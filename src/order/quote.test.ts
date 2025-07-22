import { ChainId } from "sushi";
import { BundledOrders, Pair } from "./types";
import { getQuoteGas, quoteSingleOrder } from "./quote";
import { decodeFunctionResult, PublicClient } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
    decodeFunctionResult: vi.fn(),
}));

vi.mock("./types", () => ({
    TakeOrder: {
        getQuoteConfig: vi.fn().mockResolvedValue({}),
    },
}));

describe("Test quoteSingleOrder", () => {
    let orderDetails: Pair;
    const client = {
        call: vi.fn().mockResolvedValue({ data: "0x" }),
    } as any as PublicClient;

    beforeEach(() => {
        vi.clearAllMocks();
        orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                struct: {},
            },
        } as any;
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xffffffee00000000000000000000000000000000000000000000000000000064",
            "0xffffffee00000000000000000000000000000000000000000000000000000002",
        ]);
        await quoteSingleOrder(orderDetails, client);

        expect(orderDetails.takeOrder.quote).toEqual({
            maxOutput: 100n,
            ratio: 2n,
        });
        expect(client.call).toHaveBeenCalled();
    });

    it("should reject if no data is returned", async () => {
        (client.call as Mock).mockResolvedValueOnce({ data: undefined });
        await expect(quoteSingleOrder(orderDetails, client)).rejects.toMatch(
            /Failed to quote order/,
        );
    });

    it("should reject if fails to parse maxoutput float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0xinvalid",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ]);
        await expect(quoteSingleOrder(orderDetails, client)).rejects.toContain(
            "Invalid hex string",
        );
    });

    it("should reject if fails to parse ratio float", async () => {
        (decodeFunctionResult as Mock).mockReturnValueOnce([
            true,
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0xinvalid",
        ]);
        await expect(quoteSingleOrder(orderDetails, client)).rejects.toContain(
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
