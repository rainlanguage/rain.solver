import { Token } from "sushi/currency";
import { Contract, ethers } from "ethers";
import { getL1Fee, getTxFee } from "./gas";
import { containsNodeError, handleRevert } from "./error";
import { BaseError, TransactionReceipt } from "viem";
import { BotConfig, ProcessPairResult } from "./types";
import {
    sleep,
    toNumber,
    getIncome,
    getTotalIncome,
    addWatchedToken,
    withBigintSerializer,
    getActualClearAmount,
} from "./utils";
import { BundledOrders } from "./order";
import { RainSolverSigner, RawTransaction } from "./signer";
import { ProcessOrderHaltReason, ProcessOrderStatus } from "./solver/types";

/**
 * Handles the given transaction, starts by sending the transaction and
 * then tries to get the receipt and process that in async manner, returns
 * a function that resolves with the ProcessOrderResult type when called
 */
export async function handleTransaction(
    signer: RainSolverSigner,
    viemClient: RainSolverSigner,
    spanAttributes: any,
    rawtx: RawTransaction,
    orderbook: Contract,
    orderPairObject: BundledOrders,
    inputToEthPrice: string,
    outputToEthPrice: string,
    result: ProcessPairResult,
    pair: string,
    toToken: Token,
    fromToken: Token,
    config: BotConfig,
): Promise<() => Promise<ProcessPairResult>> {
    // submit the tx
    let txhash: `0x${string}`, txUrl: string;
    let time = 0;
    const sendTx = async () => {
        txhash = await signer.asWriteSigner().sendTx({
            ...rawtx,
            type: "legacy",
        });
        txUrl = config.chain.blockExplorers?.default.url + "/tx/" + txhash;
        time = Date.now();
        // eslint-disable-next-line no-console
        console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
        spanAttributes["details.txUrl"] = txUrl;
    };
    try {
        await sendTx();
    } catch (e) {
        try {
            // retry again after 5 seconds if first attempt failed
            await sleep(5000);
            await sendTx();
        } catch {
            // record rawtx in logs
            spanAttributes["details.rawTx"] = JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            spanAttributes["txNoneNodeError"] = !containsNodeError(e as BaseError);
            result.error = e;
            result.reason = ProcessOrderHaltReason.TxFailed;
            return async () => {
                throw result;
            };
        }
    }

    // start getting tx receipt in background and return the settler fn
    const receiptPromise = (async () => {
        try {
            return await viemClient.waitForTransactionReceipt({
                hash: txhash!,
                confirmations: 1,
                timeout: 120_000,
            });
        } catch {
            // in case waiting for tx receipt was unsuccessful, try getting the receipt directly
            try {
                return await viemClient.getTransactionReceipt({ hash: txhash! });
            } catch {
                await sleep(Math.max(90_000 + time - Date.now(), 0));
                return await viemClient.getTransactionReceipt({ hash: txhash! });
            }
        }
    })();
    return async () => {
        try {
            const receipt = await receiptPromise;
            return handleReceipt(
                txhash,
                receipt,
                signer,
                spanAttributes,
                rawtx,
                orderbook,
                orderPairObject,
                inputToEthPrice,
                outputToEthPrice,
                result,
                txUrl,
                pair,
                toToken,
                fromToken,
                config,
                time,
            );
        } catch (e: any) {
            result.report = {
                status: ProcessOrderStatus.FoundOpportunity,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            result.error = e;
            spanAttributes["details.rawTx"] = JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            spanAttributes["txNoneNodeError"] = !containsNodeError(e);
            result.reason = ProcessOrderHaltReason.TxMineFailed;
            throw result;
        }
    };
}

/**
 * Handles the tx receipt
 */
export async function handleReceipt(
    txhash: string,
    receipt: TransactionReceipt,
    signer: RainSolverSigner,
    spanAttributes: any,
    rawtx: RawTransaction,
    orderbook: Contract,
    orderPairObject: BundledOrders,
    inputToEthPrice: string,
    outputToEthPrice: string,
    result: ProcessPairResult,
    txUrl: string,
    pair: string,
    toToken: Token,
    fromToken: Token,
    config: BotConfig,
    time: number,
): Promise<ProcessPairResult> {
    const l1Fee = getL1Fee(receipt, config);
    const actualGasCost = ethers.BigNumber.from(getTxFee(receipt, config));
    const signerBalance = signer.BALANCE;
    signer.BALANCE = signer.BALANCE.sub(actualGasCost);

    if (receipt.status === "success") {
        spanAttributes["didClear"] = true;

        const clearActualAmount = getActualClearAmount(rawtx.to, orderbook.address, receipt);
        const inputTokenIncome = getIncome(
            signer.account.address,
            receipt,
            orderPairObject.buyToken,
        );
        const outputTokenIncome = getIncome(
            signer.account.address,
            receipt,
            orderPairObject.sellToken,
        );
        const income = getTotalIncome(
            inputTokenIncome,
            outputTokenIncome,
            inputToEthPrice,
            outputToEthPrice,
            orderPairObject.buyTokenDecimals,
            orderPairObject.sellTokenDecimals,
        );
        const netProfit = income ? income.sub(actualGasCost) : undefined;

        spanAttributes["details.actualGasCost"] = toNumber(actualGasCost);
        if (config.isSpecialL2 && l1Fee) {
            spanAttributes["details.gasCostL1"] = toNumber(l1Fee);
        }
        if (income) {
            spanAttributes["details.income"] = toNumber(income);
            spanAttributes["details.netProfit"] = toNumber(netProfit!);
        }
        if (inputTokenIncome) {
            spanAttributes["details.inputTokenIncome"] = ethers.utils.formatUnits(
                inputTokenIncome,
                orderPairObject.buyTokenDecimals,
            );
        }
        if (outputTokenIncome) {
            spanAttributes["details.outputTokenIncome"] = ethers.utils.formatUnits(
                outputTokenIncome,
                orderPairObject.sellTokenDecimals,
            );
        }

        result.report = {
            status: ProcessOrderStatus.FoundOpportunity,
            txUrl,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
            clearedAmount: clearActualAmount?.toString(),
            actualGasCost: ethers.utils.formatUnits(actualGasCost),
            income,
            inputTokenIncome: inputTokenIncome
                ? ethers.utils.formatUnits(inputTokenIncome, toToken.decimals)
                : undefined,
            outputTokenIncome: outputTokenIncome
                ? ethers.utils.formatUnits(outputTokenIncome, fromToken.decimals)
                : undefined,
            netProfit,
            clearedOrders: orderPairObject.takeOrders.map((v) => v.id),
        };

        // keep track of gas consumption of the account and bounty token
        result.gasCost = actualGasCost;
        if (inputTokenIncome && inputTokenIncome.gt(0)) {
            const tkn = {
                address: orderPairObject.buyToken.toLowerCase(),
                decimals: orderPairObject.buyTokenDecimals,
                symbol: orderPairObject.buyTokenSymbol,
            };
            addWatchedToken(tkn, [], signer);
        }
        if (outputTokenIncome && outputTokenIncome.gt(0)) {
            const tkn = {
                address: orderPairObject.sellToken.toLowerCase(),
                decimals: orderPairObject.sellTokenDecimals,
                symbol: orderPairObject.sellTokenSymbol,
            };
            addWatchedToken(tkn, [], signer);
        }
        return result;
    } else {
        const simulation = await (async () => {
            const result = await handleRevert(
                signer,
                txhash as `0x${string}`,
                receipt,
                rawtx,
                signerBalance,
                orderbook.address as `0x${string}`,
            );
            if (result.snapshot.includes("simulation failed to find the revert reason")) {
                // wait at least 90s before simulating the revert tx
                // in order for rpcs to catch up, this is concurrent to
                // whole bot operation, so ideally all of it or at least
                // partially will overlap with when bot is processing other
                // orders
                await sleep(Math.max(90_000 + time - Date.now(), 0));
                return await handleRevert(
                    signer,
                    txhash as `0x${string}`,
                    receipt,
                    rawtx,
                    signerBalance,
                    orderbook.address as `0x${string}`,
                );
            } else {
                return result;
            }
        })();
        if (simulation) {
            result.error = simulation;
            spanAttributes["txNoneNodeError"] = !simulation.nodeError;
        }
        result.report = {
            status: ProcessOrderStatus.FoundOpportunity,
            txUrl,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
            actualGasCost: ethers.utils.formatUnits(actualGasCost),
        };
        result.reason = ProcessOrderHaltReason.TxReverted;
        return Promise.reject(result);
    }
}
