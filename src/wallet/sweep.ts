import { RPoolFilter } from "../router";
import { TokenDetails } from "../state";
import { ChainId, Router } from "sushi";
import { RainSolverSigner } from "../signer";
import { Native, Token } from "sushi/currency";
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";

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

/**
 * Converts the wallet's balance of the given token to gas, if the received
 * amount is greater than the swap transaction cost * swapCostMultiplier
 * @param from - The wallet to convert the token from
 * @param token - The token to convert
 * @param swapCostMultiplier - The multiplier for the swap cost
 * @returns An object containing transaction hash, amount, route, received amount,
 * received amount min, status, and expected gas cost
 */
export async function convertToGas(
    from: RainSolverSigner,
    token: TokenDetails,
    swapCostMultiplier = 25n, // defaults to 25 times greater than swap transaction gas cost
) {
    const rp4Address = from.state.chainConfig.routeProcessors["4"] as `0x${string}`;
    const buyToken = Native.onChain(from.state.chainConfig.id);
    const sellToken = new Token({
        chainId: from.state.chainConfig.id,
        decimals: token.decimals,
        address: token.address,
        symbol: token.symbol,
    });

    // exit early if the wallet has no balance of the given token
    const balance = await from.readContract({
        address: sellToken.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from.account.address],
    });
    if (balance <= 0n) {
        return {
            amount: 0n,
            status: "Zero balance",
        };
    }

    // check allowance and increase it if neeeded
    const allowance = await from.readContract({
        address: sellToken.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [from.account.address, rp4Address],
    });
    if (balance > allowance) {
        const hash = await from.writeContract({
            address: sellToken.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [rp4Address, maxUint256],
        });
        await from.waitForTransactionReceipt({
            hash,
            confirmations: 4,
            timeout: 100_000,
        });
    }

    // find best route and build swap contract call params
    const { pcMap, route } = await from.state.dataFetcher.findBestRoute(
        from.state.chainConfig.id as ChainId,
        sellToken,
        buyToken,
        balance,
        from.state.gasPrice,
        true,
        undefined,
        from.state.liquidityProviders,
        RPoolFilter,
    );
    const rpParams = Router.routeProcessor4Params(
        pcMap,
        route,
        sellToken,
        buyToken,
        from.account.address,
        rp4Address,
    );
    // visualize the route, in other words parse it as a string
    const visualizedRoute = route.legs
        .map((v) => {
            return (
                (v.tokenTo?.symbol ?? "") +
                "/" +
                (v.tokenFrom?.symbol ?? "") +
                "(" +
                ((v as any)?.poolName ?? "") +
                " " +
                (v.poolAddress ?? "") +
                ")"
            );
        })
        .join(" --> ");

    // make sure cost of the transaction does not outweigh the received gas amount
    const cost = await from.estimateGasCost({
        to: rp4Address,
        data: rpParams.data as `0x${string}`,
    });
    if (rpParams.amountOutMin >= cost.totalGasCost * swapCostMultiplier) {
        const hash = await from.sendTx({
            to: rp4Address,
            data: rpParams.data as `0x${string}`,
        });
        const receipt = await from.waitForTransactionReceipt({
            hash,
            confirmations: 4,
            timeout: 100_000,
        });
        if (receipt.status === "success") {
            return {
                txHash: hash,
                amount: balance,
                route: visualizedRoute,
                receivedAmount: route.amountOutBI,
                receivedAmountMin: rpParams.amountOutMin,
                status: "Successfully swapped",
                expectedGasCost: cost.totalGasCost,
            };
        } else {
            throw {
                txHash: hash,
                error: new Error(
                    "Failed to swap token to gas, reason: transaction reverted onchain",
                ),
            };
        }
    } else {
        return {
            amount: balance,
            route: visualizedRoute,
            expectedGasCost: cost.totalGasCost,
            receivedAmount: route.amountOutBI,
            receivedAmountMin: rpParams.amountOutMin,
            status: "Skipped because balance not large enough to justify swapping to gas",
        };
    }
}
