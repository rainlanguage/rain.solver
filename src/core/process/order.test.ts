/* eslint-disable @typescript-eslint/no-unused-vars */
import { RainSolver } from "..";
import { Result } from "../../common";
import { findBestTrade } from "../modes";
import { SharedState } from "../../state";
import { OrderManager } from "../../order";
import { processTransaction } from "./transaction";
import { processOrder, ProcessOrderArgs } from "./order";
import { ProcessOrderStatus, ProcessOrderHaltReason } from "../types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("../modes", () => ({
    findBestTrade: vi.fn(),
}));

vi.mock("./transaction", () => ({
    processTransaction: vi.fn(),
}));

vi.mock("sushi/currency", async (importOriginal) => {
    return {
        ...(await importOriginal()),
        Token: class {
            constructor(args: any) {
                return { ...args };
            }
        },
    };
});

describe("Test processOrder", () => {
    let mockRainSolver: RainSolver;
    let mockArgs: ProcessOrderArgs;
    let mockOrderManager: OrderManager;
    let mockState: SharedState;

    beforeEach(() => {
        vi.clearAllMocks();
        mockOrderManager = {
            quoteOrder: vi.fn(),
            addToPairMaps: vi.fn(),
            removeFromPairMaps: vi.fn(),
        } as any;
        mockState = {
            chainConfig: {
                id: 1,
                nativeWrappedToken: "0xWETH",
            },
            client: {
                getBlockNumber: vi.fn().mockResolvedValue(123),
            },
            dataFetcher: {
                updatePools: vi.fn().mockResolvedValue(undefined),
                fetchPoolsForToken: vi.fn().mockResolvedValue(undefined),
            },
            getMarketPrice: vi.fn().mockResolvedValue({ price: "100", amountOut: "100" }),
            gasPrice: 100n,
        } as any;
        mockArgs = {
            orderDetails: {
                sellTokenDecimals: 18,
                buyTokenDecimals: 6,
                sellToken: "0xSELL",
                buyToken: "0xBUY",
                sellTokenSymbol: "SELL",
                buyTokenSymbol: "BUY",
                orderbook: "0xorderbook",
                takeOrder: {
                    id: "0xid",
                    quote: { maxOutput: 1000000000000000000n, ratio: 2000000000000000000n },
                    takeOrder: {},
                },
            },
            signer: {},
        } as any;
        mockRainSolver = {
            state: mockState,
            orderManager: mockOrderManager,
            appOptions: {},
            findBestTrade,
        } as any;
    });

    it("should return ZeroOutput if quoted maxOutput is 0", async () => {
        (mockOrderManager.quoteOrder as Mock).mockResolvedValue(undefined);
        mockArgs.orderDetails.takeOrder.quote = { maxOutput: 0n, ratio: 0n };

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isOk());
        expect(result.value.status).toBe(ProcessOrderStatus.ZeroOutput);
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");

        // ensure pair maps are updated on quote 0
        expect(mockOrderManager.removeFromPairMaps).toHaveBeenCalledWith(mockArgs.orderDetails);
    });

    it("should return FailedToQuote if quoteOrder throws", async () => {
        const error = new Error("quote failed");
        (mockOrderManager.quoteOrder as Mock).mockRejectedValue(error);

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isErr());
        expect(result.error.reason).toBe(ProcessOrderHaltReason.FailedToQuote);
        expect(result.error.error).toBe(error);
        expect(result.error.tokenPair).toBe("BUY/SELL");
        expect(result.error.buyToken).toBe("0xBUY");
        expect(result.error.sellToken).toBe("0xSELL");
        expect(result.error.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.error.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.error.spanAttributes["details.pair"]).toBe("BUY/SELL");

        // ensure pair maps are updated on quote failure
        expect(mockOrderManager.removeFromPairMaps).toHaveBeenCalledWith(mockArgs.orderDetails);
    });

    it("should return FailedToUpdatePools if updatePools throws (not fetchPoolsForToken)", async () => {
        const error = new Error("update pools failed");
        (mockState.dataFetcher.updatePools as Mock).mockRejectedValue(error);

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isErr());
        expect(result.error.reason).toBe(ProcessOrderHaltReason.FailedToUpdatePools);
        expect(result.error.error).toBe(error);
        expect(result.error.tokenPair).toBe("BUY/SELL");
        expect(result.error.buyToken).toBe("0xBUY");
        expect(result.error.sellToken).toBe("0xSELL");
        expect(result.error.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.error.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.error.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.error.spanAttributes["details.pair"]).toBe("BUY/SELL");

        // ensure pair maps are updated success quote
        expect(mockOrderManager.addToPairMaps).toHaveBeenCalledWith(mockArgs.orderDetails);
    });

    it("should return FailedToGetPools if fetchPoolsForToken throws", async () => {
        const error = new Error("fetch pools failed");
        (mockState.dataFetcher.fetchPoolsForToken as Mock).mockRejectedValue(error);

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isErr());
        expect(result.error.reason).toBe(ProcessOrderHaltReason.FailedToGetPools);
        expect(result.error.error).toBe(error);
        expect(result.error.tokenPair).toBe("BUY/SELL");
        expect(result.error.buyToken).toBe("0xBUY");
        expect(result.error.sellToken).toBe("0xSELL");
        expect(result.error.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.error.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.error.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.error.spanAttributes["details.pair"]).toBe("BUY/SELL");
    });

    it('should set outputToEthPrice to "" if getMarketPrice returns undefined for output and gasCoveragePercentage is not "0"', async () => {
        (mockState.getMarketPrice as Mock)
            .mockResolvedValueOnce({ price: "100", amountOut: "100" })
            .mockResolvedValueOnce({ price: "100", amountOut: "100" })
            .mockResolvedValueOnce(undefined);
        (findBestTrade as Mock).mockResolvedValue(Result.err({ spanAttributes: {} }));
        mockRainSolver.appOptions.gasCoveragePercentage = "100";

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        // this will eventually succeed at processTransaction
        assert(result.isOk());
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.value.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");
        expect(result.value.spanAttributes["details.inputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.outputToEthPrice"]).toBe("no-way");
    });

    it('should set outputToEthPrice to "0" if getMarketPrice returns undefined for output and gasCoveragePercentage is "0"', async () => {
        (mockState.getMarketPrice as Mock)
            .mockResolvedValueOnce({ price: "100", amountOut: "100" })
            .mockResolvedValueOnce({ price: "100", amountOut: "100" })
            .mockResolvedValueOnce(undefined);
        (findBestTrade as Mock).mockResolvedValue(Result.err({ spanAttributes: {} }));
        mockRainSolver.appOptions.gasCoveragePercentage = "0";

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        // this will eventually succeed at processTransaction
        assert(result.isOk());
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.value.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");
        expect(result.value.spanAttributes["details.inputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.outputToEthPrice"]).toBe("0");
    });

    it('should return FailedToGetEthPrice if getMarketPrice returns undefined and gasCoveragePercentage is not "0"', async () => {
        (mockState.getMarketPrice as Mock).mockResolvedValue(undefined);
        mockRainSolver.appOptions.gasCoveragePercentage = "100";

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isErr());
        expect(result.error.reason).toBe(ProcessOrderHaltReason.FailedToGetEthPrice);
        expect(result.error.tokenPair).toBe("BUY/SELL");
        expect(result.error.buyToken).toBe("0xBUY");
        expect(result.error.sellToken).toBe("0xSELL");
        expect(result.error.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.error.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.error.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.error.spanAttributes["details.pair"]).toBe("BUY/SELL");
    });

    it('should set input/outputToEthPrice to "0" if getMarketPrice returns undefined and gasCoveragePercentage is "0"', async () => {
        (mockState.getMarketPrice as Mock).mockResolvedValue(undefined);
        (findBestTrade as Mock).mockResolvedValue(Result.err({ spanAttributes: {} }));
        mockRainSolver.appOptions.gasCoveragePercentage = "0";

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        // this will eventually succeed at processTransaction
        assert(result.isOk());
        expect(result.value.message).toBeUndefined();
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.value.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");
    });

    it("should return ok result if findBestTrade throws with noneNodeError", async () => {
        const error = { spanAttributes: { test: "something" }, noneNodeError: "some error" };
        (findBestTrade as Mock).mockResolvedValue(Result.err(error));

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isOk());
        expect(result.value.message).toBe("some error");
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.value.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");
        expect(result.value.spanAttributes["details.marketQuote.str"]).toBe("100");
        expect(result.value.spanAttributes["details.marketQuote.num"]).toBe(100);
        expect(result.value.spanAttributes["details.inputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.outputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.gasPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.noneNodeError"]).toBe(true);
        expect(result.value.spanAttributes["details.test"]).toBe("something");
    });

    it("should return ok result if findBestTrade throws without noneNodeError", async () => {
        const error = { spanAttributes: { test: "something" } };
        (findBestTrade as Mock).mockResolvedValue(Result.err(error));

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isOk());
        expect(result.value.message).toBeUndefined();
        expect(result.value.tokenPair).toBe("BUY/SELL");
        expect(result.value.buyToken).toBe("0xBUY");
        expect(result.value.sellToken).toBe("0xSELL");
        expect(result.value.status).toBe(ProcessOrderStatus.NoOpportunity);
        expect(result.value.spanAttributes["details.quote"]).toBe(
            JSON.stringify({ maxOutput: "1", ratio: "2" }),
        );
        expect(result.value.spanAttributes["details.orders"]).toEqual("0xid");
        expect(result.value.spanAttributes["details.pair"]).toBe("BUY/SELL");
        expect(result.value.spanAttributes["details.marketQuote.str"]).toBe("100");
        expect(result.value.spanAttributes["details.marketQuote.num"]).toBe(100);
        expect(result.value.spanAttributes["details.inputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.outputToEthPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.gasPrice"]).toBe("100");
        expect(result.value.spanAttributes["details.noneNodeError"]).toBe(false);
        expect(result.value.spanAttributes["details.test"]).toBe("something");
    });

    it("should proceed to processTransaction if all steps succeed (happy path)", async () => {
        // mock findBestTrade to return a valid opportunity
        (findBestTrade as Mock).mockResolvedValue(
            Result.ok({
                rawtx: { to: "0xRAW" },
                oppBlockNumber: 100,
                estimatedProfit: 123n,
                spanAttributes: {},
            }),
        );
        // mock processTransaction to return a function
        (processTransaction as Mock).mockReturnValue(async () =>
            Result.ok({ status: ProcessOrderStatus.FoundOpportunity }),
        );

        const fn: Awaited<ReturnType<typeof processOrder>> = await processOrder.call(
            mockRainSolver,
            mockArgs,
        );
        const result = await fn();

        assert(result.isOk());
        expect(result.value.status).toBe(ProcessOrderStatus.FoundOpportunity);
    });
});
