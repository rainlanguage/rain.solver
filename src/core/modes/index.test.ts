import { RainSolver } from "..";
import { Result } from "../../common";
import { findBestTrade } from "./index";
import { findBestBalancerTrade } from "./balancer";
import { findBestRouteProcessorTrade } from "./router";
import { findBestIntraOrderbookTrade } from "./intra";
import { findBestInterOrderbookTrade } from "./inter";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("./router", () => ({
    findBestRouteProcessorTrade: vi.fn(),
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
                rpOnly: false,
                balancerArbAddress: "0xBalancerArb",
            },
            state: {
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
            },
        } as any;

        args = {
            orderDetails: {
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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
        mockRainSolver.appOptions.rpOnly = true;

        const rpResult = Result.ok({
            type: "routeProcessor",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 100n,
            oppBlockNumber: 123,
        });

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(100n);
        expect(result.value.type).toBe("routeProcessor");
        expect(result.value.spanAttributes.tradeType).toBe("routeProcessor");
        expect(findBestRouteProcessorTrade).toHaveBeenCalledWith(
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
                rpOnly: false,
                balancerArbAddress: "0xBalancerArb",
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
        const balancerResult = Result.ok({
            type: "balancer",
            spanAttributes: { foundOpp: true },
            estimatedProfit: 120n,
            oppBlockNumber: 123,
        });

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);
        (findBestBalancerTrade as Mock).mockResolvedValue(balancerResult);

        const result = await findBestTrade.call(mocksolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(150n); // highest profit
        expect(result.value.type).toBe("intraOrderbook");
        expect(findBestRouteProcessorTrade).toHaveBeenCalledWith(
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
        expect(findBestBalancerTrade).toHaveBeenCalledWith(
            args.orderDetails,
            args.signer,
            args.inputToEthPrice,
            args.toToken,
            args.fromToken,
            args.blockNumber,
        );
    });

    it("should call all modes when rpOnly is false", async () => {
        mockRainSolver.appOptions.rpOnly = false;

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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
        (findBestIntraOrderbookTrade as Mock).mockResolvedValue(intraResult);
        (findBestInterOrderbookTrade as Mock).mockResolvedValue(interResult);

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(150n); // highest profit
        expect(result.value.type).toBe("intraOrderbook");
        expect(findBestRouteProcessorTrade).toHaveBeenCalledWith(
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

        expect(findBestRouteProcessorTrade).toHaveBeenCalledWith(
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

        (findBestRouteProcessorTrade as Mock).mockResolvedValue(rpResult);
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

    it("should return error when fails to get block number", async () => {
        (mockRainSolver.state.client.getBlockNumber as Mock).mockRejectedValueOnce(
            new Error("some error"),
        );

        const result = await findBestTrade.call(mockRainSolver, args);

        assert(result.isErr());
        expect(result.error.noneNodeError).toContain("some error");
        expect(result.error.spanAttributes.error).toContain("some error");
    });
});
