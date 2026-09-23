import { Order } from "../../../order";
import { findBestRouterTrade, getHalvedTradeSizes } from "./index";
import { TradeSizeStatus } from "../../../router";
import { Dispair, Result } from "../../../common";
import { RouterTradeSimulator } from "./simulate";
import { SimulationHaltReason } from "../simulator";
import { extendObjectWithHeader } from "../../../common";
import { SimulationResult, TradeType } from "../../types";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// Mocks
// extendObjectWithHeader is wrapped with its real implementation so call
// assertions work while span attributes still get merged for assertions
vi.mock("../../../common", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../../common")>();
    return {
        ...original,
        extendObjectWithHeader: vi.fn(original.extendObjectWithHeader),
    };
});

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

describe("Test findBestRouterTrade", () => {
    let mockRainSolver: any;
    let orderDetails: any;
    let signer: any;
    let ethPrice: string;
    let toToken: any;
    let fromToken: any;
    let blockNumber: bigint;
    let trySimulateTradeSpy: any;
    let simulatorWithArgsSpy: any;
    let dispair: Dispair;
    let destination: `0x${string}`;

    // the sushi quote the size finder settles on, with no route legs so
    // the dex exclusion retry stays out unless a test asks for it
    const sizerQuote = {
        route: { route: { legs: [] }, pcMap: new Map() },
        tag: "sizer",
    } as any;
    const outputToEthPrice = "3";
    const mockViolationError = Result.err({
        type: TradeType.RouteProcessor,
        reason: SimulationHaltReason.NoOpportunity,
        spanAttributes: {
            error: "execution reverted: MinimalOutputBalanceViolation(0xtoken, 123)",
        },
        noneNodeError: "violation",
    });
    const mockSuccess = Result.ok({
        type: TradeType.RouteProcessor,
        spanAttributes: { foundOpp: true },
        estimatedProfit: 25n,
        oppBlockNumber: 123,
    });
    const lockedArgs = { lockRoute: true, skipPriceMatchCheck: true, sushiQuote: sizerQuote };
    const simulatedSizes = (): bigint[] =>
        (simulatorWithArgsSpy as Mock).mock.calls.map((call: any[]) => call[0].maximumInputFixed);
    const setFoundSize = (size: bigint, quote: any = sizerQuote) => {
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.Found,
            size,
            quote,
        });
    };
    const run = (): Promise<SimulationResult> =>
        findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            ethPrice,
            toToken,
            fromToken,
            blockNumber,
            outputToEthPrice,
        );

    beforeEach(() => {
        vi.clearAllMocks();

        dispair = {
            deployer: "0xdeployer",
            interpreter: "0xinterpreter",
            store: "0xstore",
        };
        destination = "0xdestination";
        mockRainSolver = {
            appOptions: {
                routerPartialFallback: true,
                routerPartialFallbackSteps: 4,
                routerSecondaryRouteTry: "all",
                dustGasCostMultiplier: 1,
                dustUsdThreshold: 0,
            },
            state: {
                gasPrice: 100n,
                gasTokenUsdPrice: "2000",
                isDustCheckEnabled: true,
                isDustTrade: vi.fn().mockReturnValue(undefined),
                client: {
                    getBlockNumber: vi.fn().mockResolvedValue(123n),
                },
                router: {
                    findLargestTradeSize: vi
                        .fn()
                        .mockReturnValue({ status: TradeSizeStatus.NoWay }),
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        dispair,
                        destination,
                    }),
                },
            },
        };

        orderDetails = {
            takeOrder: {
                quote: { maxOutput: 1000n },
                struct: { order: { type: Order.Type.V4, owner: "0xOwner" } },
            },
        };

        signer = { account: { address: "0xsigner" } };
        ethPrice = "2000";
        toToken = { address: "0xTo", decimals: 18, symbol: "TO" };
        fromToken = { address: "0xFrom", decimals: 18, symbol: "FROM" };
        blockNumber = 123n;

        simulatorWithArgsSpy = vi.spyOn(RouterTradeSimulator, "withArgs");
        trySimulateTradeSpy = vi.spyOn(RouterTradeSimulator.prototype, "trySimulateTrade");
    });

    it("should bail out without any sim when no route is found at any size", async () => {
        const result = await run();

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Router);
        expect(result.error.reason).toBe(SimulationHaltReason.NoRoute);
        expect(result.error.spanAttributes).toEqual({
            error: "found no route for any trade size",
        });
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
        expect(mockRainSolver.state.isDustTrade).not.toHaveBeenCalled();
        expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledWith(
            orderDetails,
            toToken,
            fromToken,
            1000n,
            100n,
            undefined,
            false,
            undefined,
        );
    });

    it("should bail out without any sim when no size clears the order ratio", async () => {
        (mockRainSolver.state.router.findLargestTradeSize as Mock).mockReturnValue({
            status: TradeSizeStatus.PriceMismatch,
            size: 400n,
            quote: sizerQuote,
        });
        const result = await run();

        assert(result.isErr());
        expect(result.error.reason).toBe(SimulationHaltReason.OrderRatioGreaterThanMarketPrice);
        expect(result.error.spanAttributes).toEqual({
            error: "found no trade size that clears the order ratio",
        });
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
        expect(mockRainSolver.state.isDustTrade).not.toHaveBeenCalled();
    });

    it("should run the full size and its halved sizes locked to the found route when the full size clears the ratio", async () => {
        setFoundSize(1000n);
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockSuccess) // 1000n
            .mockResolvedValue(mockViolationError); // halved sizes
        const result = await run();

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ foundOpp: true });
        expect(result.value.estimatedProfit).toBe(25n);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(6);
        expect(simulatedSizes()).toEqual([1000n, 750n, 500n, 250n, 125n, 62n]);
        // the full size is not a partial trade, every other size is
        expect(simulatorWithArgsSpy).toHaveBeenNthCalledWith(1, {
            type: TradeType.Router,
            solver: mockRainSolver,
            orderDetails,
            fromToken,
            toToken,
            signer,
            maximumInputFixed: 1000n,
            ethPrice,
            isPartial: false,
            blockNumber: 123n,
            excludeDexes: undefined,
            ...lockedArgs,
        });
        for (let i = 1; i < 6; i++) {
            expect((simulatorWithArgsSpy as Mock).mock.calls[i][0]).toEqual(
                expect.objectContaining({ isPartial: true, ...lockedArgs }),
            );
        }
    });

    it("should run the found size and its halved sizes when the found size is below the full size", async () => {
        setFoundSize(500n);
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockViolationError) // 500n
            .mockResolvedValueOnce(mockSuccess) // 375n
            .mockResolvedValue(mockViolationError); // rest
        const result = await run();

        assert(result.isOk());
        expect(result.value.estimatedProfit).toBe(25n);
        expect(simulatedSizes()).toEqual([500n, 375n, 250n, 125n, 62n, 31n]);
        for (let i = 0; i < 6; i++) {
            expect((simulatorWithArgsSpy as Mock).mock.calls[i][0]).toEqual(
                expect.objectContaining({ isPartial: true, ...lockedArgs }),
            );
        }
    });

    it("should pick the biggest passing size, not the first one that resolves", async () => {
        const mockBigSuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { size: "big" },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });
        const mockSmallSuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { size: "small" },
            estimatedProfit: 10n,
            oppBlockNumber: 123,
        });
        setFoundSize(1000n);
        // the 750n size passes but resolves after the 500n one
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockViolationError) // 1000n
            .mockImplementationOnce(
                () => new Promise((resolve) => setTimeout(() => resolve(mockBigSuccess), 20)),
            ) // 750n
            .mockResolvedValueOnce(mockSmallSuccess) // 500n
            .mockResolvedValue(mockViolationError); // rest
        const result = await run();

        assert(result.isOk());
        expect(result.value.spanAttributes).toEqual({ size: "big" });
        expect(result.value.estimatedProfit).toBe(50n);
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(6);
    });

    it("should run as many halved sizes as configured by routerPartialFallbackSteps", async () => {
        mockRainSolver.appOptions.routerPartialFallbackSteps = 2;
        setFoundSize(1000n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        // the three quarters size comes on top of the two halved sizes
        assert(result.isErr());
        expect(simulatedSizes()).toEqual([1000n, 750n, 500n, 250n]);
        expect(result.error.spanAttributes["step1.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step4.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step5.error"]).toBeUndefined();
    });

    it("should drop halved sizes that reach zero", async () => {
        orderDetails.takeOrder.quote.maxOutput = 16n;
        setFoundSize(8n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        // the halving hits zero after 1n
        assert(result.isErr());
        expect(simulatedSizes()).toEqual([8n, 6n, 4n, 2n, 1n]);
        expect(result.error.spanAttributes["step5.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step6.error"]).toBeUndefined();
    });

    it("should drop the halved sizes from the first dust one on", async () => {
        (mockRainSolver.state.isDustTrade as Mock).mockImplementation(
            (_pair: any, _price: any, _usd: any, size: bigint) => size < 300n,
        );
        setFoundSize(1000n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        // 250n is dust and so is everything below it
        assert(result.isErr());
        expect(simulatedSizes()).toEqual([1000n, 750n, 500n]);
        expect(result.error.spanAttributes["dustTradeSize"]).toBeUndefined();
    });

    it("should run the found size only when routerPartialFallback is disabled", async () => {
        mockRainSolver.appOptions.routerPartialFallback = false;
        setFoundSize(500n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        assert(result.isErr());
        expect(simulatedSizes()).toEqual([500n]);
        expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
        expect(result.error.spanAttributes["step1.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step2.error"]).toBeUndefined();
    });

    it("should run the halved sizes for a strict checked max owner even when routerPartialFallback is disabled", async () => {
        mockRainSolver.appOptions.routerPartialFallback = false;
        mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
        mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
        setFoundSize(500n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        assert(result.isErr());
        expect(simulatedSizes()).toEqual([500n, 375n, 250n, 125n, 62n, 31n]);
    });

    it("should run the found size only for a non max owner with strict check enabled when routerPartialFallback is disabled", async () => {
        mockRainSolver.appOptions.routerPartialFallback = false;
        mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
        mockRainSolver.appOptions.ownerProfile = { "0xowner": 100 }; // not max profile
        setFoundSize(500n);
        (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
        const result = await run();

        assert(result.isErr());
        expect(simulatedSizes()).toEqual([500n]);
    });

    it("should return the batch failure with the step attributes when every size fails", async () => {
        const mockOtherError = Result.err({
            type: TradeType.Balancer,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "some other revert" },
            noneNodeError: "other",
        });
        setFoundSize(1000n);
        (trySimulateTradeSpy as Mock)
            .mockResolvedValueOnce(mockOtherError) // 1000n
            .mockResolvedValue(mockViolationError); // halved sizes
        const result = await run();

        assert(result.isErr());
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(6);
        // the biggest size failure represents the batch
        expect(result.error.type).toBe(TradeType.Balancer);
        expect(result.error.reason).toBe(SimulationHaltReason.NoOpportunity);
        expect(result.error.noneNodeError).toBe("other");
        expect(result.error.spanAttributes["step1.error"]).toBe("some other revert");
        expect(result.error.spanAttributes["step2.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step6.error"]).toContain(
            "MinimalOutputBalanceViolation",
        );
        expect(result.error.spanAttributes["step7.error"]).toBeUndefined();
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "some other revert" },
            "step1",
        );
    });

    describe("dust found size", () => {
        beforeEach(() => {
            setFoundSize(5n);
            (trySimulateTradeSpy as Mock).mockResolvedValue(mockSuccess);
        });

        it("should ask the state dust check with the found size before any sim", async () => {
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(false);
            const result = await run();

            assert(result.isOk());
            expect(mockRainSolver.state.isDustTrade).toHaveBeenCalledWith(
                orderDetails,
                outputToEthPrice,
                "2000",
                5n,
            );
            // not dust, so the found size gets simulated with its backoff sizes
            expect(simulatedSizes()).toEqual([5n, 3n, 2n, 1n]);
        });

        it("should bail out without any sim when the found size is dust", async () => {
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(true);
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).not.toHaveBeenCalled();
            expect(result.error.reason).toBe(SimulationHaltReason.DustTradeSize);
            expect(result.error.spanAttributes).toEqual({
                dustTradeSize: true,
                error: "dust trade size",
            });
        });

        it("should not count a found size as dust when the state cannot decide", async () => {
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(undefined);
            const result = await run();

            // undecided is not dust, however small the size, so the found
            // size gets simulated with its backoff sizes
            assert(result.isOk());
            expect(simulatedSizes()).toEqual([5n, 3n, 2n, 1n]);
        });

        it("should never count the full size as dust", async () => {
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(true);
            setFoundSize(1000n);
            const result = await run();

            // the full size runs, its halved sizes are all dust though
            assert(result.isOk());
            expect(simulatedSizes()).toEqual([1000n]);
        });

        it("should have no dust logic at all when no check is enabled", async () => {
            // the state is the gate, with no check enabled it never decides
            mockRainSolver.state.isDustCheckEnabled = false;
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(undefined);
            const result = await run();

            // the found size gets simulated with its backoff sizes
            assert(result.isOk());
            expect(simulatedSizes()).toEqual([5n, 3n, 2n, 1n]);
            expect(mockRainSolver.state.isDustTrade).toHaveBeenCalledWith(
                orderDetails,
                outputToEthPrice,
                "2000",
                5n,
            );
        });

        it("should halve from the full size for a strict checked max owner", async () => {
            mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            (mockRainSolver.state.isDustTrade as Mock).mockImplementation(
                (_pair: any, _price: any, _usd: any, size: bigint) => size === 5n,
            );
            (trySimulateTradeSpy as Mock)
                .mockResolvedValueOnce(mockViolationError) // 750n
                .mockResolvedValueOnce(mockSuccess) // 500n
                .mockResolvedValue(mockViolationError); // rest
            const result = await run();

            // the found size never gets simulated, the backoff sizes of the
            // full size do, locked to the found route as well
            assert(result.isOk());
            expect(result.value.estimatedProfit).toBe(25n);
            expect(simulatedSizes()).toEqual([750n, 500n, 250n, 125n, 62n]);
            for (let i = 0; i < 5; i++) {
                expect((simulatorWithArgsSpy as Mock).mock.calls[i][0]).toEqual(
                    expect.objectContaining({ isPartial: true, ...lockedArgs }),
                );
            }
        });

        it("should flag the dust found size when the halved full sizes fail", async () => {
            mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            (mockRainSolver.state.isDustTrade as Mock).mockImplementation(
                (_pair: any, _price: any, _usd: any, size: bigint) => size <= 125n,
            );
            (trySimulateTradeSpy as Mock).mockResolvedValue(mockViolationError);
            const result = await run();

            assert(result.isErr());
            expect(simulatedSizes()).toEqual([750n, 500n, 250n]);
            expect(result.error.spanAttributes["dustTradeSize"]).toBe(true);
            expect(result.error.spanAttributes["step3.error"]).toContain(
                "MinimalOutputBalanceViolation",
            );
            expect(result.error.spanAttributes["step4.error"]).toBeUndefined();
        });

        it("should bail out for a strict checked max owner when every halved full size is dust too", async () => {
            mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(true);
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).not.toHaveBeenCalled();
            expect(result.error.reason).toBe(SimulationHaltReason.DustTradeSize);
            expect(result.error.spanAttributes).toEqual({
                dustTradeSize: true,
                error: "dust trade size",
            });
        });

        it("should bail out for a max owner when strict check is disabled", async () => {
            mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = false;
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(true);
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).not.toHaveBeenCalled();
            expect(result.error.reason).toBe(SimulationHaltReason.DustTradeSize);
        });

        it("should bail out for a non max owner when strict check is enabled", async () => {
            mockRainSolver.appOptions.strictMaxOwnerProfilePartialTradeSizeCheck = true;
            mockRainSolver.appOptions.ownerProfile = { "0xowner": 100 }; // not max profile
            (mockRainSolver.state.isDustTrade as Mock).mockReturnValue(true);
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).not.toHaveBeenCalled();
            expect(result.error.reason).toBe(SimulationHaltReason.DustTradeSize);
        });
    });

    describe("secondary route try", () => {
        // a found route with a single dex, so the retry excludes exactly it
        const hydrexQuote = {
            route: {
                pcMap: new Map([["pool1", { liquidityProvider: "Hydrex" }]]),
                route: { legs: [{ uniqueId: "pool1" }] },
            },
        } as any;
        const mockDryrunError = Result.err({
            type: TradeType.RouteProcessor,
            reason: SimulationHaltReason.NoOpportunity,
            spanAttributes: { error: "dryrun failed" },
            noneNodeError: "full failed",
        });
        const mockRetrySuccess = Result.ok({
            type: TradeType.RouteProcessor,
            spanAttributes: { foundOpp: true },
            estimatedProfit: 50n,
            oppBlockNumber: 123,
        });

        beforeEach(() => {
            // a single size per attempt keeps the sim sequence simple
            mockRainSolver.appOptions.routerPartialFallbackSteps = 0;
            setFoundSize(1000n, hydrexQuote);
            (trySimulateTradeSpy as Mock)
                .mockResolvedValueOnce(mockDryrunError) // primary attempt
                .mockResolvedValueOnce(mockRetrySuccess); // secondary attempt
        });

        it("should retry with the found route dexes excluded when the batch fails onchain", async () => {
            const result = await run();

            assert(result.isOk());
            expect(result.value.spanAttributes).toEqual({ foundOpp: true });
            expect(result.value.estimatedProfit).toBe(50n);
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
            // the size finder runs again with the dexes excluded
            expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledTimes(2);
            expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenLastCalledWith(
                orderDetails,
                toToken,
                fromToken,
                1000n,
                100n,
                undefined,
                false,
                new Set(["Hydrex"]),
            );
            expect(simulatorWithArgsSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    maximumInputFixed: 1000n,
                    excludeDexes: new Set(["Hydrex"]),
                    sushiQuote: hydrexQuote,
                }),
            );
        });

        it("should not retry when the batch fails for a reason other than an onchain rejection", async () => {
            (trySimulateTradeSpy as Mock).mockReset();
            (trySimulateTradeSpy as Mock).mockResolvedValue(
                Result.err({
                    type: TradeType.RouteProcessor,
                    reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
                    spanAttributes: { error: "no address" },
                }),
            );
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
            expect(result.error.spanAttributes["secondary.step1.error"]).toBeUndefined();
        });

        it("should retry for every order when set to all", async () => {
            mockRainSolver.appOptions.routerSecondaryRouteTry = "all";
            mockRainSolver.appOptions.ownerProfile = { "0xother": Number.MAX_SAFE_INTEGER };
            const result = await run();

            assert(result.isOk());
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        });

        it("should retry only for max profile owners when set to max", async () => {
            mockRainSolver.appOptions.routerSecondaryRouteTry = "max";
            // non max owner, no retry
            mockRainSolver.appOptions.ownerProfile = { "0xother": Number.MAX_SAFE_INTEGER };
            let result = await run();
            assert(result.isErr());
            expect(result.error.spanAttributes["secondary.step1.error"]).toBeUndefined();
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);

            // max owner, retry
            (trySimulateTradeSpy as Mock).mockReset();
            (trySimulateTradeSpy as Mock)
                .mockResolvedValueOnce(mockDryrunError)
                .mockResolvedValueOnce(mockRetrySuccess);
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            result = await run();
            assert(result.isOk());
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
        });

        it("should never retry when set to off", async () => {
            mockRainSolver.appOptions.routerSecondaryRouteTry = "off";
            mockRainSolver.appOptions.ownerProfile = { "0xowner": Number.MAX_SAFE_INTEGER };
            const result = await run();

            assert(result.isErr());
            expect(result.error.spanAttributes["secondary.step1.error"]).toBeUndefined();
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
        });

        it("should return the primary error with the secondary attributes when the retry also fails", async () => {
            const mockRetryError = Result.err({
                type: TradeType.RouteProcessor,
                reason: SimulationHaltReason.NoOpportunity,
                spanAttributes: { error: "retry dryrun failed" },
                noneNodeError: "retry failed",
            });
            (trySimulateTradeSpy as Mock).mockReset();
            (trySimulateTradeSpy as Mock)
                .mockResolvedValueOnce(mockDryrunError)
                .mockResolvedValueOnce(mockRetryError);
            const result = await run();

            assert(result.isErr());
            expect(result.error.noneNodeError).toBe("full failed");
            expect(result.error.type).toBe(TradeType.RouteProcessor);
            expect(result.error.spanAttributes).toEqual({
                "step1.error": "dryrun failed",
                "secondary.step1.error": "retry dryrun failed",
            });
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
            expect(extendObjectWithHeader).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Object),
                "secondary",
            );
        });

        it("should not retry when no route was found with the dexes excluded", async () => {
            (mockRainSolver.state.router.findLargestTradeSize as Mock)
                .mockReturnValueOnce({
                    status: TradeSizeStatus.Found,
                    size: 1000n,
                    quote: hydrexQuote,
                })
                .mockReturnValueOnce({ status: TradeSizeStatus.NoWay });
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
            expect(result.error.spanAttributes["secondary.error"]).toBe(
                "found no route for any trade size",
            );
        });

        it("should not retry when the found route spans more than one dex", async () => {
            setFoundSize(1000n, {
                route: {
                    pcMap: new Map([
                        ["pool1", { liquidityProvider: "Hydrex" }],
                        ["pool2", { liquidityProvider: "UniswapV3" }],
                    ]),
                    route: { legs: [{ uniqueId: "pool1" }, { uniqueId: "pool2" }] },
                },
            });
            const result = await run();

            assert(result.isErr());
            expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
            expect(mockRainSolver.state.router.findLargestTradeSize).toHaveBeenCalledTimes(1);
            expect(result.error.spanAttributes["secondary.step1.error"]).toBeUndefined();
        });
    });

    it("should return early if ethPrice is unknown", async () => {
        const result: SimulationResult = await findBestRouterTrade.call(
            mockRainSolver,
            orderDetails,
            signer,
            "",
            toToken,
            fromToken,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe("router");
        expect(result.error.spanAttributes.error).toBe(
            "no route to get price of input token to eth",
        );
        expect(mockRainSolver.state.router.findLargestTradeSize).not.toHaveBeenCalled();
    });

    it("should return error when trade addresses are not configured", async () => {
        (mockRainSolver.state.contracts.getAddressesForTrade as Mock).mockReturnValue(undefined);
        const result = await run();

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Router);
        expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
        expect(mockRainSolver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Router,
        );
        expect(mockRainSolver.state.router.findLargestTradeSize).not.toHaveBeenCalled();
    });
});

