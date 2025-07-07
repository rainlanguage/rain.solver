import { ONE18 } from "../../../math";
import { Pair } from "../../../order";
import { estimateProfit } from "./utils";
import { describe, it, expect } from "vitest";

const ONE17 = 10n ** 17n;
function makeOrderDetails(ratio: bigint) {
    return {
        takeOrders: [
            {
                quote: { ratio },
            },
        ],
    };
}
function makeCounterpartyOrder(ratio: bigint, maxOutput: bigint): Pair {
    return {
        takeOrder: {
            quote: {
                ratio,
                maxOutput,
            },
        },
    } as Pair;
}

describe("Test estimateProfit", () => {
    it("should calculate profit correctly for typical values", () => {
        const orderDetails = makeOrderDetails(2n * ONE18); // ratio = 2.0
        const inputToEthPrice = 1n * ONE18; // 1 ETH per input token
        const outputToEthPrice = 3n * ONE18; // 3 ETH per output token
        const counterpartyOrder = makeCounterpartyOrder(15n * ONE17, 5n * ONE18); // ratio = 1.5, maxOutput = 5
        const maxInput = 10n * ONE18; // 10 units

        // orderOutput = 10
        // orderInput = (10 * 2) / 1 = 20
        // opposingMaxInput = (10 * 2) / 1 = 20
        // opposingMaxIORatio = 1^2 / 2 = 0.5
        // Since opposingMaxIORatio (0.5) < counterpartyOrder.ratio (1.5), counterparty conditions not met
        // counterpartyInput = 0, counterpartyOutput = 0
        // outputProfit = ((10 - 0) * 3) / 1 = 30
        // inputProfit = ((0 - 20) * 1) / 1 = -20
        // total = 30 + (-20) = 10
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(10n * ONE18);
    });

    it("should handle zero ratio in order (maxUint256 case)", () => {
        const orderDetails = makeOrderDetails(0n); // ratio = 0
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 2n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 5n * ONE18); // ratio = 1.0, maxOutput = 5
        const maxInput = 10n * ONE18;

        // orderOutput = 10
        // orderInput = (10 * 0) / 1 = 0
        // opposingMaxInput = maxUint256 (since ratio is 0)
        // opposingMaxIORatio = maxUint256 (since ratio is 0)
        // Since opposingMaxIORatio (maxUint256) >= counterpartyOrder.ratio (1.0), counterparty conditions met
        // maxOut = min(maxUint256, 5) = 5
        // counterpartyOutput = 5
        // counterpartyInput = (5 * 1) / 1 = 5
        // outputProfit = ((10 - 5) * 2) / 1 = 10
        // inputProfit = ((5 - 0) * 1) / 1 = 5
        // total = 10 + 5 = 5
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(15n * ONE18);
    });

    it("should handle counterparty trade when opposing max input is limiting factor", () => {
        const orderDetails = makeOrderDetails(1n * ONE18); // ratio = 1.0
        const inputToEthPrice = 2n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20
        const maxInput = 10n * ONE18;

        // orderOutput = 10
        // orderInput = (10 * 1) / 1 = 10
        // opposingMaxInput = (10 * 1) / 1 = 10
        // opposingMaxIORatio = 1^2 / 1 = 1
        // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (0.5), counterparty conditions met
        // maxOut = min(10, 20) = 10 (opposingMaxInput is limiting)
        // counterpartyOutput = 10
        // counterpartyInput = (10 * 0.5) / 1 = 5
        // outputProfit = ((10 - 5) * 1) / 1 = 5
        // inputProfit = ((10 - 10) * 2) / 1 = 0
        // total = 5 + 0 = 5
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(5n * ONE18);
    });

    it("should handle counterparty trade when counterparty max output is limiting factor", () => {
        const orderDetails = makeOrderDetails(1n * ONE18); // ratio = 1.0
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 3n * ONE18); // ratio = 0.5, maxOutput = 3
        const maxInput = 10n * ONE18;

        // orderOutput = 10
        // orderInput = (10 * 1) / 1 = 10
        // opposingMaxInput = (10 * 1) / 1 = 10
        // opposingMaxIORatio = 1^2 / 1 = 1
        // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (0.5), counterparty conditions met
        // maxOut = min(10, 3) = 3 (counterparty maxOutput is limiting)
        // counterpartyOutput = 3
        // counterpartyInput = (3 * 0.5) / 1 = 1.5
        // outputProfit = 10 - (1.5 * 1) / 1 = 8.5
        // inputProfit = 3 - (10 * 1) / 1 = -7
        // total = 8.5 + (-7) = 1.5
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(15n * ONE17); // 1.5 * ONE18
    });

    it("should handle case when opposing max IO ratio is less than counterparty ratio", () => {
        const orderDetails = makeOrderDetails(4n * ONE18); // ratio = 4.0
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
        const maxInput = 5n * ONE18;

        // orderOutput = 5
        // orderInput = (5 * 4) / 1 = 20
        // opposingMaxInput = (5 * 4) / 1 = 20
        // opposingMaxIORatio = 1^2 / 4 = 0.25
        // Since opposingMaxIORatio (0.25) < counterpartyOrder.ratio (1.0), counterparty conditions NOT met
        // counterpartyInput = 0, counterpartyOutput = 0
        // outputProfit = 5 - (0 * 1) / 1 = 5
        // inputProfit = 0 - (20 * 1) / 1 = -20
        // total = 5 + (-20) = -15
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(-15n * ONE18);
    });

    it("should handle edge case with zero max input", () => {
        const orderDetails = makeOrderDetails(1n * ONE18);
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 10n * ONE18);
        const maxInput = 0n;

        // orderOutput = 0
        // orderInput = (0 * 1) / 1 = 0
        // opposingMaxInput = (0 * 1) / 1 = 0
        // opposingMaxIORatio = 1^2 / 1 = 1
        // Since opposingMaxIORatio (1.0) >= counterpartyOrder.ratio (1.0), counterparty conditions met
        // maxOut = min(0, 10) = 0
        // counterpartyOutput = 0, counterpartyInput = 0
        // outputProfit = 0 - (0 * 1) / 1 = 0
        // inputProfit = 0 - (0 * 1) / 1 = 0
        // total = 0
        const result = estimateProfit(
            orderDetails,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
            maxInput,
        );
        expect(result).toBe(0n);
    });
});
