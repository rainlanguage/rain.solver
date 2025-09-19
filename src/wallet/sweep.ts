import { TokenDetails } from "../state";
import { RainSolverSigner } from "../signer";
import { encodeFunctionData, erc20Abi } from "viem";

/**
 * Transfers the given token from the given wallet to the main wallet
 * @param from - The wallet to transfer the token from
 * @param to - The wallet to transfer the token to
 * @param token - The token to transfer
 * @returns An object containing transaction hash and transferred amount
 */
export async function transferTokenFrom(
    from: RainSolverSigner,
    to: RainSolverSigner,
    token: TokenDetails,
) {
    // exit early if the wallet has no balance of the given token
    const balance = await from.readContract({
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from.account.address],
    });
    if (balance <= 0n) return { amount: 0n };

    // check if there is enough gas for transfer and fund the wallet if not
    const gasBalance = await from.getSelfBalance();
    const cost = await from.estimateGasCost({
        to: token.address as `0x${string}`,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [to.account.address, balance],
        }),
    });
    // fund slightly more to ensure there is enough gas
    const totalCost = (cost.totalGasCost * 110n) / 100n;
    if (totalCost > gasBalance) {
        // fund the wallet
        const hash = await to.sendTx({ to: from.account.address, value: totalCost });
        const receipt = await to.waitForTransactionReceipt({
            hash,
            confirmations: 4,
            timeout: 100_000,
        });
        if (receipt.status !== "success") {
            throw {
                txHash: hash,
                error: new Error(
                    "Failed to fund the wallet to transfer tokens, reason: transaction reverted onchain",
                ),
            };
        }
    }

    // perform the transfer transaction
    const hash = await from.writeContract({
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to.account.address, balance],
    });
    const receipt = await from.waitForTransactionReceipt({
        hash,
        confirmations: 4,
        timeout: 100_000,
    });
    if (receipt.status === "success") {
        return { amount: balance, txHash: hash };
    } else {
        throw {
            txHash: hash,
            error: new Error("Failed to transfer tokens, reason: transaction reverted onchain"),
        };
    }
}

/**
 * Transfers the remaining gas from the given wallet to the main wallet
 * @param from - The wallet to transfer the remaining gas from
 * @param to - The wallet to transfer the remaining gas to
 * @returns An object containing transaction hash and transferred amount
 */
export async function transferRemainingGasFrom(from: RainSolverSigner, to: `0x${string}`) {
    const balance = await from.getSelfBalance();
    if (balance <= 0n) return { amount: 0n };

    const cost = await from.estimateGasCost({ to, value: 0n });
    const totalCost = (cost.totalGasCost * 102n) / 100n;
    if (balance > totalCost) {
        const amount = balance - totalCost;
        const hash = await from.sendTx({ to, value: amount });
        const receipt = await from.waitForTransactionReceipt({
            hash,
            confirmations: 4,
            timeout: 100_000,
        });
        if (receipt.status === "success") {
            return { amount, txHash: hash };
        } else {
            throw {
                txHash: hash,
                error: new Error(
                    "Failed to transfer remaining gas, reason: transaction reverted onchain",
                ),
            };
        }
    } else {
        return { amount: 0n };
    }
}
