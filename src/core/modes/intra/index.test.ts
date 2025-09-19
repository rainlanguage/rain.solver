import { Result } from "../../../common";
import { SimulationResult } from "../../types";
import { trySimulateTrade } from "./simulation";
import { fallbackEthPrice } from "../../../router";
import { findBestIntraOrderbookTrade } from "./index";
import { extendObjectWithHeader } from "../../../logger";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("../../../router", () => ({
    fallbackEthPrice: vi.fn(),
}));

vi.mock("./simulation", () => ({
    trySimulateTrade: vi.fn(),
}));

vi.mock("../../../logger", () => ({
    extendObjectWithHeader: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    erc20Abi: [],
}));

describe("Test findBestIntraOrderbookTrade", () => {
    let mockRainSolver: any;
    let orderDetails: any;
    let signer: any;
    let inputToEthPrice: string;
    let outputToEthPrice: string;

    beforeEach(() => {
        vi.clearAllMocks();

        mockRainSolver = {
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                    readContract: vi
                        .fn()
                        .mockResolvedValueOnce(5000000000000000000n) // input balance
                        .mockResolvedValueOnce(3000000000000000000n), // output balance
                },
            },
            orderManager: {
                getCounterpartyOrders: vi.fn(),
            },
        };

        orderDetails = {
            takeOrders: [
                {
                    id: "order1",
                    takeOrder: {
                        order: {
                            owner: "0xowner1",
                        },
                    },
                    quote: { ratio: 1000000000000000000n }, // 1.0
                },
            ],
            buyToken: "0xbuytoken",
            sellToken: "0xselltoken",
            buyTokenDecimals: 18,
            sellTokenDecimals: 18,
        };

        signer = { account: { address: "0xsigner" } };
        inputToEthPrice = "0.5";
        outputToEthPrice = "2.0";
    });

    it("should return success result with highest profit when simulations succeed", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n }, // 0.5
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 800000000000000000n }, // 0.8
                },
            },
            {
                takeOrder: {
                    id: "order4",
                    takeOrder: {
                        order: {
                            owner: "0xowner4",
                        },
                    },
                    quote: { ratio: 600000000000000000n }, // 0.6
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        const mockResults = [
            Result.ok({
                type: "intraOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 100n,
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "intraOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 250n, // highest profit
                oppBlockNumber: 123,
            }),
            Result.ok({
                type: "intraOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 150n,
                oppBlockNumber: 123,
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1])
            .mockResolvedValueOnce(mockResults[2]);

        const result: SimulationResult = await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedProfit).toBe(250n); // highest profit
        expect(result.value.oppBlockNumber).toBe(123);
        expect(mockRainSolver.orderManager.getCounterpartyOrders).toHaveBeenCalledWith(
            orderDetails,
            true,
        );
        expect(trySimulateTrade).toHaveBeenCalledTimes(3);
        expect(result.value.type).toBe("intraOrderbook");
    });

    it("should return success result when only some simulations succeed", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 600000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        const mockResults = [
            Result.err({
                type: "intraOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
            Result.ok({
                type: "intraOrderbook",
                spanAttributes: { foundOpp: true },
                estimatedProfit: 300n,
                oppBlockNumber: 123,
            }),
        ];
        (trySimulateTrade as Mock)
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const result: SimulationResult = await findBestIntraOrderbookTrade.call(
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
        expect(result.value.type).toBe("intraOrderbook");
    });

    it("should return error when all simulations fail", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 600000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

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

        const result: SimulationResult = await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("simulation failed 1"); // first error
        expect(result.error.type).toBe("intraOrderbook");
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "failed1" },
            "intraOrderbook.0",
        );
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "failed2" },
            "intraOrderbook.1",
        );
    });

    it("should filter out orders with same ID", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order1", // same as main order
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 600000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.ok({
                spanAttributes: { foundOpp: true },
                estimatedProfit: 200n,
                oppBlockNumber: 123,
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // should only call trySimulateTrade once (filtered out same ID order)
        expect(trySimulateTrade).toHaveBeenCalledTimes(1);
    });

    it("should filter out orders with same owner", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner1", // same as main order owner
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 600000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.ok({
                spanAttributes: { foundOpp: true },
                estimatedProfit: 200n,
                oppBlockNumber: 123,
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // should only call trySimulateTrade once (filtered out same owner order)
        expect(trySimulateTrade).toHaveBeenCalledTimes(1);
    });

    it("should filter out orders where price multiplication >= 1", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 1200000000000000000n }, // 1.2 * 1.0 = 1.2 >= 1, should be filtered
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 800000000000000000n }, // 0.8 * 1.0 = 0.8 < 1, should pass
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.ok({
                spanAttributes: { foundOpp: true },
                estimatedProfit: 200n,
                oppBlockNumber: 123,
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // should only call trySimulateTrade once (filtered out high ratio order)
        expect(trySimulateTrade).toHaveBeenCalledTimes(1);
    });

    it("should filter out orders without quote", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: null, // no quote, should be filtered
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 800000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.ok({
                spanAttributes: { foundOpp: true },
                estimatedProfit: 200n,
                oppBlockNumber: 123,
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // should only call trySimulateTrade once (filtered out order without quote)
        expect(trySimulateTrade).toHaveBeenCalledTimes(1);
    });

    it("should limit to top 3 counterparty orders", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order3",
                    takeOrder: {
                        order: {
                            owner: "0xowner3",
                        },
                    },
                    quote: { ratio: 600000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order4",
                    takeOrder: {
                        order: {
                            owner: "0xowner4",
                        },
                    },
                    quote: { ratio: 700000000000000000n },
                },
            },
            {
                takeOrder: {
                    id: "order5", // should be ignored
                    takeOrder: {
                        order: {
                            owner: "0xowner5",
                        },
                    },
                    quote: { ratio: 800000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.err({
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        // should only call trySimulateTrade 3 times (top 3 orders)
        expect(trySimulateTrade).toHaveBeenCalledTimes(3);
    });

    it("should call trySimulateTrade with correct parameters", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        (trySimulateTrade as Mock).mockResolvedValue(
            Result.err({
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
        );

        await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        expect(trySimulateTrade).toHaveBeenCalledWith({
            orderDetails,
            counterpartyOrderDetails: mockCounterpartyOrders[0].takeOrder,
            signer,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber: 123n,
            inputBalance: 5000000000000000000n,
            outputBalance: 3000000000000000000n,
        });
    });

    it("should handle empty counterparty orders after filtering", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order1", // same ID as main order
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 500000000000000000n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);

        const result: SimulationResult = await findBestIntraOrderbookTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            inputToEthPrice,
            outputToEthPrice,
        );

        assert(result.isErr());
        expect(result.error.noneNodeError).toBeUndefined();
        expect(trySimulateTrade).not.toHaveBeenCalled();
        expect(result.error.type).toBe("intraOrderbook");
    });

    it("should call fallbackEthPrice with correct parameters if eth price is unknown", async () => {
        const mockCounterpartyOrders = [
            {
                takeOrder: {
                    id: "order2",
                    takeOrder: {
                        order: {
                            owner: "0xowner2",
                        },
                    },
                    quote: { ratio: 2n, maxOutput: 1n },
                },
            },
        ];
        mockRainSolver.orderManager.getCounterpartyOrders.mockReturnValue(mockCounterpartyOrders);
        (fallbackEthPrice as Mock).mockReturnValueOnce("1").mockReturnValueOnce("2");
        (trySimulateTrade as Mock).mockResolvedValue(
            Result.err({
                spanAttributes: { error: "failed" },
                noneNodeError: "simulation failed",
            }),
        );

        await findBestIntraOrderbookTrade.call(mockRainSolver, orderDetails, signer, "", "");

        expect(trySimulateTrade).toHaveBeenCalledWith({
            orderDetails,
            counterpartyOrderDetails: mockCounterpartyOrders[0].takeOrder,
            signer,
            inputToEthPrice: "1",
            outputToEthPrice: "2",
            blockNumber: 123n,
            inputBalance: 5000000000000000000n,
            outputBalance: 3000000000000000000n,
        });
        expect(fallbackEthPrice).toHaveBeenCalledWith(1000000000000000000n, 2n, ""); // first call for inputToEthPrice
        expect(fallbackEthPrice).toHaveBeenCalledWith(2n, 1000000000000000000n, ""); // second call for outputToEthPrice
    });
});
