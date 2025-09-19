import { findOpp } from "./modes";
import { PublicClient } from "viem";
import { getQuoteGas } from "./order";
import { SharedState } from "./state";
import { Token } from "sushi/currency";
import { handleTransaction } from "./tx";
import { BigNumber, Contract, ethers } from "ethers";
import { RainDataFetcher, RainDataFetcherOptions } from "sushi";
import { errorSnapshot } from "./error";
import { toNumber, getEthPrice, PoolBlackList, getMarketQuote } from "./utils";
import { BotConfig } from "./types";
import { SpanAttrs, ProcessPairResult } from "./types";
import { BundledOrders, quoteSingleOrder } from "./order";
import { RainSolverSigner } from "./signer";
import { ProcessOrderHaltReason, ProcessOrderStatus } from "./solver/types";

/**
 * Processes an pair order by trying to clear it against an onchain liquidity and reporting the result
 */
export async function processPair(args: {
    config: BotConfig;
    orderPairObject: BundledOrders;
    viemClient: PublicClient;
    dataFetcher: RainDataFetcher;
    signer: RainSolverSigner;
    arb: Contract;
    genericArb: Contract | undefined;
    orderbook: Contract;
    pair: string;
    orderbooksOrders: BundledOrders[][];
    state: SharedState;
}): Promise<() => Promise<ProcessPairResult>> {
    const {
        config,
        orderPairObject,
        viemClient,
        dataFetcher,
        signer,
        arb,
        genericArb,
        orderbook,
        pair,
        orderbooksOrders,
        state,
    } = args;
    const isE2eTest = (config as any).isTest;
    const spanAttributes: SpanAttrs = {};
    const result: ProcessPairResult = {
        reason: undefined,
        error: undefined,
        gasCost: undefined,
        spanAttributes,
        report: {
            status: ProcessOrderStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        },
    };
    spanAttributes["details.orders"] = orderPairObject.takeOrders.map((v) => v.id);
    spanAttributes["details.pair"] = pair;

    const fromToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.sellTokenDecimals,
        address: orderPairObject.sellToken,
        symbol: orderPairObject.sellTokenSymbol,
    });
    const toToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.buyTokenDecimals,
        address: orderPairObject.buyToken,
        symbol: orderPairObject.buyTokenSymbol,
    });

    try {
        await quoteSingleOrder(
            orderPairObject,
            viemClient,
            undefined,
            isE2eTest ? config.quoteGas : await getQuoteGas(config, orderPairObject),
        );
        if (orderPairObject.takeOrders[0].quote?.maxOutput === 0n) {
            result.report = {
                status: ProcessOrderStatus.ZeroOutput,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            return async () => {
                return result;
            };
        }
    } catch (e) {
        result.error = e;
        result.reason = ProcessOrderHaltReason.FailedToQuote;
        return async () => {
            throw result;
        };
    }

    spanAttributes["details.quote"] = JSON.stringify({
        maxOutput: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote!.maxOutput),
        ratio: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote!.ratio),
    });

    const gasPrice = BigNumber.from(state.gasPrice);

    // get block number
    let dataFetcherBlockNumber = await viemClient.getBlockNumber().catch(() => {
        return undefined;
    });

    // update pools by events watching until current block
    try {
        if (isE2eTest && (config as any).testBlockNumberInc) {
            (config as any).testBlockNumberInc += 10n;
            dataFetcherBlockNumber = (config as any).testBlockNumberInc;
        }
        await dataFetcher.updatePools(dataFetcherBlockNumber);
    } catch (e) {
        if (typeof e !== "string" || !e.includes("fetchPoolsForToken")) {
            result.reason = ProcessOrderHaltReason.FailedToUpdatePools;
            result.error = e;
            return async () => {
                throw result;
            };
        }
    }

    // get pool details
    try {
        const options: RainDataFetcherOptions = {
            fetchPoolsTimeout: 90000,
            blockNumber: dataFetcherBlockNumber,
        };
        // pin block number for test case
        if (isE2eTest && (config as any).testBlockNumber) {
            options.blockNumber = (config as any).testBlockNumber;
        }
        await dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, options);
    } catch (e) {
        result.reason = ProcessOrderHaltReason.FailedToGetPools;
        result.error = e;
        return async () => {
            throw result;
        };
    }

    try {
        const marketQuote = getMarketQuote(config, fromToken, toToken, gasPrice);
        if (marketQuote) {
            spanAttributes["details.marketQuote.str"] = marketQuote.price;
            spanAttributes["details.marketQuote.num"] = toNumber(
                ethers.utils.parseUnits(marketQuote.price),
            );
        }
    } catch {
        /**/
    }

    // get in/out tokens to eth price
    let inputToEthPrice, outputToEthPrice;
    try {
        const options = {
            fetchPoolsTimeout: 30000,
        };
        // pin block number for test case
        if (isE2eTest && (config as any).testBlockNumber) {
            (options as any).blockNumber = (config as any).testBlockNumber;
        }
        inputToEthPrice = await getEthPrice(
            config,
            orderPairObject.buyToken,
            orderPairObject.buyTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        outputToEthPrice = await getEthPrice(
            config,
            orderPairObject.sellToken,
            orderPairObject.sellTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        if (!inputToEthPrice || !outputToEthPrice) {
            if (config.gasCoveragePercentage === "0") {
                inputToEthPrice = "0";
                outputToEthPrice = "0";
            } else {
                result.reason = ProcessOrderHaltReason.FailedToGetEthPrice;
                result.error = "no-route";
                return async () => {
                    return Promise.reject(result);
                };
            }
        } else {
            spanAttributes["details.inputToEthPrice"] = inputToEthPrice;
            spanAttributes["details.outputToEthPrice"] = outputToEthPrice;
        }
    } catch (e) {
        if (config.gasCoveragePercentage === "0") {
            inputToEthPrice = "0";
            outputToEthPrice = "0";
        } else {
            result.reason = ProcessOrderHaltReason.FailedToGetEthPrice;
            result.error = e;
            return async () => {
                throw result;
            };
        }
    }

    // record gas price for otel
    spanAttributes["details.gasPrice"] = state.gasPrice.toString();
    if (state.l1GasPrice) {
        spanAttributes["details.gasPriceL1"] = state.l1GasPrice.toString();
    }

    // execute process to find opp through different modes
    let rawtx, oppBlockNumber, estimatedProfit;
    try {
        const findOppResult = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb,
            fromToken,
            toToken,
            signer,
            gasPrice: state.gasPrice,
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders,
        });
        ({ rawtx, oppBlockNumber, estimatedProfit } = findOppResult.value!);

        if (!rawtx || !oppBlockNumber) throw "undefined tx/block number";

        // record span attrs
        spanAttributes["details.estimatedProfit"] = ethers.utils.formatUnits(estimatedProfit);
        for (const attrKey in findOppResult.spanAttributes) {
            if (attrKey !== "oppBlockNumber" && attrKey !== "foundOpp") {
                spanAttributes["details." + attrKey] = findOppResult.spanAttributes[attrKey];
            } else {
                spanAttributes[attrKey] = findOppResult.spanAttributes[attrKey];
            }
        }
    } catch (e: any) {
        // record all span attributes
        for (const attrKey in e.spanAttributes) {
            spanAttributes["details." + attrKey] = e.spanAttributes[attrKey];
        }
        if (e.noneNodeError) {
            spanAttributes["details.noneNodeError"] = true;
            result.error = e.noneNodeError;
        } else {
            spanAttributes["details.noneNodeError"] = false;
        }
        result.report = {
            status: ProcessOrderStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        };
        return async () => {
            return result;
        };
    }

    // from here on we know an opp is found, so record it in report and in otel span attributes
    result.report = {
        status: ProcessOrderStatus.FoundOpportunity,
        tokenPair: pair,
        buyToken: orderPairObject.buyToken,
        sellToken: orderPairObject.sellToken,
    };
    spanAttributes["foundOpp"] = true;

    // get block number
    let blockNumber: number;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["details.blockNumber"] = blockNumber;
        spanAttributes["details.blockNumberDiff"] = blockNumber - oppBlockNumber;
    } catch (e) {
        // dont reject if getting block number fails but just record it,
        // since an opp is found and can ultimately be cleared
        spanAttributes["details.blockNumberError"] = errorSnapshot("failed to get block number", e);
    }

    // handle the found transaction opportunity
    return handleTransaction(
        signer,
        viemClient as any as RainSolverSigner,
        spanAttributes,
        rawtx,
        orderbook,
        orderPairObject,
        inputToEthPrice,
        outputToEthPrice,
        result,
        pair,
        toToken,
        fromToken,
        config,
    );
}
