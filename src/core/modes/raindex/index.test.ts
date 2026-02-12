import { Router } from "sushi";
import * as utils from "./utils";
import { parseUnits } from "viem";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { TradeType } from "../../types";
import { Result } from "../../../common";
import { SushiRouter } from "../../../router";
import { RainSolverSigner } from "../../../signer";
import { SimulationHaltReason } from "../simulator";
import { extendObjectWithHeader } from "../../../common";
import { RaindexRouterTradeSimulator } from "./simulation";
import { estimateProfit, findBestRaindexRouterTrade } from "./index";
import { describe, it, expect, vi, Mock, beforeEach, assert } from "vitest";

// mocks
vi.mock("../../../common", async (importOriginal) => ({
    ...(await importOriginal()),
    extendObjectWithHeader: vi.fn(),
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

describe("Test findBestRaindexRouterTrade function", () => {
    let solver: RainSolver;
    let signer: RainSolverSigner;
    let fromToken: Token;
    let isV4OrderbookV6Spy: any;
    let routeProcessor4ParamsSpy: any;
    let visualizeRouteSpy: any;
    let raindexRouterTradeSimulatorWithArgsSpy: any;
    let trySimulateTradeSpy: any;
    const blockNumber = 1000n;
    const inputToEthPrice = "0.5";
    const outputToEthPrice = "1.0";

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup mock solver
        solver = {
            state: {
                chainConfig: {
                    id: 1,
                    routeProcessors: {
                        "4": "0xrouteprocessor",
                    },
                },
                contracts: {
                    getAddressesForTrade: vi.fn().mockReturnValue({
                        destination: "0xdestination",
                        arb: "0xarb",
                    }),
                },
                router: {
                    sushi: {
                        tryQuote: vi.fn(),
                    },
                },
                gasPrice: 50000000000n,
                appOptions: {
                    route: "classic",
                },
            },
            orderManager: {
                getCounterpartyOrdersAgainstBaseTokens: vi.fn(),
            },
        } as any;

        signer = {
            address: "0xsigner",
        } as any;

        fromToken = new Token({
            chainId: 1,
            decimals: 18,
            address: "0xfrom",
            symbol: "FROM",
        });

        isV4OrderbookV6Spy = vi.spyOn(Pair, "isV4OrderbookV6");
        routeProcessor4ParamsSpy = vi.spyOn(Router, "routeProcessor4Params");
        visualizeRouteSpy = vi.spyOn(SushiRouter, "visualizeRoute");
        raindexRouterTradeSimulatorWithArgsSpy = vi.spyOn(RaindexRouterTradeSimulator, "withArgs");
        trySimulateTradeSpy = vi.fn();
    });

    it("should return error for non-v6 orderbook order", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                id: "0xhash",
                struct: {
                    orderbook: { id: "0xorderbook" },
                },
            },
        } as any;

        isV4OrderbookV6Spy.mockReturnValue(false);

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
        expect(result.error.spanAttributes.error).toBe(
            "Cannot trade as raindex router as order is not deployed on v6 orderbook",
        );
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).not.toHaveBeenCalledWith();
        expect(
            solver.orderManager.getCounterpartyOrdersAgainstBaseTokens,
        ).not.toHaveBeenCalledWith();
        expect(solver.state.router.sushi!.tryQuote).not.toHaveBeenCalledWith();
        expect(routeProcessor4ParamsSpy).not.toHaveBeenCalled();
        expect(visualizeRouteSpy).not.toHaveBeenCalled();
        expect(raindexRouterTradeSimulatorWithArgsSpy).not.toHaveBeenCalled();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
    });

    it("should return error when raindex arb address is not configured", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            takeOrder: {
                id: "0xhash",
                struct: {
                    orderbook: { id: "0xorderbook" },
                },
            },
        } as any;

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.state.contracts.getAddressesForTrade as Mock).mockReturnValue(undefined);

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.reason).toBe(SimulationHaltReason.UndefinedTradeDestinationAddress);
        expect(result.error.spanAttributes.error).toBe(
            "Cannot trade as raindex router arb address is not configured for v6 orderbook trade",
        );
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(
            solver.orderManager.getCounterpartyOrdersAgainstBaseTokens,
        ).not.toHaveBeenCalledWith();
        expect(solver.state.router.sushi!.tryQuote).not.toHaveBeenCalledWith();
        expect(routeProcessor4ParamsSpy).not.toHaveBeenCalled();
        expect(visualizeRouteSpy).not.toHaveBeenCalled();
        expect(raindexRouterTradeSimulatorWithArgsSpy).not.toHaveBeenCalled();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
    });

    it("should return error when no counterparty orders found", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map(),
        );

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.spanAttributes.error).toContain(
            "no counterparties found for raindex router trade",
        );
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).not.toHaveBeenCalledWith();
        expect(routeProcessor4ParamsSpy).not.toHaveBeenCalled();
        expect(visualizeRouteSpy).not.toHaveBeenCalled();
        expect(raindexRouterTradeSimulatorWithArgsSpy).not.toHaveBeenCalled();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
    });

    it("should skip counterparty when sushi quote fails", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        const counterpartyOrder = {
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xcounterpartyhash",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    order: { owner: "0xcounterpartyowner" },
                },
            },
        } as any;

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map([["0xbasetoken", [counterpartyOrder]]]),
        );

        (solver.state.router.sushi!.tryQuote as Mock).mockResolvedValue(Result.err("Quote failed"));

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.spanAttributes.error).toContain(
            "no counterparties found for raindex router trade",
        );
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenCalledWith({
            fromToken,
            toToken: new Token({
                chainId: solver.state.chainConfig.id,
                decimals: counterpartyOrder.buyTokenDecimals,
                address: counterpartyOrder.buyToken,
                symbol: counterpartyOrder.buyTokenSymbol,
            }),
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(routeProcessor4ParamsSpy).not.toHaveBeenCalled();
        expect(visualizeRouteSpy).not.toHaveBeenCalled();
        expect(raindexRouterTradeSimulatorWithArgsSpy).not.toHaveBeenCalled();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
    });

    it("should filter out same order and same owner from counterparties", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        // Same order ID - should be filtered
        const sameOrder = {
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    order: { owner: "0xanotherowner" },
                },
            },
        } as any;

        // Same owner - should be filtered
        const sameOwner = {
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xanotherhash",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    order: { owner: "0xOWNER" }, // case insensitive
                },
            },
        } as any;
        const toToken = new Token({
            chainId: solver.state.chainConfig.id,
            decimals: sameOrder.buyTokenDecimals,
            address: sameOrder.buyToken,
            symbol: sameOrder.buyTokenSymbol,
        });

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map([["0xbasetoken", [sameOrder, sameOwner]]]),
        );

        const mockQuote = {
            amountOut: 100n,
            price: parseUnits("1", 18),
            route: {
                pcMap: new Map(),
                route: {
                    legs: [],
                },
            },
        };

        (solver.state.router.sushi!.tryQuote as Mock).mockResolvedValue(Result.ok(mockQuote));
        routeProcessor4ParamsSpy.mockReturnValue({} as any);
        visualizeRouteSpy.mockReturnValue([]);

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        // Should return error as all counterparties are filtered
        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.spanAttributes.error).toContain(
            "no counterparties found for raindex router trade",
        );
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenNthCalledWith(1, {
            fromToken,
            toToken: toToken,
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(routeProcessor4ParamsSpy).toHaveBeenCalledTimes(1);
        expect(visualizeRouteSpy).toHaveBeenNthCalledWith(1, fromToken, toToken, expect.any(Array));
        expect(raindexRouterTradeSimulatorWithArgsSpy).not.toHaveBeenCalled();
        expect(trySimulateTradeSpy).not.toHaveBeenCalled();
    });

    it("should successfully simulate trade with valid counterparty", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        const counterpartyOrder = {
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xcounterpartyhash",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xcounterpartyowner" },
                },
            },
        } as any;
        const toToken = new Token({
            chainId: solver.state.chainConfig.id,
            decimals: counterpartyOrder.buyTokenDecimals,
            address: counterpartyOrder.buyToken,
            symbol: counterpartyOrder.buyTokenSymbol,
        });

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map([["0xbasetoken", [counterpartyOrder]]]),
        );

        const mockQuote = {
            amountOut: 100n,
            price: parseUnits("1", 18),
            route: {
                pcMap: new Map(),
                route: {
                    legs: [],
                },
            },
        };

        (solver.state.router.sushi!.tryQuote as Mock).mockResolvedValue(Result.ok(mockQuote));
        routeProcessor4ParamsSpy.mockReturnValue({ rp: "value" } as any);
        visualizeRouteSpy.mockReturnValue(["route"]);

        const mockSimulationResult = Result.ok({
            type: TradeType.Raindex,
            estimatedProfit: 1000n,
            spanAttributes: { key: "value" },
        });

        raindexRouterTradeSimulatorWithArgsSpy.mockReturnValue({
            trySimulateTrade: trySimulateTradeSpy.mockResolvedValue(mockSimulationResult),
        });

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isOk());
        expect(result.value.type).toBe(TradeType.Raindex);
        expect(result.value.spanAttributes.key).toBe("value");
        expect(result.value.estimatedProfit).toBe(1000n);
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenNthCalledWith(1, {
            fromToken,
            toToken: toToken,
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(routeProcessor4ParamsSpy).toHaveBeenCalledTimes(1);
        expect(visualizeRouteSpy).toHaveBeenNthCalledWith(1, fromToken, toToken, expect.any(Array));
        expect(raindexRouterTradeSimulatorWithArgsSpy).toHaveBeenCalledWith({
            type: TradeType.Raindex,
            solver,
            orderDetails,
            counterpartyOrderDetails: counterpartyOrder,
            signer,
            maximumInputFixed: expect.any(BigInt),
            counterpartyInputToEthPrice: expect.any(BigInt),
            counterpartyOutputToEthPrice: expect.any(BigInt),
            blockNumber,
            quote: expect.anything(),
            profit: expect.any(BigInt),
            rpParams: { rp: "value" },
            routeVisual: ["route"],
        });
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
    });

    it("should pick trade with highest estimated profit from multiple options", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        const counterparty1 = {
            buyToken: "0xto1",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xcounterparty1",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner1" },
                },
            },
        } as any;

        const counterparty2 = {
            buyToken: "0xto2",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xcounterparty2",
                quote: {
                    maxOutput: parseUnits("60", 18),
                    ratio: parseUnits("1.2", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner2" },
                },
            },
        } as any;
        const toToken1 = new Token({
            chainId: solver.state.chainConfig.id,
            decimals: counterparty1.buyTokenDecimals,
            address: counterparty1.buyToken,
            symbol: counterparty1.buyTokenSymbol,
        });
        const toToken2 = new Token({
            chainId: solver.state.chainConfig.id,
            decimals: counterparty2.buyTokenDecimals,
            address: counterparty2.buyToken,
            symbol: counterparty2.buyTokenSymbol,
        });

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map([
                ["0xbasetoken1", [counterparty1]],
                ["0xbasetoken2", [counterparty2]],
            ]),
        );

        const mockQuote = {
            amountOut: 100n,
            price: parseUnits("1", 18),
            route: {
                pcMap: new Map(),
                route: { legs: [] },
            },
        };

        (solver.state.router.sushi!.tryQuote as Mock).mockResolvedValue(Result.ok(mockQuote));
        routeProcessor4ParamsSpy.mockReturnValue({ rp: "value" } as any);
        visualizeRouteSpy.mockReturnValue(["route"]);

        let callCount = 0;
        raindexRouterTradeSimulatorWithArgsSpy.mockReturnValue({
            trySimulateTrade: trySimulateTradeSpy.mockImplementation(() => {
                callCount++;
                // First call returns lower profit, second returns higher profit
                return Promise.resolve(
                    Result.ok({
                        type: TradeType.Raindex,
                        estimatedProfit: callCount === 1 ? 500n : 1500n,
                        spanAttributes: { key: "value" },
                    }),
                );
            }),
        } as any);

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isOk());
        // Should pick the one with highest profit (1500n)
        expect(result.value.estimatedProfit).toBe(1500n);
        expect(result.value.spanAttributes.key).toBe("value");
        expect(extendObjectWithHeader).not.toHaveBeenCalled();
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenNthCalledWith(1, {
            fromToken,
            toToken: toToken1,
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenNthCalledWith(2, {
            fromToken,
            toToken: toToken2,
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(routeProcessor4ParamsSpy).toHaveBeenCalledTimes(2);
        expect(visualizeRouteSpy).toHaveBeenNthCalledWith(
            1,
            fromToken,
            toToken1,
            expect.any(Array),
        );
        expect(visualizeRouteSpy).toHaveBeenNthCalledWith(
            2,
            fromToken,
            toToken2,
            expect.any(Array),
        );
        expect(raindexRouterTradeSimulatorWithArgsSpy).toHaveBeenNthCalledWith(1, {
            type: TradeType.Raindex,
            solver,
            orderDetails,
            counterpartyOrderDetails: counterparty1,
            signer,
            maximumInputFixed: expect.any(BigInt),
            counterpartyInputToEthPrice: expect.any(BigInt),
            counterpartyOutputToEthPrice: expect.any(BigInt),
            blockNumber,
            quote: expect.anything(),
            profit: expect.any(BigInt),
            rpParams: { rp: "value" },
            routeVisual: ["route"],
        });
        expect(raindexRouterTradeSimulatorWithArgsSpy).toHaveBeenNthCalledWith(2, {
            type: TradeType.Raindex,
            solver,
            orderDetails,
            counterpartyOrderDetails: counterparty2,
            signer,
            maximumInputFixed: expect.any(BigInt),
            counterpartyInputToEthPrice: expect.any(BigInt),
            counterpartyOutputToEthPrice: expect.any(BigInt),
            blockNumber,
            quote: expect.anything(),
            profit: expect.any(BigInt),
            rpParams: { rp: "value" },
            routeVisual: ["route"],
        });
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(2);
    });

    it("should aggregate errors when all simulations fail", async () => {
        const orderDetails = {
            orderbook: "0xorderbook",
            sellTokenDecimals: 18,
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xhash",
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xowner" },
                },
            },
        } as any;

        const counterpartyOrder = {
            buyToken: "0xto",
            buyTokenDecimals: 18,
            buyTokenSymbol: "TO",
            takeOrder: {
                id: "0xcounterpartyhash",
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
                struct: {
                    orderbook: { id: "0xorderbook" },
                    order: { owner: "0xcounterpartyowner" },
                },
            },
        } as any;
        const toToken = new Token({
            chainId: solver.state.chainConfig.id,
            decimals: counterpartyOrder.buyTokenDecimals,
            address: counterpartyOrder.buyToken,
            symbol: counterpartyOrder.buyTokenSymbol,
        });

        isV4OrderbookV6Spy.mockReturnValue(true);
        (solver.orderManager.getCounterpartyOrdersAgainstBaseTokens as Mock).mockReturnValue(
            new Map([["0xbasetoken", [counterpartyOrder]]]),
        );

        const mockQuote = {
            amountOut: 100n,
            price: parseUnits("1", 18),
            route: {
                pcMap: new Map(),
                route: { legs: [] },
            },
        };

        (solver.state.router.sushi!.tryQuote as Mock).mockResolvedValue(Result.ok(mockQuote));
        routeProcessor4ParamsSpy.mockReturnValue({ rp: "value" } as any);
        visualizeRouteSpy.mockReturnValue(["route"]);

        const mockError = Result.err({
            type: TradeType.Raindex,
            spanAttributes: { error: "Simulation failed" },
            noneNodeError: "Node error",
        });

        raindexRouterTradeSimulatorWithArgsSpy.mockReturnValue({
            trySimulateTrade: trySimulateTradeSpy.mockResolvedValue(mockError),
        } as any);

        const result = await findBestRaindexRouterTrade.call(
            solver,
            orderDetails,
            signer,
            fromToken,
            inputToEthPrice,
            outputToEthPrice,
            blockNumber,
        );

        assert(result.isErr());
        expect(result.error.type).toBe(TradeType.Raindex);
        expect(result.error.noneNodeError).toBe("Node error");
        expect(extendObjectWithHeader).toHaveBeenCalledWith(
            expect.any(Object),
            { error: "Simulation failed" },
            "raindexRouter.0",
        );
        expect(isV4OrderbookV6Spy).toHaveBeenCalledWith(orderDetails);
        expect(solver.state.contracts.getAddressesForTrade).toHaveBeenCalledWith(
            orderDetails,
            TradeType.Raindex,
        );
        expect(solver.orderManager.getCounterpartyOrdersAgainstBaseTokens).toHaveBeenCalledWith(
            orderDetails,
        );
        expect(solver.state.router.sushi!.tryQuote).toHaveBeenNthCalledWith(1, {
            fromToken,
            toToken: toToken,
            amountIn: expect.any(BigInt),
            gasPrice: solver.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: solver.state.appOptions.route,
        });
        expect(routeProcessor4ParamsSpy).toHaveBeenCalledTimes(1);
        expect(visualizeRouteSpy).toHaveBeenNthCalledWith(1, fromToken, toToken, expect.any(Array));
        expect(raindexRouterTradeSimulatorWithArgsSpy).toHaveBeenNthCalledWith(1, {
            type: TradeType.Raindex,
            solver,
            orderDetails,
            counterpartyOrderDetails: counterpartyOrder,
            signer,
            maximumInputFixed: expect.any(BigInt),
            counterpartyInputToEthPrice: expect.any(BigInt),
            counterpartyOutputToEthPrice: expect.any(BigInt),
            blockNumber,
            quote: expect.anything(),
            profit: expect.any(BigInt),
            rpParams: { rp: "value" },
            routeVisual: ["route"],
        });
        expect(trySimulateTradeSpy).toHaveBeenCalledTimes(1);
    });
});

