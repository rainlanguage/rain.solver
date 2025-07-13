import { ChainId } from "sushi";
import { PublicClient } from "viem";
import { BundledOrders } from "./types";
import { getQuoteGas, quoteSingleOrder } from "./quote";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
    decodeFunctionResult: vi.fn().mockReturnValue([null, 100n, 2n]),
}));

vi.mock("./types", () => ({
    TakeOrder: {
        getQuoteConfig: vi.fn().mockResolvedValue({}),
    },
}));

describe("Test quoteSingleOrder", () => {
    let orderDetails: any;
    const client = {
        call: vi.fn().mockResolvedValueOnce({ data: "0x" }),
    } as any as PublicClient;

    beforeEach(() => {
        orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                takeOrder: {},
            },
        };
    });

    it("should set quote on the takeOrder when data is returned", async () => {
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
});

describe("Test getQuoteGas", () => {
    it("should get quote gas", async function () {
        const limitGas = 1_000_000n;
        const arbitrumL1Gas = 2_000_000n;

        // mock order and bot config and viem client
        const orderDetails = {
            takeOrders: [{ takeOrder: {} }],
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
