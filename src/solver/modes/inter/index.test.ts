import { RainSolver } from "../..";
import { Result } from "../../../result";
import { trySimulateTrade } from "./simulate";
import { SimulationResult } from "../../types";
import { BundledOrders } from "../../../order";
import { RainSolverSigner } from "../../../signer";
import { findBestInterOrderbookTrade } from "./index";
import { extendObjectWithHeader } from "../../../logger";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("./simulate", () => ({
    trySimulateTrade: vi.fn(),
}));

vi.mock("../../../logger", () => ({
    extendObjectWithHeader: vi.fn(),
}));

describe("Test findBestInterOrderbookTrade", () => {
    let mockRainSolver: RainSolver;
    let orderDetails: BundledOrders;
    let signer: RainSolverSigner;
    let inputToEthPrice: string;
    let outputToEthPrice: string;

    beforeEach(() => {
        vi.clearAllMocks();

        mockRainSolver = {
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
            },
            orderManager: {
                getCounterpartyOrders: vi.fn(),
            },
            appOptions: {
                genericArbAddress: "0xarb",
            },
        } as any;

        orderDetails = {
            takeOrders: [{ quote: { maxOutput: 1000n } }, { quote: { maxOutput: 2000n } }],
        } as any;

        signer = { account: { address: "0xsigner" } } as any;
        inputToEthPrice = "0.5";
        outputToEthPrice = "2.0";
    });

    it("should return success result with highest profit when simulations succeed", async () => {
        const mockCounterpartyOrders = [
            [
                { orderbook: "0xorderbook1", id: "order1" },
                { orderbook: "0xorderbook1", id: "order2" },
            ],
            [{ orderbook: "0xorderbook2", id: "order3" }],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const mockResults = [
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 100n,
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 200n, // highest profit
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 150n,
                oppBlockNumber: 123,
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(200n); // highest profit
        expect(result.value.oppBlockNumber).toBe(123);
        expect(mockRainSolver.orderManager.getCounterpartyOrders as Mock).toHaveBeenCalledWith(
            orderDetails,
            false,
        );
        expect(trySimulateTrade).toHaveBeenCalledTimes(3);
        expect(result.value.type).toBe("interOrderbook");
    });

    it("should return success result when only some simulations succeed", async () => {
        const mockCounterpartyOrders = [
            [
                { orderbook: "0xorderbook1", id: "order1" },
                { orderbook: "0xorderbook1", id: "order2" },
            ],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const mockResults = [
            Result.err({
                type: "interOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 300n,
                oppBlockNumber: 123,
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(300n);
        expect(result.value.oppBlockNumber).toBe(123);
        expect(trySimulateTrade).toHaveBeenCalledTimes(2);
        expect(result.value.type).toBe("interOrderbook");
    });

    it("should return error when all simulations fail", async () => {
        const mockCounterpartyOrders = [
            [{ orderbook: "0xorderbook1", id: "order1" }],
            [{ orderbook: "0xorderbook2", id: "order2" }],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const mockResults = [
            Result.err({
                spanAttributes: { error: "failed1" },
                noneNodeError: "simulation failed 1",
            }),
            Result.err({
                spanAttributes: { error: "failed2" },
                noneNodeError: "simulation failed 2",
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("simulation failed 1"); // first error
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "failed1" },
            "againstOrderbooks.0xorderbook1",
        );
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "failed2" },
            "againstOrderbooks.0xorderbook2",
        );
        expect(result.error.type).toBe("interOrderbook");
    });

    it("should handle empty counterparty orders", async () => {
        const mockCounterpartyOrders = [];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBeUndefined();
        expect(trySimulateTrade).not.toHaveBeenCalled();
        expect(result.error.type).toBe("interOrderbook");
    });

    it("should limit to top 3 counterparty orders per orderbook", async () => {
        const mockCounterpartyOrders = [
            [
                { orderbook: "0xorderbook1", id: "order1" },
                { orderbook: "0xorderbook1", id: "order2" },
                { orderbook: "0xorderbook1", id: "order3" },
                { orderbook: "0xorderbook1", id: "order4" }, // should be ignored
                { orderbook: "0xorderbook1", id: "order5" }, // should be ignored
            ],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const mockResults = [
            Result.err({ spanAttributes: {}, noneNodeError: "error1" }),
            Result.err({ spanAttributes: {}, noneNodeError: "error2" }),
            Result.err({ spanAttributes: {}, noneNodeError: "error3" }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // Should only call trySimulateTrade 3 times (top 3 orders)
        expect(trySimulateTrade).toHaveBeenCalledTimes(3);
    });

    it("should call trySimulateTrade with correct parameters", async () => {
        const mockCounterpartyOrders = [[{ orderbook: "0xorderbook1", id: "order1" }]];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.err({
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
        );

        await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        expect(trySimulateTrade).toHaveBeenCalledWith({
            orderDetails,
            counterpartyOrderDetails: { orderbook: "0xorderbook1", id: "order1" },
            signer,
            maximumInputFixed: 3000n, // 1000 + 2000
            inputToEthPrice,
            outputToEthPrice,
            blockNumber: 123n,
        });
    });

    it("should sort results by estimated profit in descending order", async () => {
        const mockCounterpartyOrders = [
            [
                { orderbook: "0xorderbook1", id: "order1" },
                { orderbook: "0xorderbook1", id: "order2" },
                { orderbook: "0xorderbook1", id: "order3" },
            ],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const mockResults = [
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 50n, // lowest
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 500n, // highest
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "interOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 250n, // middle
                oppBlockNumber: 123,
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(500n); // should return the highest profit
        expect(result.value.type).toBe("interOrderbook");
    });
});
