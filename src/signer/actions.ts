import { sleep } from "../common";
import { BigNumber } from "ethers";
import { publicActionsL2 } from "viem/op-stack";
import { SharedState, TokenDetails } from "../state";
import { RainSolverSigner, EstimateGasCostResult } from ".";
import {
    Chain,
    HDAccount,
    PrivateKeyAccount,
    EstimateGasParameters,
    SendTransactionParameters,
} from "viem";

/**
 * Custom actions that extend the viem client functionality, these actions add transaction
 * management, gas estimation, and state handling capabilities specifically for the RainSolver
 * system.
 *
 * @example
 * ```ts
 * const signer = createClient({
 *   chain: baseSepolia,
 *   transport: http(),
 * }).extend(RainSolverSignerActions).signer;
 *
 * const tx = await signer.sendTx({
 *   to: "0x1234567890123456789012345678901234567890",
 *   value: parseEther("0.001"),
 * });
 *
 * // get the associated write signer
 * const writeSigner = signer.toWriteSigner();
 */
export type RainSolverSignerActions<
    account extends HDAccount | PrivateKeyAccount = HDAccount | PrivateKeyAccount,
> = {
    /** @deprecated */
    BALANCE: BigNumber;
    /** @deprecated */
    BOUNTY: TokenDetails[];

    /** A SharedState instance containing shared configuration and state */
    state: SharedState;

    /** Flag indicating if the signer is currently processing a transaction */
    busy: boolean;

    /** Waits until the signer is free and ready to process new transactions (not busy) */
    waitUntilFree: () => Promise<void>;

    /** Gets the current balance of the signer's account */
    getSelfBalance: () => Promise<bigint>;

    /**
     * Sends a transaction to the network and returns its hash
     * @param tx - The transaction parameters
     */
    sendTx: (tx: SendTransactionParameters<Chain, account>) => Promise<`0x${string}`>;

    /**
     * Estimates the total gas cost for a transaction
     * For L2 chains, includes both L1 and L2 gas costs
     * @param tx - The transaction parameters to estimate
     */
    estimateGasCost: (tx: EstimateGasParameters<Chain>) => Promise<EstimateGasCostResult>;

    /**
     * Returns the associated write signer of this signer which basically is the same wallet
     * signer but configured to use the state's write rpc(s) to interact with evm network, this
     * is manily used for sending transactions or in other words performing write transactions
     * with specified write rpc(s) that usually are the ones that provide protection against
     * MEV attacks and dont suite read calls as they are paid or have high ratelimit
     * */
    asWriteSigner: () => RainSolverSigner<account>;
};

export namespace RainSolverSignerActions {
    export function fromSharedState(
        state: SharedState,
    ): (client: RainSolverSigner) => RainSolverSignerActions {
        return (client) => ({
            state,
            busy: false,
            BALANCE: BigNumber.from(0),
            BOUNTY: Array.from(state.watchedTokens.values()),
            sendTx: (tx) => sendTx(client, tx),
            waitUntilFree: () => waitUntilFree(client),
            getSelfBalance: () => getSelfBalance(client),
            estimateGasCost: (tx) => estimateGasCost(client, tx),
            asWriteSigner: () => getWriteSignerFrom(client, state),
        });
    }
}

/**
 * A wrapper for viem sendTransactions that handles nonce and manages signer busy
 * state while the transaction is being sent ensuring proper busy state management
 *
 * @param signer - The RainSolverSigner instance to use for sending the transaction
 * @param tx - The transaction parameters to send
 * @returns A Promise that resolves to the transaction hash
 * @throws Will throw if the transaction fails to send
 */