describe("Test estimateProfit function", () => {
    let calcCounterpartyInputProfitSpy: any;
    let calcCounterpartyOutputToEthPriceSpy: any;
    let calcCounterpartyInputToEthPriceSpy: any;

    beforeEach(() => {
        calcCounterpartyInputProfitSpy = vi.spyOn(utils, "calcCounterpartyInputProfit");
        calcCounterpartyOutputToEthPriceSpy = vi.spyOn(utils, "calcCounterpartyOutputToEthPrice");
        calcCounterpartyInputToEthPriceSpy = vi.spyOn(utils, "calcCounterpartyInputToEthPrice");
    });

    it("should return zero profit when order max input exceeds counterparty max output", () => {
        const orderDetails = {
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("3", 18), // High ratio
                },
            },
        } as any;

        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
            },
        } as any;

        const quote = {} as any;

        (calcCounterpartyInputProfitSpy as Mock).mockReturnValueOnce({
            counterpartyMaxOutput: 0n,
            counterpartyInputProfit: parseUnits("200", 18),
        });
        const result = estimateProfit(orderDetails, counterparty, quote);

        // orderMaxInput: 100e18 * 3e18 / 1e18 = 300e18
        // counterpartyMaxOutput: 40e18 (less than 300e18)
        // Cannot trade, returns zero
        expect(result.profit).toBe(0n);
        expect(result.counterpartyInputToEthPrice).toBe(0n);
        expect(result.counterpartyOutputToEthPrice).toBe(0n);
        expect(calcCounterpartyInputProfitSpy).toHaveBeenCalledWith(counterparty, quote);
        expect(calcCounterpartyInputToEthPriceSpy).not.toHaveBeenCalled();
        expect(calcCounterpartyOutputToEthPriceSpy).not.toHaveBeenCalled();
    });

    it("should return corrrect profit when order max input is lower counterparty max output", () => {
        const orderDetails = {
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("100", 18),
                    ratio: parseUnits("3", 18),
                },
            },
        } as any;

        const counterparty = {
            buyTokenDecimals: 18,
            takeOrder: {
                quote: {
                    maxOutput: parseUnits("50", 18),
                    ratio: parseUnits("1", 18),
                },
            },
        } as any;

        const quote = {} as any;

        (calcCounterpartyInputProfitSpy as Mock).mockReturnValueOnce({
            counterpartyMaxOutput: parseUnits("400", 18),
            counterpartyInputProfit: parseUnits("100", 18),
        });
        (calcCounterpartyInputToEthPriceSpy as Mock).mockReturnValueOnce(parseUnits("1.5", 18));
        (calcCounterpartyOutputToEthPriceSpy as Mock).mockReturnValueOnce(parseUnits("2.5", 18));
        const result = estimateProfit(orderDetails, counterparty, quote, "1", "2");

        // orderMaxInput: 100e18 * 3e18 / 1e18 = 300e18
        // counterpartyMaxOutput: 400e18 (more than 300e18)
        expect(result.profit).toBe(parseUnits("250", 18) + parseUnits("150", 18));
        expect(result.counterpartyInputToEthPrice).toBe(parseUnits("1.5", 18));
        expect(result.counterpartyOutputToEthPrice).toBe(parseUnits("2.5", 18));
        expect(calcCounterpartyInputProfitSpy).toHaveBeenCalledWith(counterparty, quote);
        expect(calcCounterpartyInputToEthPriceSpy).toHaveBeenCalledWith(quote, "2");
        expect(calcCounterpartyOutputToEthPriceSpy).toHaveBeenCalledWith(
            parseUnits("1.5", 18),
            counterparty.takeOrder.quote!.ratio,
            "1",
        );
    });
});
