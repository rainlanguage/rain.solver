import { ONE18 } from "../../../math";
import { estimateProfit } from "./utils";
import { describe, it, expect } from "vitest";
import { BundledOrders, TakeOrderDetails } from "../../../order";

const ONE17 = 10n ** 17n;
function makeOrderPairObject(ratio: bigint, maxOutput: bigint): BundledOrders {
    return {
        takeOrders: [
            {
                quote: {
                    ratio,
                    maxOutput,
                },
            },
        ],
    } as BundledOrders;
}
function makeCounterpartyOrder(ratio: bigint, maxOutput: bigint): TakeOrderDetails {
    return {
        quote: {
            ratio,
            maxOutput,
        },
    } as TakeOrderDetails;
}

describe("Test estimateProfit", () => {
    it("should calculate profit correctly when both orders can be filled completely", () => {
        const orderPairObject = makeOrderPairObject(2n * ONE18, 10n * ONE18); // ratio = 2.0, maxOutput = 10
        const inputToEthPrice = 1n * ONE18; // 1 ETH per input token
        const outputToEthPrice = 3n * ONE18; // 3 ETH per output token
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20

        // orderMaxInput = (10 * 2) / 1 = 20
        // opposingMaxInput = (20 * 0.5) / 1 = 10
        // orderOutput = min(10, 10) = 10
        // orderInput = (10 * 2) / 1 = 20
        // opposingOutput = min(20, 20) = 20
        // opposingInput = (20 * 0.5) / 1 = 10
        // outputProfit = max(0, 10 - 10) = 0, in ETH = 0
        // inputProfit = max(0, 20 - 20) = 0, in ETH = 0
        // total = 0 + 0 = 0
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(0n);
    });

    it("should calculate profit when order output is limited by opposing max input", () => {
        const orderPairObject = makeOrderPairObject(1n * ONE18, 15n * ONE18); // ratio = 1.0, maxOutput = 15
        const inputToEthPrice = 2n * ONE18;
        const outputToEthPrice = 3n * ONE18; // Changed from 1n to 3n
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio 0.5

        // orderMaxInput = (15 * 1) / 1 = 15
        // opposingMaxInput = (20 * 0.5) / 1 = 10
        // orderOutput = min(15, 10) = 10
        // orderInput = (10 * 1) / 1 = 10
        // opposingOutput = min(15, 20) = 15
        // opposingInput = (15 * 0.5) / 1 = 7.5
        // outputProfit = max(0, 10 - 7.5) = 2.5, in ETH = 2.5 * 3 = 7.5
        // inputProfit = max(0, 15 - 10) = 5, in ETH = 5 * 2 = 10
        // total = 7.5 + 10 = 17.5
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(175n * ONE17); // 17.5 * ONE18
    });

    it("should calculate profit when opposing output is limited by order max input", () => {
        const orderPairObject = makeOrderPairObject(15n * ONE17, 8n * ONE18); // ratio 1.5, maxOutput = 8
        const inputToEthPrice = 2n * ONE18; // Changed from 1n to 2n
        const outputToEthPrice = 4n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 20n * ONE18); // ratio 0.5

        // orderMaxInput = (8 * 1.5) / 1 = 12
        // opposingMaxInput = (20 * 0.5) / 1 = 10
        // orderOutput = min(8, 10) = 8
        // orderInput = (8 * 1.5) / 1 = 12
        // opposingOutput = min(12, 20) = 12
        // opposingInput = (12 * 0.5) / 1 = 6
        // outputProfit = max(0, 8 - 6) = 2, in ETH = 2 * 4 = 8
        // inputProfit = max(0, 12 - 12) = 0
        // total = 8 + 0 = 8
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(8n * ONE18);
    });

    it("should calculate profit when opposing output is limited by counterparty max output", () => {
        const orderPairObject = makeOrderPairObject(1n * ONE18, 8n * ONE18); // ratio = 1.0, maxOutput = 8
        const inputToEthPrice = 2n * ONE18;
        const outputToEthPrice = 3n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 5n * ONE18); // ratio = 0.5, maxOutput = 5

        // orderMaxInput = (8 * 1) / 1 = 8
        // opposingMaxInput = (5 * 0.5) / 1 = 2.5
        // orderOutput = min(8, 2.5) = 2.5
        // orderInput = (2.5 * 1) / 1 = 2.5
        // opposingOutput = min(8, 5) = 5
        // opposingInput = (5 * 0.5) / 1 = 2.5
        // outputProfit = max(0, 2.5 - 2.5) = 0
        // inputProfit = max(0, 5 - 2.5) = 2.5, in ETH = 2.5 * 2 = 5
        // total = 0 + 5 = 5
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(5n * ONE18);
    });

    it("should handle counterparty order with zero ratio", () => {
        const orderPairObject = makeOrderPairObject(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 2n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(0n, 15n * ONE18); // ratio = 0, maxOutput = 15

        // When counterparty ratio is 0:
        // orderOutput = 10 (orderPairObject maxOutput)
        // orderInput = (10 * 1) / 1 = 10
        // opposingOutput = 15 (counterparty maxOutput)
        // opposingInput = (15 * 0) / 1 = 0
        // outputProfit = max(0, 10 - 0) = 10, in ETH = 10 * 2 = 20
        // inputProfit = max(0, 15 - 10) = 5, in ETH = 5 * 1 = 5
        // total = 20 + 5 = 25
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(25n * ONE18);
    });

    it("should handle order pair object with zero ratio", () => {
        const orderPairObject = makeOrderPairObject(0n, 12n * ONE18); // ratio = 0, maxOutput = 12
        const inputToEthPrice = 3n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 8n * ONE18); // ratio = 1.0, maxOutput = 8

        // orderMaxInput = (12 * 0) / 1 = 0
        // opposingMaxInput = (8 * 1) / 1 = 8
        // orderOutput = min(12, 8) = 8
        // orderInput = (8 * 0) / 1 = 0
        // opposingOutput = min(0, 8) = 0
        // opposingInput = (0 * 1) / 1 = 0
        // outputProfit = max(0, 8 - 0) = 8, in ETH = 8 * 1 = 8
        // inputProfit = max(0, 0 - 0) = 0
        // total = 8 + 0 = 8
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(8n * ONE18);
    });

    it("should handle both orders with zero ratio", () => {
        const orderPairObject = makeOrderPairObject(0n, 6n * ONE18); // ratio = 0, maxOutput = 6
        const inputToEthPrice = 2n * ONE18;
        const outputToEthPrice = 3n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(0n, 4n * ONE18); // ratio = 0, maxOutput = 4

        // When both ratios are 0:
        // orderOutput = 6 (orderPairObject maxOutput)
        // orderInput = (6 * 0) / 1 = 0
        // opposingOutput = 4 (counterparty maxOutput)
        // opposingInput = (4 * 0) / 1 = 0
        // outputProfit = max(0, 6 - 0) = 6, in ETH = 6 * 3 = 18
        // inputProfit = max(0, 4 - 0) = 4, in ETH = 4 * 2 = 8
        // total = 18 + 8 = 26
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(26n * ONE18);
    });

    it("should handle edge case with zero max outputs", () => {
        const orderPairObject = makeOrderPairObject(1n * ONE18, 0n); // maxOutput = 0
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 1n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(1n * ONE18, 0n); // maxOutput = 0

        // orderMaxInput = (0 * 1) / 1 = 0
        // opposingMaxInput = (0 * 1) / 1 = 0
        // orderOutput = min(0, 0) = 0
        // orderInput = (0 * 1) / 1 = 0
        // opposingOutput = min(0, 0) = 0
        // opposingInput = (0 * 1) / 1 = 0
        // outputProfit = max(0, 0 - 0) = 0
        // inputProfit = max(0, 0 - 0) = 0
        // total = 0
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(0n);
    });

    it("should calculate profit when there is clear arbitrage opportunity", () => {
        const orderPairObject = makeOrderPairObject(5n * ONE17, 20n * ONE18); // ratio = 0.5, maxOutput = 20
        const inputToEthPrice = 2n * ONE18; // Changed from 1n to 2n
        const outputToEthPrice = 3n * ONE18; // Changed from 1n to 3n
        const counterpartyOrder = makeCounterpartyOrder(15n * ONE17, 8n * ONE18); // ratio 1.5, maxOutput 8

        // orderMaxInput = (20 * 0.5) / 1 = 10
        // opposingMaxInput = (8 * 1.5) / 1 = 12
        // orderOutput = min(20, 12) = 12
        // orderInput = (12 * 0.5) / 1 = 6
        // opposingOutput = min(10, 8) = 8
        // opposingInput = (8 * 1.5) / 1 = 12
        // outputProfit = max(0, 12 - 12) = 0
        // inputProfit = max(0, 8 - 6) = 2, in ETH = 2 * 2 = 4
        // total = 0 + 4 = 4
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(4n * ONE18);
    });

    it("should handle asymmetric price ratios with profit", () => {
        const orderPairObject = makeOrderPairObject(1n * ONE18, 10n * ONE18); // ratio = 1.0, maxOutput = 10
        const inputToEthPrice = 1n * ONE18;
        const outputToEthPrice = 2n * ONE18;
        const counterpartyOrder = makeCounterpartyOrder(5n * ONE17, 15n * ONE18); // ratio = 0.5, maxOutput = 15

        // orderMaxInput = (10 * 1) / 1 = 10
        // opposingMaxInput = (15 * 0.5) / 1 = 7.5
        // orderOutput = min(10, 7.5) = 7.5
        // orderInput = (7.5 * 1) / 1 = 7.5
        // opposingOutput = min(10, 15) = 10
        // opposingInput = (10 * 0.5) / 1 = 5
        // outputProfit = max(0, 7.5 - 5) = 2.5, in ETH = 2.5 * 2 = 5
        // inputProfit = max(0, 10 - 7.5) = 2.5, in ETH = 2.5 * 1 = 2.5
        // total = 5 + 2.5 = 7.5
        const result = estimateProfit(
            orderPairObject,
            inputToEthPrice,
            outputToEthPrice,
            counterpartyOrder,
        );
        expect(result).toBe(75n * ONE17); // 7.5 * ONE18
    });
});