export async function sendTx(
    signer: RainSolverSigner,
    tx: SendTransactionParameters<Chain, HDAccount | PrivateKeyAccount>,
): Promise<`0x${string}`> {
    // make sure signer is free
    await signer.waitUntilFree();

    // start sending tranaction process
    signer.busy = true;
    try {
        const nonce = await signer.getTransactionCount({
            address: signer.account.address,
            blockTag: "latest",
        });
        if (typeof tx.gas === "bigint") {
            tx.gas = getTxGas(signer, tx.gas);
        }
        const result = await signer.sendTransaction({ ...(tx as any), nonce });
        signer.busy = false;
        return result;
    } catch (error) {
        signer.busy = false;
        throw error;
    }
}

/**
 * Estimates the total gas cost for a transaction, including L2 gas costs and L1 fees if on a special L2 chain.
 * This function calculates:
 * - Base gas cost using the signer's configured gas price and multiplier
 * - L2 gas estimation for the transaction
 * - L1 gas fees if on an L2 chain like Arbitrum (gets L1 base fee and estimates L1 calldata cost)
 *
 * @param signer - The RainSolverSigner instance to use for estimation
 * @param tx - Transaction parameters to estimate gas for
 */
export async function estimateGasCost(
    signer: RainSolverSigner,
    tx: EstimateGasParameters<Chain>,
): Promise<EstimateGasCostResult> {
    const gasPrice = (signer.state.gasPrice * BigInt(signer.state.gasPriceMultiplier)) / 100n;
    const gas = await signer.estimateGas(tx);
    const result = {
        gas,
        gasPrice,
        l1GasPrice: 0n,
        l1Cost: 0n,
        totalGasCost: gasPrice * gas,
    };
    if (signer.state.chainConfig.isSpecialL2) {
        try {
            let l1GasPrice;
            const l1Signer_ = signer.extend(publicActionsL2());
            if (typeof signer.state.l1GasPrice !== "bigint") {
                l1GasPrice = await l1Signer_.getL1BaseFee();
            }
            const l1Cost = await l1Signer_.estimateL1Fee({
                to: tx.to!,
                data: tx.data!,
            } as any);
            result.l1GasPrice = l1GasPrice ?? 0n;
            result.l1Cost = l1Cost;
            result.totalGasCost += l1Cost;
        } catch {}
    }
    return result;
}

/**
 * Applies the configured gas multiplier to a transaction's gas limit
 * @param signer - The RainSolverSigner instance containing the gas configuration
 * @param gas - The original gas limit to apply the multiplier to
 * @returns The adjusted gas limit after applying any configured multiplier
 */
export function getTxGas(signer: RainSolverSigner, gas: bigint): bigint {
    if (signer.state.transactionGas) {
        if (signer.state.transactionGas.endsWith("%")) {
            const multiplier = BigInt(
                signer.state.transactionGas.substring(0, signer.state.transactionGas.length - 1),
            );
            return (gas * multiplier) / 100n;
        } else {
            return BigInt(signer.state.transactionGas);
        }
    } else {
        return gas;
    }
}

/**
 * Waits for a signer to become free (not busy) by polling its state.
 * This function polls the signer until it is no longer in a busy state, which typically
 * means it is not in the middle of sending a transaction or performing other operations.
 *
 * @param signer - The RainSolverSigner instance to wait for
 * @returns A Promise that resolves when the signer is free to use
 */
export async function waitUntilFree(signer: RainSolverSigner) {
    while (signer.busy) {
        await sleep(30);
    }
}

/**
 * A wrapper for viem client `getBalance()` that gets native token balance of the signer's account.
 * @param signer - The RainSolverSigner instance to check the balance for
 */
export async function getSelfBalance(signer: RainSolverSigner) {
    return await signer.getBalance({ address: signer.account.address });
}

/**
 * Get the associated write signer from the given signer and state, that is
 * basically the same signer wallet but configured with app's write rpc
 * @param signber - A RainSolverSigner instance
 * @param state - Sharedstate instance
 * */
export function getWriteSignerFrom(signer: RainSolverSigner, state: SharedState): RainSolverSigner {
    // if state doesnt have write rpc configured, return the signer as is
    if (!state.writeRpc) return signer;
    return RainSolverSigner.create(signer.account, state, true);
}
