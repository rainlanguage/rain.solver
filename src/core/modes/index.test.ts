import { RainSolver } from "..";
import { Result } from "../../common";
import { findBestRouterTrade } from "./router";
import { OrderbookTradeTypes } from "../../config";
import { findBestIntraOrderbookTrade } from "./intra";
import { findBestInterOrderbookTrade } from "./inter";
import { findBestTrade, getEnabledTradeTypeFunctions } from "./index";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("./router", () => ({
    findBestRouterTrade: vi.fn(),
}));

vi.mock("./intra", () => ({
    findBestIntraOrderbookTrade: vi.fn(),
}));

vi.mock("./inter", () => ({
    findBestInterOrderbookTrade: vi.fn(),
}));

vi.mock("./balancer", () => ({
    findBestBalancerTrade: vi.fn(),
}));

describe("Test findBestTrade", () => {
    let mockRainSolver: RainSolver;
    let args: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockRainSolver = {
            appOptions: {
                balancerArbAddress: "0xBalancerArb",
                orderbookTradeTypes: {
                    router: new Set(),
                    intraOrderbook: new Set(),
                    interOrderbook: new Set(),
                } as any,
            },
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
            },
        } as any;

        args = {
            orderDetails: {
                orderbook: "0xorderbook",
                takeOrders: [{ quote: { maxOutput: 1000n } }],
            },
            signer: { account: { address: "0xsigner" } },
            inputToEthPrice: "0.5",
            outputToEthPrice: "2.0",
            toToken: { address: "0xTo", decimals: 18, symbol: "TO" },
            fromToken: { address: "0xFrom", decimals: 18, symbol: "FROM" },
            blockNumber: 123n,
        };
    });

    it("should return highest profit result when all modes succeed", async () => {
        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        const intraResult = Result.ok({
            type: "intraOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 200n, // highest profit
            oppBlockNumber: 123,
        });
        const interResult = Result.ok({
            type: "interOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 150n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(200n); // highest profit
        expect(result.value.type).toBe("intraOrderbook");
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.spanAttributes.tradeType).toBe("intraOrderbook");
    });

    it("should return success result when only some modes succeed", async () => {
        const rpResult = Result.err({
            type: "routeProcessor",
            spanAttributes: { error: "no route" },
            noneNodeError: "route processor failed",
        });
        const intraResult = Result.ok({
            type: "intraOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 250n,
            oppBlockNumber: 123,
        });
        const interResult = Result.err({
            type: "interOrderbook",
            spanAttributes: { error: "no counterparty" },
            noneNodeError: "inter orderbook failed",
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(250n);
        expect(result.value.type).toBe("intraOrderbook");
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.spanAttributes.tradeType).toBe("intraOrderbook");
    });

    it("should return error when all modes fail", async () => {
        const rpResult = Result.err({
            type: "routeProcessor",
            spanAttributes: { error: "no route", attempts: 3 },
            noneNodeError: "route processor failed",
        });
        const intraResult = Result.err({
            type: "intraOrderbook",
            spanAttributes: { error: "no opportunity", checked: 5 },
            noneNodeError: "intra orderbook failed",
        });
        const interResult = Result.err({
            type: "interOrderbook",
            spanAttributes: { error: "no counterparty", pairs: 2 },
            noneNodeError: "inter orderbook failed",
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isErr());
        expect(result.error.noneNodeError).toBe("route processor failed"); // first error
        expect(result.error.spanAttributes["routeProcessor.error"]).toBe("no route");
        expect(result.error.spanAttributes["routeProcessor.attempts"]).toBe(3);
        expect(result.error.spanAttributes["intraOrderbook.error"]).toBe("no opportunity");
        expect(result.error.spanAttributes["intraOrderbook.checked"]).toBe(5);
        expect(result.error.spanAttributes["interOrderbook.error"]).toBe("no counterparty");
        expect(result.error.spanAttributes["interOrderbook.pairs"]).toBe(2);
    });

    it("should only call route processor when rpOnly is true", async () => {
        mockRainSolver.appOptions.orderbookTradeTypes.router.add("0xorderbook");

        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(100n);
        expect(result.value.type).toBe("routeProcessor");
        expect(result.value.spanAttributes.tradeType).toBe("routeProcessor");
        expect(findBestRouterTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.toToken,
            args.fromToken,
            args.blockNumber,
        );
        expect(findBestIntraOrderbookTrade).not.toHaveBeenCalled();
        expect(findBestInterOrderbookTrade).not.toHaveBeenCalled();
    });

    it("should only call balancer router when balancerRouter is available", async () => {
        const mocksolver = {
            appOptions: {
                balancerArbAddress: "0xBalancerArb",
                orderbookTradeTypes: {
                    router: new Set(),
                    intraOrderbook: new Set(),
                    interOrderbook: new Set(),
                } as any,
            },
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
                balancerRouter: {},
            },
        } as any;

        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        const intraResult = Result.ok({
            type: "intraOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 150n,
            oppBlockNumber: 123,
        });
        const interResult = Result.ok({
            type: "interOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 120n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mocksolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(150n); // highest profit
        expect(result.value.type).toBe("intraOrderbook");
        expect(findBestRouterTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.toToken,
            args.fromToken,
            args.blockNumber,
        );
        expect(findBestIntraOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
        expect(findBestInterOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
    });

    it("should call all modes when rpOnly is false", async () => {
        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });
        const intraResult = Result.ok({
            type: "intraOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 150n,
            oppBlockNumber: 123,
        });
        const interResult = Result.ok({
            type: "interOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 120n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(150n); // highest profit
        expect(result.value.type).toBe("intraOrderbook");
        expect(findBestRouterTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.toToken,
            args.fromToken,
            args.blockNumber,
        );
        expect(findBestIntraOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
        expect(findBestInterOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
    });

    it("should sort results by estimated profit in descending order", async () => {
        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 300n, // highest
            oppBlockNumber: 123,
        });
        const intraResult = Result.ok({
            type: "intraOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n, // lowest
            oppBlockNumber: 123,
        });
        const interResult = Result.ok({
            type: "interOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 200n, // middle
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(300n); // should return the highest profit
        expect(result.value.type).toBe("routeProcessor");
    });

    it("should handle mixed success and error results", async () => {
        const rpResult = Result.err({
            type: "routeProcessor",
            spanAttributes: { error: "no route" },
            noneNodeError: "route processor failed",
        });
        const intraResult = Result.err({
            type: "intraOrderbook",
            spanAttributes: { error: "no opportunity" },
            noneNodeError: "intra orderbook failed",
        });
        const interResult = Result.ok({
            type: "interOrderbook",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 75n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(75n);
        expect(result.value.type).toBe("interOrderbook");
        expect(result.value.spanAttributes.tradeType).toBe("interOrderbook");
    });

    it("should set tradeType in span attributes for successful result", async () => {
        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true, custom: "attr" },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(
            Result.err({
                type: "intraOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "failed",
            }),
        );
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(
            Result.err({
                type: "interOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "failed",
            }),
        );

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.spanAttributes.tradeType).toBe("routeProcessor");
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.spanAttributes.custom).toBe("attr");
    });

    it("should call functions with correct parameters", async () => {
        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(
            Result.err({
                type: "intraOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "failed",
            }),
        );
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(
            Result.err({
                type: "interOrderbook",
                spanAttributes: { error: "failed" },
                noneNodeError: "failed",
            }),
        );

        await findBestTrade.call(mockRainSolver, args);

        expect(findBestRouterTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.toToken,
            args.fromToken,
            args.blockNumber,
        );
        expect(findBestIntraOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
        expect(findBestInterOrderbookTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.outputToEthPrice,
            args.blockNumber,
        );
    });

    it("should preserve span attributes from error results with proper headers", async () => {
        const rpResult = Result.err({
            type: "routeProcessor",
            spanAttributes: { rpError: "no route", rpAttempts: 3 },
            noneNodeError: "route processor failed",
        });
        const intraResult = Result.err({
            type: "intraOrderbook",
            spanAttributes: { intraError: "no opportunity", intraChecked: 5 },
            noneNodeError: "intra orderbook failed",
        });
        const interResult = Result.err({
            type: "interOrderbook",
            spanAttributes: { interError: "no counterparty", interPairs: 2 },
            noneNodeError: "inter orderbook failed",
        });

        (findBestRouterTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isErr());
        expect(result.error.spanAttributes["routeProcessor.rpError"]).toBe("no route");
        expect(result.error.spanAttributes["routeProcessor.rpAttempts"]).toBe(3);
        expect(result.error.spanAttributes["intraOrderbook.intraError"]).toBe("no opportunity");
        expect(result.error.spanAttributes["intraOrderbook.intraChecked"]).toBe(5);
        expect(result.error.spanAttributes["interOrderbook.interError"]).toBe("no counterparty");
        expect(result.error.spanAttributes["interOrderbook.interPairs"]).toBe(2);
    });
});

describe("Test getEnabledTrades", () => {
    const mockOrderbookAddress = "0xOrderbook";
    const mockOrderbookAddressLowercase = mockOrderbookAddress.toLowerCase();
    const anotherAddress = "0xOtherOrderbook".toLowerCase();

    it("should return all trade functions when allEnabled is true (no specific orderbook in any set)", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set([anotherAddress]),
            intraOrderbook: new Set([anotherAddress]),
            interOrderbook: new Set([anotherAddress]),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBe(findBestRouterTrade);
        expect(result.findBestIntraOrderbookTrade).toBe(findBestIntraOrderbookTrade);
        expect(result.findBestInterOrderbookTrade).toBe(findBestInterOrderbookTrade);
    });

    it("should return all trade functions when all sets are empty", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set(),
            intraOrderbook: new Set(),
            interOrderbook: new Set(),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBe(findBestRouterTrade);
        expect(result.findBestIntraOrderbookTrade).toBe(findBestIntraOrderbookTrade);
        expect(result.findBestInterOrderbookTrade).toBe(findBestInterOrderbookTrade);
    });

    it("should return only router trade when orderbook is in router set", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set([mockOrderbookAddressLowercase]),
            intraOrderbook: new Set(),
            interOrderbook: new Set(),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBe(findBestRouterTrade);
        expect(result.findBestIntraOrderbookTrade).toBeUndefined();
        expect(result.findBestInterOrderbookTrade).toBeUndefined();
    });

    it("should return only intra-orderbook trade when orderbook is in intraOrderbook set", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set(),
            intraOrderbook: new Set([mockOrderbookAddressLowercase]),
            interOrderbook: new Set(),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBeUndefined();
        expect(result.findBestIntraOrderbookTrade).toBe(findBestIntraOrderbookTrade);
        expect(result.findBestInterOrderbookTrade).toBeUndefined();
    });

    it("should return only inter-orderbook trade when orderbook is in interOrderbook set", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set(),
            intraOrderbook: new Set(),
            interOrderbook: new Set([mockOrderbookAddressLowercase]),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBeUndefined();
        expect(result.findBestIntraOrderbookTrade).toBeUndefined();
        expect(result.findBestInterOrderbookTrade).toBe(findBestInterOrderbookTrade);
    });

    it("should return multiple trade functions when orderbook is in multiple sets", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set([mockOrderbookAddressLowercase]),
            intraOrderbook: new Set([mockOrderbookAddressLowercase]),
            interOrderbook: new Set(),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBe(findBestRouterTrade);
        expect(result.findBestIntraOrderbookTrade).toBe(findBestIntraOrderbookTrade);
        expect(result.findBestInterOrderbookTrade).toBeUndefined();
    });

    it("should return all trade functions when orderbook is in all sets", () => {
        const orderbookTradeTypes: OrderbookTradeTypes = {
            router: new Set([mockOrderbookAddressLowercase]),
            intraOrderbook: new Set([mockOrderbookAddressLowercase]),
            interOrderbook: new Set([mockOrderbookAddressLowercase]),
        };

        const result = getEnabledTradeTypeFunctions(orderbookTradeTypes, mockOrderbookAddress);

        expect(result.findBestRouterTrade).toBe(findBestRouterTrade);
        expect(result.findBestIntraOrderbookTrade).toBe(findBestIntraOrderbookTrade);
        expect(result.findBestInterOrderbookTrade).toBe(findBestInterOrderbookTrade);
    });
});
