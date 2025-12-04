import { RainSolver } from "../..";
import { fallbackEthPrice } from "../dryrun";
import { Dispair, Result } from "../../../common";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { findBestInterOrderbookTrade } from "./index";
import { extendObjectWithHeader } from "../../../common";
import { SimulationResult, TradeType } from "../../types";
import { InterOrderbookTradeSimulator } from "./simulate";
import { CounterpartySource, Order, Pair } from "../../../order";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("../../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    extendObjectWithHeader: vi.fn(),
}));

vi.mock("../dryrun", () => ({
    fallbackEthPrice: vi.fn(),
}));

describe("Test findBestInterOrderbookTrade", () => {
    let mockRainSolver: RainSolver;
    let orderDetails: Pair;
    let signer: RainSolverSigner;
    let inputToEthPrice: string;
    let outputToEthPrice: string;
    let blockNumber: bigint;
    let trySimulateTradeSpy: any;
    let simulatorWithArgsSpy: any;
    let dispair: Dispair;
    let destination: `0x${string}`;

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";
        mockRainSolver = {
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        dispair,
                        destination,
                    }),
                },
            },
            orderManager: {
                getCounterpartyOrders: vi.fn(),
            },
            appOptions: {
                orderbookTradeTypes: {
                    router: new Set(),
                    interOrderbook: new Set(),
                    intraOrderbook: new Set(),
                },
            },
        } as any;

        orderDetails = {
            takeOrder: {
                quote: { maxOutput: 1000n, ratio: 5n },
                struct: { order: { type: Order.Type.V4 } },
            },
        } as any;

        signer = { account: { address: "0xsigner" } } as any;
        inputToEthPrice = "0.5";
        outputToEthPrice = "2.0";
        blockNumber = 123n;

        simulatorWithArgsSpy = vi.spyOn(InterOrderbookTradeSimulator, "withArgs");
        trySimulateTradeSpy = vi.spyOn(InterOrderbookTradeSimulator.prototype, "trySimulateTrade");
    });

    it("should return success result with highest profit when simulations succeed", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order2",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
            ],
            [
                {
                    orderbook: "0xorderbook2",
                    id: "order3",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
            ],
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
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(200n); // highest profit
        expect(result.value.oppBlockNumber).toBe(123);
        expect(mockRainSolver.orderManager.getCounterpartyOrders as Mock).toHaveBeenCalledWith(
            orderDetails,
            CounterpartySource.InterOrderbook,
        );
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(3);
        expect(result.value.type).toBe("interOrderbook");
    });

    it("should return success result when only some simulations succeed", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order2",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
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
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(300n);
        expect(result.value.oppBlockNumber).toBe(123);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        expect(result.value.type).toBe("interOrderbook");
    });

    it("should return error when all simulations fail", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
            ],
            [
                {
                    orderbook: "0xorderbook2",
                    id: "order2",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
            ],
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
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
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
        const mockCounterpartyOrders: any[] = [];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBeUndefined();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
        expect(result.error.type).toBe("interOrderbook");
    });

    it("should limit to top 3 counterparty orders per orderbook", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order2",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order3",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order4",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                }, // should be ignored
                {
                    orderbook: "0xorderbook1",
                    id: "order5",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                }, // should be ignored
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
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        // Should only call trySimulateTradeSpy 3 times (top 3 orders)
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(3);
    });

    it("should call trySimulateTradeSpy with correct parameters", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
            ],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );

        (trySimulateTradeSpy as Mock).mockResolvedValue(
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
            blockNumber,
        );

        expect(simulatorWithArgsSpy).toHaveBeenCalledWith({
            type: TradeType.InterOrderbook,
            solver: mockRainSolver,
            orderDetails,
            counterpartyOrderDetails: {
                orderbook: "0xorderbook1",
                id: "order1",
                takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
            },
            signer,
            maximumInputFixed: 1000n,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber: 123n,
        });
    });

    it("should sort results by estimated profit in descending order", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order2",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
                {
                    orderbook: "0xorderbook1",
                    id: "order3",
                    takeOrder: { struct: { order: { type: Order.Type.V4 } }, quote: {} },
                },
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
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(500n); // should return the highest profit
        expect(result.value.type).toBe("interOrderbook");
    });

    it("should call fallbackEthPrice with correct parameters if eth price is unknown", async () => {
        const mockCounterpartyOrders = [
            [
                {
                    orderbook: "0xorderbook1",
                    id: "order1",
                    takeOrder: {
                        quote: { maxOutput: 1n, ratio: 2n },
                        struct: { order: { type: Order.Type.V4 } },
                    },
                },
            ],
        ];
        (mockRainSolver.orderManager.getCounterpartyOrders as Mock).mockReturnValue(
            mockCounterpartyOrders,
        );
        (fallbackEthPrice as Mock).mockReturnValueOnce("1").mockReturnValueOnce("2");
        (trySimulateTradeSpy as Mock).mockResolvedValue(
            Result.err({
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
        );

        await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            "",
            "",
            blockNumber,
        );

        expect(simulatorWithArgsSpy).toHaveBeenCalledWith({
            type: TradeType.InterOrderbook,
            solver: mockRainSolver,
            orderDetails,
            counterpartyOrderDetails: mockCounterpartyOrders[0][0],
            signer,
            maximumInputFixed: 1000n,
            inputToEthPrice: "1",
            outputToEthPrice: "2",
            blockNumber: 123n,
        });
        expect(fallbackEthPrice).toHaveBeenCalledWith(5n, 2n, ""); // first call for inputToEthPrice
        expect(fallbackEthPrice).toHaveBeenCalledWith(2n, 5n, ""); // second call for outputToEthPrice
    });

    it("should return error when trade addresses are not configured", async () => {
        (mockRainSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValue(undefined);
        const result: SimulationResult = await findBestInterOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.InterOrderbook);
        expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
        expect(mockRainSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.InterOrderbook,
        );
    });
});
