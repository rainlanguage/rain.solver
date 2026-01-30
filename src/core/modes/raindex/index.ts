import assert from "assert";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Token } from "sushi/currency";
import { Router, RPParams } from "sushi";
import { Attributes } from "@opentelemetry/api";
import { RainSolverSigner } from "../../../signer";
import { ONE18, scaleFrom18 } from "../../../math";
import { SimulationHaltReason } from "../simulator";
import { RaindexRouterTradeSimulator } from "./simulation";
import { SimulationResult, TradeType } from "../../types";
import { getOptimalSortedList } from "../../../order/pair";
import { SushiRouter, SushiRouterQuote } from "../../../router";
import { Result, extendObjectWithHeader } from "../../../common";
import { calcCounterpartyInputProfit, calcCounterpartyInputToEthPrice, calcCounterpartyOutputToEthPrice } from "./utils";

export enum RouteLegType {
    RAINDEX,
    SUSHI,
    BALANCER,
    STABULL,
}

/**
 * Tries to find the best raindex routed trade for the given order,
 * it will simultaneously try to find the best trade against other
 * orders routed through a middle base token swaped through sushi RP
 * @param this - RainSolver instance
 * @param orderDetails - The details of the order to be processed
 * @param signer - The signer to be used for the trade
 * @param fromToken - Order's output token
 * @param inputToEthPrice - The current price of input token to ETH price
 * @param outputToEthPrice - The current price of output token to ETH price
 * @param blockNumber - The current block number
 */
export async function findBestRaindexRouterTrade(
    this: RainSolver,
    orderDetails: Pair,
    signer: RainSolverSigner,
    fromToken: Token,
    inputToEthPrice: string,
    outputToEthPrice: string,
    blockNumber: bigint,
): Promise<SimulationResult> {
    const spanAttributes: Attributes = {};

    if (!Pair.isV4OrderbookV6(orderDetails)) {
        spanAttributes["error"] =
            "Cannot trade as raindex router as order is not deployed on v6 orderbook";
        return Result.err({
            type: TradeType.Raindex,
            spanAttributes,
            reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
        });
    }

    // exit early if required trade addresses are not configured
    const addresses = this.state.contracts.getAddressesForTrade(orderDetails, TradeType.Raindex);
    if (!addresses) {
        spanAttributes["error"] =
            "Cannot trade as raindex router arb address is not configured for v6 orderbook trade";
        return Result.err({
            type: TradeType.Raindex,
            spanAttributes,
            reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
        });
    }

    const counterpartyOrders =
        this.orderManager.getCounterpartyOrdersAgainstBaseTokens(orderDetails);
    const maximumInputFixed = orderDetails.takeOrder.quote!.maxOutput;
    const maximumInput = scaleFrom18(maximumInputFixed, orderDetails.sellTokenDecimals);

    // get quotes and swap routes for each token base
    const quotes: Map<
        string,
        { rpParams: RPParams; quote: SushiRouterQuote; routeVisual: string[] }
    > = new Map();
    for (const [baseTkn, counterpartyList] of counterpartyOrders) {
        if (!counterpartyList.length || !this.state.router.sushi) continue;

        const toToken = new Token({
            chainId: this.state.chainConfig.id,
            decimals: counterpartyList[0].buyTokenDecimals,
            address: counterpartyList[0].buyToken,
            symbol: counterpartyList[0].buyTokenSymbol,
        });

        // get route details from sushi dataFetcher
        const quoteResult = await this.state.router.sushi?.tryQuote({
            fromToken,
            toToken,
            amountIn: maximumInput,
            gasPrice: this.state.gasPrice,
            blockNumber,
            skipFetch: true,
            sushiRouteType: this.state.appOptions.route,
        });

        // exit early if no route found
        if (quoteResult.isErr()) {
            continue;
        }
        const quote = quoteResult.value;

        const routeVisual: string[] = [];
        try {
            SushiRouter.visualizeRoute(
                fromToken,
                toToken,
                quoteResult.value.route.route.legs,
            ).forEach((v) => {
                routeVisual.push(v);
            });
        } catch {
            /**/
        }

        const rpParams = Router.routeProcessor4Params(
            quoteResult.value.route.pcMap,
            quoteResult.value.route.route,
            fromToken,
            toToken,
            addresses.destination, // destination is the sushi rp arb address
            this.state.chainConfig.routeProcessors["4"],
        );

        quotes.set(baseTkn, {
            rpParams,
            quote,
            routeVisual,
        });
    }

    // get optimal trades for each route and estimate profit
    // for each optimal trade option and then sort them desc
    const optimalTradeOptions: ({
        counterparty: Pair;
        rpParams: RPParams;
        quote: SushiRouterQuote;
        routeVisual: string[];
    } & ReturnType<typeof estimateProfit>)[] = [];
    for (const [baseTkn, quote] of quotes) {
        const counterpartyList = counterpartyOrders.get(baseTkn);
        if (!counterpartyList) continue;

        const optimals = getOptimalSortedList(
            counterpartyList.filter(
                (v) =>
                    v.takeOrder.quote &&
                    // not same order
                    v.takeOrder.id !== orderDetails.takeOrder.id &&
                    // not same owner
                    v.takeOrder.struct.order.owner.toLowerCase() !==
                        orderDetails.takeOrder.struct.order.owner.toLowerCase(),
            ),
        );

        for (const counterparty of optimals) {
            optimalTradeOptions.push({
                ...estimateProfit(
                    orderDetails,
                    counterparty,
                    quote.quote,
                    inputToEthPrice,
                    outputToEthPrice,
                ),
                ...quote,
                counterparty,
            });
        }
    }

    // sort desc based on profitability
    optimalTradeOptions.sort((a, b) => {
        if (a.profit < b.profit) return 1;
        else if (a.profit > b.profit) return -1;
        else return 0;
    });

    // simulate top 3 picks
    const promises = optimalTradeOptions.slice(0, 3).map((args) => {
        const {
            quote,
            profit,
            rpParams,
            routeVisual,
            counterparty: counterpartyOrderDetails,
            counterpartyInputToEthPrice,
            counterpartyOutputToEthPrice,
        } = args;
        if (!Pair.isV4OrderbookV6(counterpartyOrderDetails)) {
            spanAttributes["error"] =
                "Cannot trade as raindex router as counterparty order is not deployed on v6 orderbook";
            return Result.err({
                type: TradeType.Raindex,
                spanAttributes,
                reason: SimulationHaltReason.UndefinedTradeDestinationAddress,
            }) as SimulationResult;
        }
        return RaindexRouterTradeSimulator.withArgs({
            type: TradeType.Raindex,
            solver: this,
            orderDetails,
            counterpartyOrderDetails,
            signer,
            maximumInputFixed,
            counterpartyInputToEthPrice,
            counterpartyOutputToEthPrice,
            blockNumber,
            quote,
            profit,
            rpParams,
            routeVisual,
        }).trySimulateTrade();
    });

    const results = await Promise.all(promises);
    if (results.some((res) => res.isOk())) {
        // pick the one with highest estimated profit
        return results.sort((a, b) => {
            if (a.isErr() && b.isErr()) return 0;
            if (a.isErr()) return 1;
            if (b.isErr()) return -1;
            return a.value.estimatedProfit < b.value.estimatedProfit
                ? 1
                : a.value.estimatedProfit > b.value.estimatedProfit
                  ? -1
                  : 0;
        })[0];
    } else {
        const allNoneNodeErrors: (string | undefined)[] = [];
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            assert(res.isErr()); // for type check as we know all results are errors
            extendObjectWithHeader(spanAttributes, res.error.spanAttributes, "raindexRouter." + i);
            allNoneNodeErrors.push(res.error.noneNodeError);
        }
        if (!results.length) {
            spanAttributes["error"] = "no counterparties found for raindex router trade";
        }
        return Result.err({
            type: TradeType.Raindex,
            spanAttributes,
            noneNodeError: allNoneNodeErrors[0],
        });
    }
}

