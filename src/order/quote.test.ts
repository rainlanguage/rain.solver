import { PublicClient } from "viem";
import { quoteSingleOrder } from "./quote";
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
            takeOrders: [
                {
                    takeOrder: {},
                },
            ],
        };
    });

    it("should set quote on the takeOrder when data is returned", async () => {
        await quoteSingleOrder(orderDetails, client);

        expect(orderDetails.takeOrders[0].quote).toEqual({
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
