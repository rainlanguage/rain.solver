import { ONE18 } from "../../math";
import { Result } from "../../common";
import { RainSolverSigner } from "../../signer";
import { Attributes } from "@opentelemetry/api";
import { containsNodeError, errorSnapshot } from "../../error";
import { withBigintSerializer, RawTransaction } from "../../common";
import { DryrunFailure, DryrunResult, DryrunSuccess } from "../types";
import { BaseError, ExecutionRevertedError, formatUnits, parseUnits, maxUint256 } from "viem";

/**
 * Simulates a contract call by performing an `eth_estimateGas` RPC call to determine
 * if the given transaction would revert or succeed, and estimates the gas cost.
 *
 * This function does not broadcast the transaction, but instead checks if the transaction
 * would succeed or revert by estimating the gas usage. It also calculates the total gas cost
 * based on the provided gas price and an optional gas limit multiplier.
 *
 * @param signer - The signer instance
 * @param rawtx - The raw transaction object to simulate
 * @param gasPrice - The gas price to use for cost estimation
 * @param gasLimitMultiplier - A multiplier (as a percentage, e.g., 120 for 120%) to adjust the estimated gas limit
 */
export async function dryrun(
    signer: RainSolverSigner,
    rawtx: RawTransaction,
    gasPrice: bigint,
    gasLimitMultiplier: number,
): Promise<DryrunResult> {
    const spanAttributes: Attributes = {};
    try {
        const estimation = await signer.estimateGasCost(rawtx as any);
        const gasLimit = (estimation.gas * BigInt(gasLimitMultiplier)) / 100n;
        if (gasLimit === 0n) {
            throw new ExecutionRevertedError({
                cause: new BaseError("RPC returned 0 for eth_estimateGas", {
                    cause: new Error(
                        "Failed to estimated gas, RPC returned 0 for eth_estimateGas call without rejection",
                    ),
                }),
                message:
                    "Failed to estimated gas, RPC returned 0 for eth_estimateGas call without rejection",
            });
        }
        rawtx.gas = gasLimit;
        const gasCost = gasLimit * gasPrice + estimation.l1Cost;

        const result: DryrunSuccess = {
            spanAttributes,
            estimatedGasCost: gasCost,
            estimation,
        };
        return Result.ok(result);
    } catch (e) {
        const isNodeError = await containsNodeError(e as BaseError);
        const errMsg = await errorSnapshot("", e);
        spanAttributes["isNodeError"] = isNodeError;
        spanAttributes["error"] = errMsg;
        spanAttributes["rawtx"] = JSON.stringify(
            {
                ...rawtx,
                from: signer.account.address,
            },
            withBigintSerializer,
        );
        const result: DryrunFailure = {
            spanAttributes,
        };
        if (!isNodeError) {
            result.noneNodeError = errMsg;
        }
        return Result.err(result);
    }
}

/**
 * Calculates the fallback price of a token pair input token to ETH from the order and counterparty order
 * ratios and known output token to ETH price when there is no route in sushi router to get the output token
 * to ETH price directly.
 * Thi is done by assuming the min of the two order and counterparty order ratios as a price path to calculate
 * the pair's input token to ETH price, for calculating a pair output token to ETH price, just pass the ratios
 * in place of eachother.
 *
 * @example
 * pair A/B, where A is the input token and B is the output token
 * we already know the price of B to ETH (oEthPrice), and we want to calculate the price of A to ETH
 * we have the following ratios from order and counterparty order:
 * - oiRatio: ratio of the order, which is OI, output token to input token, ie A/B
 * - ioRatio: ratio of the counterparty order, which is IO, input token to output token, ie B/A
 * by inversing the oiRatio, and getting min of that and ioRatio, we now have a path from
 * A to B to ETH, which we can use to calculate the price of A to ETH:
 * - if B to ETH price is 0.5
 * - oiRatio is 2 (2 A for 1 B) and inveresed is 0.5 (0.5 B for 1 A)
 * - ioRatio is 1 (1 B for 1 A)
 * - A to ETH is: min(0.5, 1) * 0.5 = 0.25 ie for 1 A, we get 0.25 ETH
 *
 * @param oiRatio - The ratio of the order, ie output token to input token - OI ratio
 * @param ioRatio - The ratio of the counterparty order, ie input token to output token - IO ratio
 * @param oEthPrice - The output token price to ETH
 */
export function fallbackEthPrice(oiRatio: bigint, ioRatio: bigint, oEthPrice: string): string {
    const oiRatioInverese = oiRatio === 0n ? maxUint256 : ONE18 ** 2n / oiRatio;
    const minRatio = oiRatioInverese < ioRatio ? oiRatioInverese : ioRatio;
    return formatUnits((minRatio * parseUnits(oEthPrice, 18)) / ONE18, 18);
}
