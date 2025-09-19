import { ABI, normalizeFloat } from "../../common";
import { ONE18, scaleTo18 } from "../../math";
import { erc20Abi, formatUnits, parseEventLogs, parseUnits, TransactionReceipt } from "viem";

/**
 * Extracts the income (received token value) from transaction receipt
 * @param signerAddress - The signer address
 * @param receipt - The transaction receipt
 * @param token - The token address that was transfered
 * @returns The income value or undefined if cannot find any valid value
 */
export function getIncome(
    signerAddress: string,
    receipt: TransactionReceipt,
    token: string,
): bigint | undefined {
    try {
        const logs = parseEventLogs({
            abi: erc20Abi,
            eventName: "Transfer",
            logs: receipt.logs,
        });
        for (const log of logs) {
            if (
                log.eventName === "Transfer" &&
                (log.address && token ? log.address.toLowerCase() === token.toLowerCase() : true) &&
                log.args.to.toLowerCase() === signerAddress.toLowerCase()
            ) {
                return log.args.value;
            }
        }
    } catch {}
    return undefined;
}

/**
 * Extracts the actual clear amount (received token value) from transaction receipt
 * @param toAddress - The to address
 * @param obAddress - The orderbook address
 * @param receipt - The transaction receipt
 * @returns The actual clear amount
 */
export function getActualClearAmount(
    toAddress: string,
    obAddress: string,
    receipt: TransactionReceipt,
    outputTokenDecimals: number,
): bigint | undefined {
    if (toAddress.toLowerCase() !== obAddress.toLowerCase()) {
        try {
            const logs = parseEventLogs({
                abi: erc20Abi,
                eventName: "Transfer",
                logs: receipt.logs,
            });
            for (const log of logs) {
                if (
                    log.eventName === "Transfer" &&
                    log.args.to.toLowerCase() === toAddress.toLowerCase() &&
                    log.args.from.toLowerCase() === obAddress.toLowerCase()
                ) {
                    return log.args.value;
                }
            }
        } catch {}
        return undefined;
    } else {
        try {
            const logs = parseEventLogs({
                abi: [ABI.Orderbook.Primary.Orderbook[4]],
                eventName: "AfterClearV2",
                logs: receipt.logs,
            });
            for (const log of logs) {
                if (log.eventName === "AfterClearV2") {
                    const outputResult = normalizeFloat(
                        log.args.clearStateChange.aliceOutput,
                        outputTokenDecimals,
                    );
                    if (outputResult.isErr()) {
                        return undefined;
                    }
                    return outputResult.value;
                }
            }
        } catch {}
        return undefined;
    }
}

/**
 * Calculates the actual clear price from transactioin event
 * @param receipt - The transaction receipt
 * @param orderbook - The Orderbook contract address
 * @param arb - The Arb contract address
 * @param clearAmount - The clear amount
 * @param tokenDecimals - The buy token decimals
 * @returns The actual clear price or undefined if necessary info not found in transaction events
 */
export function getActualPrice(
    receipt: TransactionReceipt,
    orderbook: string,
    arb: string,
    clearAmount: string,
    tokenDecimals: number,
): string | undefined {
    try {
        const logs = parseEventLogs({
            abi: erc20Abi,
            eventName: "Transfer",
            logs: receipt.logs,
        });
        for (const log of logs) {
            if (
                log.eventName === "Transfer" &&
                log.args.to.toLowerCase() === arb.toLowerCase() &&
                log.args.from.toLowerCase() !== orderbook.toLowerCase()
            ) {
                return formatUnits(
                    (scaleTo18(log.args.value, tokenDecimals) * ONE18) / BigInt(clearAmount),
                    18,
                );
            }
        }
    } catch {}
    return undefined;
}

/**
 * Get total income in native chain's token units
 */
export function getTotalIncome(
    inputTokenIncome: bigint | undefined,
    outputTokenIncome: bigint | undefined,
    inputTokenPrice: string,
    outputTokenPrice: string,
    inputTokenDecimals: number,
    outputTokenDecimals: number,
): bigint | undefined {
    if (!inputTokenIncome && !outputTokenIncome) return undefined;
    const inputTokenIncomeInEth = (() => {
        if (inputTokenIncome) {
            return (
                (parseUnits(inputTokenPrice, 18) *
                    scaleTo18(inputTokenIncome, inputTokenDecimals)) /
                ONE18
            );
        } else {
            return 0n;
        }
    })();
    const outputTokenIncomeInEth = (() => {
        if (outputTokenIncome) {
            return (
                (parseUnits(outputTokenPrice, 18) *
                    scaleTo18(outputTokenIncome, outputTokenDecimals)) /
                ONE18
            );
        } else {
            return 0n;
        }
    })();
    return inputTokenIncomeInEth + outputTokenIncomeInEth;
}
