import { sleep } from "../common";
import { SharedState } from "../state";
import { publicActionsL2 } from "viem/op-stack";
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
    export function fromSharedState(state: SharedState): () => RainSolverSignerActions {
        return () => ({
            state,
            busy: false,
            sendTx(tx) {
                return sendTx.call(this as RainSolverSigner, tx);
            },
            waitUntilFree() {
                return waitUntilFree.call(this as RainSolverSigner);
            },
            getSelfBalance() {
                return getSelfBalance.call(this as RainSolverSigner);
            },
            estimateGasCost(tx) {
                return estimateGasCost.call(this as RainSolverSigner, tx);
            },
            asWriteSigner() {
                return getWriteSignerFrom.call(this as RainSolverSigner);
            },
        });
    }
}

/**
 * A wrapper for viem sendTransactions that handles nonce and manages signer busy
 * state while the transaction is being sent ensuring proper busy state management
 *
 * @param this - The RainSolverSigner instance to use for sending the transaction
 * @param tx - The transaction parameters to send
 * @returns A Promise that resolves to the transaction hash
 * @throws Will throw if the transaction fails to send
 */
export async function sendTx(
    this: RainSolverSigner,
    tx: SendTransactionParameters<Chain, HDAccount | PrivateKeyAccount>,
): Promise<`0x${string}`> {
    // make sure signer is free
    await this.waitUntilFree();

    // start sending tranaction process
    this.busy = true;
    try {
        const nonce = await this.getTransactionCount({
            address: this.account.address,
            blockTag: "latest",
        });
        if (typeof tx.gas === "bigint") {
            tx.gas = getTxGas(this.state, tx.gas);
        }
        const result = await this.sendTransaction({ ...(tx as any), nonce });
        this.busy = false;
        return result;
    } catch (error) {
        this.busy = false;
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
 * @param this - The RainSolverSigner instance to use for estimation
 * @param tx - Transaction parameters to estimate gas for
 */
export async function estimateGasCost(
    this: RainSolverSigner,
    tx: EstimateGasParameters<Chain>,
): Promise<EstimateGasCostResult> {
    const gasPrice = (this.state.gasPrice * BigInt(this.state.gasPriceMultiplier)) / 100n;
    const gas = await this.estimateGas(tx);
    const result = {
        gas,
        gasPrice,
        l1GasPrice: 0n,
        l1Cost: 0n,
        totalGasCost: gasPrice * gas,
    };
    if (this.state.chainConfig.isSpecialL2) {
        try {
            let l1GasPrice;
            const l1Signer_ = this.extend(publicActionsL2());
            if (typeof this.state.l1GasPrice !== "bigint") {
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
 * @param state - The sharedstate instance
 * @param gas - The original gas limit to apply the multiplier to
 * @returns The adjusted gas limit after applying any configured multiplier
 */
export function getTxGas(state: SharedState, gas: bigint): bigint {
    if (state.transactionGas) {
        if (state.transactionGas.endsWith("%")) {
            const multiplier = BigInt(
                state.transactionGas.substring(0, state.transactionGas.length - 1),
            );
            return (gas * multiplier) / 100n;
        } else {
            return BigInt(state.transactionGas);
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
 * @param this - The RainSolverSigner instance to wait for
 * @returns A Promise that resolves when the signer is free to use
 */
export async function waitUntilFree(this: RainSolverSigner) {
    while (this.busy) {
        await sleep(30);
    }
}

/**
 * A wrapper for viem client `getBalance()` that gets native token balance of the signer's account.
 * @param this - The RainSolverSigner instance to check the balance for
 */
export async function getSelfBalance(this: RainSolverSigner) {
    return await this.getBalance({ address: this.account.address });
}

/**
 * Get the associated write signer from the given signer and state, that is
 * basically the same signer wallet but configured with app's write rpc
 * @param this - A RainSolverSigner instance
 * */
export function getWriteSignerFrom(this: RainSolverSigner): RainSolverSigner {
    // if state doesnt have write rpc configured, return the signer as is
    if (!this.state.writeRpc) return this;
    return RainSolverSigner.create(this.account, this.state, true);
}
