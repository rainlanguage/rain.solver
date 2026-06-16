import { parseUnits } from "viem";
import { estimateProfit } from "../../core/modes/raindex";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { RaindexRouteCmd, checkRaindexRoute, RaindexRouteLiveOptions } from "./raindex-route";

vi.mock("../../core/modes/raindex", () => ({
    estimateProfit: vi.fn(),
}));

describe("Test raindex-route cli options", () => {
    it("should get raindex-route cli options with all required parameters", () => {
        // overwrite the action for testing
        RaindexRouteCmd.action(function () {});

        const expected: Record<string, any> = {
            orderInMax: "100",
            orderInRatio: "2",
            orderInInputToEthPrice: "1.5",
            orderInOutputToEthPrice: "2.5",
            orderOutMax: "200",
            orderOutRatio: "0.5",
            externalRoutePrice: "1.1",
        };

        const result = RaindexRouteCmd.parse([
            "",
            "",
            "--order-in-max",
            "100",
            "--order-in-ratio",
            "2",
            "--order-in-input-to-eth-price",
            "1.5",
            "--order-in-output-to-eth-price",
            "2.5",
            "--order-out-max",
            "200",
            "--order-out-ratio",
            "0.5",
            "--external-route-price",
            "1.1",
        ]).opts();

        expect(result).toEqual(expected);
    });
});

describe("Test checkRaindexRoute", () => {
    const mockOptions: RaindexRouteLiveOptions = {
        orderInMax: "100",
        orderInRatio: "2",
        orderInInputToEthPrice: "1.5",
        orderInOutputToEthPrice: "2.5",
        orderOutMax: "200",
        orderOutRatio: "0.5",
        externalRoutePrice: "1.1",
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should call estimateProfit with correct parameters", async () => {
        const mockProfit = parseUnits("50", 18);
        (estimateProfit as Mock).mockReturnValue({
            profit: mockProfit,
            counterpartyInputToEthPrice: parseUnits("1.5", 18),
            counterpartyOutputToEthPrice: parseUnits("2.5", 18),
        });

        await checkRaindexRoute(mockOptions);

        expect(estimateProfit).toHaveBeenCalledTimes(1);
        expect(estimateProfit).toHaveBeenCalledWith(
            {
                takeOrder: {
                    quote: {
                        maxOutput: parseUnits("100", 18),
                        ratio: parseUnits("2", 18),
                    },
                },
            },
            {
                takeOrder: {
                    quote: {
                        maxOutput: parseUnits("200", 18),
                        ratio: parseUnits("0.5", 18),
                    },
                },
            },
            {
                price: parseUnits("1.1", 18),
            },
            "1.5",
            "2.5",
        );
    });
});
