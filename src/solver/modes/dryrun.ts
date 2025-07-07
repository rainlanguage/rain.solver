import { Result } from "../../result";
import { Attributes } from "@opentelemetry/api";
import { withBigintSerializer } from "../../utils";
import { BaseError, ExecutionRevertedError } from "viem";
import { RainSolverSigner, RawTransaction } from "../../signer";
import { containsNodeError, errorSnapshot } from "../../error";
import { DryrunFailure, DryrunResult, DryrunSuccess } from "../types";

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
        const isNodeError = containsNodeError(e as BaseError);
        const errMsg = errorSnapshot("", e);
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