export function estimateProfit(
    orderDetails: Pair,
    counterparty: Pair,
    quote: SushiRouterQuote,
    inputToEthPrice?: string,
    outputToEthPrice?: string,
): {
    profit: bigint;
    counterpartyInputToEthPrice: bigint;
    counterpartyOutputToEthPrice: bigint;
} {
    const { counterpartyMaxOutput, counterpartyInputProfit } = calcCounterpartyInputProfit(counterparty, quote)
    const orderMaxInput =
        (orderDetails.takeOrder.quote!.maxOutput * orderDetails.takeOrder.quote!.ratio) / ONE18;
    // cant trade, so 0 profit
    if (orderMaxInput > counterpartyMaxOutput) {
        return {
            profit: 0n,
            counterpartyInputToEthPrice: 0n,
            counterpartyOutputToEthPrice: 0n,
        };
    }
    const counterpartyOutputProfit = counterpartyMaxOutput - orderMaxInput;

    const counterpartyInputToEthPrice = calcCounterpartyInputToEthPrice(quote, outputToEthPrice);
    const counterpartyOutputToEthPrice = calcCounterpartyOutputToEthPrice(
        counterpartyInputToEthPrice,
        counterparty.takeOrder.quote!.ratio,
        inputToEthPrice,
    );

    const inputProfitEth = (counterpartyInputProfit * counterpartyInputToEthPrice) / ONE18;
    const outputProfitEth = (counterpartyOutputProfit * counterpartyOutputToEthPrice) / ONE18;
    return {
        profit: inputProfitEth + outputProfitEth,
        counterpartyInputToEthPrice,
        counterpartyOutputToEthPrice,
    };
}