describe("Test getHalvedTradeSizes", () => {
    it("should start at three quarters and halve the size as many times as the steps", () => {
        expect(getHalvedTradeSizes(1000n, 4)).toEqual([750n, 500n, 250n, 125n, 62n]);
        expect(getHalvedTradeSizes(1000n, 1)).toEqual([750n, 500n]);
        // no steps means no sizes at all, not even the three quarters one
        expect(getHalvedTradeSizes(1000n, 0)).toEqual([]);
    });

    it("should stop at the first size that reaches zero", () => {
        expect(getHalvedTradeSizes(8n, 10)).toEqual([6n, 4n, 2n, 1n]);
        expect(getHalvedTradeSizes(1n, 10)).toEqual([]);
        expect(getHalvedTradeSizes(0n, 10)).toEqual([]);
    });

    it("should stop at the first dust size", () => {
        const isDust = (size: bigint) => size < 200n;
        expect(getHalvedTradeSizes(1000n, 4, isDust)).toEqual([750n, 500n, 250n]);
        // 225n clears, its half 150n is dust
        expect(getHalvedTradeSizes(300n, 4, isDust)).toEqual([225n]);
        // a dust three quarters size means no sizes at all
        expect(getHalvedTradeSizes(200n, 4, isDust)).toEqual([]);
    });
});
