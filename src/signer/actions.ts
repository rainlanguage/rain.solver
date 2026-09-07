import { RpcState } from "../rpc";
import { SharedState } from "../state";
import { publicActionsL2 } from "viem/op-stack";
import { RainSolverSigner, EstimateGasCostResult } from ".";
import { Result, promiseTimeout, raceFirstOk, sleep } from "../common";
import {
    Chain,
    HDAccount,
    keccak256,
    PrivateKeyAccount,
    EstimateGasParameters,
    SendTransactionParameters,
    TransactionReceipt,
    WaitForTransactionReceiptTimeoutError,
} from "viem";
import { toUsdValue } from "../math";

/**
 * Error messages of a node that already holds the transaction, ie a broadcast
 * copy of the same signed transaction landed on it through another rpc first,
 * or the transaction already got mined by the time the copy arrived
 */
const ALREADY_KNOWN_ERRORS = [
    "already known",
    "already exists",
    "already_exists",
    "alreadyknown",
    "known transaction",
    "already imported",
    "nonce too low",
];

/** Determines if the given send error means the node already holds the transaction */
export function isAlreadyKnownTxError(error: any): boolean {
    const msg = String(
        error?.details ?? error?.shortMessage ?? error?.message ?? error,
    ).toLowerCase();
    return ALREADY_KNOWN_ERRORS.some((v) => msg.includes(v));
}

/** Represents a sent transaction with hash and wait for receipt method */
export type SentTransaction = {
    hash: `0x${string}`;
    wait: () => Promise<TransactionReceipt>;
};

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
    sendTx: (tx: SendTransactionParameters<Chain, account>) => Promise<SentTransaction>;

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

    /**
     * Waits for a transaction receipt by polling it until it's available or a timeout occurs.
     * This method does not leak memory as the viem's default `waitForTransactionReceipt` method.
     * @param hash - The transaction hash to get the receipt for
     * @param timeout - The timeout in ms (default 60 sec)
     * @param pollingInterval - The polling interval in ms (default 3 sec)
     * @returns Resolves with the transaction receipt or rejects with timeout error
     */
    waitForReceipt: (params: {
        hash: `0x${string}`;
        timeout?: number;
        pollingInterval?: number;
    }) => Promise<TransactionReceipt>;
};

export namespace RainSolverSignerActions {
    export function fromSharedState(state: SharedState): () => RainSolverSignerActions {
        return () => ({
            state,
            busy: false,
            sendTx(tx) {
                return sendTx(this as RainSolverSigner, tx);
            },
            waitUntilFree() {
                return waitUntilFree(this as RainSolverSigner);
            },
            getSelfBalance() {
                return getSelfBalance(this as RainSolverSigner);
            },
            estimateGasCost(tx) {
                return estimateGasCost(this as RainSolverSigner, tx);
            },
            asWriteSigner() {
                return getWriteSignerFrom(this as RainSolverSigner);
            },
            waitForReceipt(params) {
                return tryGetReceipt(
                    this as RainSolverSigner,
                    params.hash,
                    params.timeout,
                    params.pollingInterval,
                );
            },
        });
    }
}

/**
 * A wrapper for viem sendTransactions that handles nonce and manages signer busy
 * state while the transaction is being sent ensuring proper busy state management
 *
 * @param signer - The RainSolverSigner instance to use for sending the transaction
 * @param tx - The transaction parameters to send
 * @param retryDelay - Optional delay in milliseconds before retrying a failed transaction (default: 3000ms)
 * @returns A Promise that resolves to the transaction hash
 * @throws Will throw if the transaction fails to send
 */
export async function sendTx(
    signer: RainSolverSigner,
    tx: SendTransactionParameters<Chain, HDAccount | PrivateKeyAccount>,
    retryDelay = 3_000,
): Promise<SentTransaction> {
    // make sure signer is free
    if (signer.busy) {
        await signer.waitUntilFree();
    }

    // start sending tranaction process
    signer.busy = true;
    let nonce: number | undefined = undefined;

    // set tx gas
    if (typeof tx.gas === "bigint") {
        tx.gas = getTxGas(signer.state, tx.gas);
    }

    async function send() {
        if (typeof nonce !== "number") {
            await signer
                .getTransactionCount({
                    address: signer.account.address,
                    blockTag: "latest",
                })
                .then((n) => (nonce = n))
                .catch((e) => {
                    nonce = undefined;
                    throw e;
                });
        }
        return await broadcastTx(signer, { ...(tx as any), nonce });
    }
    try {
        const hash = await send();
        const wait = () => tryGetReceipt(signer, hash);
        return { hash, wait };
    } catch (error) {
        await sleep(retryDelay); // wait for retryDelay time and retry once more
        try {
            const hash = await send();
            const wait = () => tryGetReceipt(signer, hash);
            return { hash, wait };
        } catch {
            signer.busy = false;
            throw error;
        }
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
    const gasPrice = signer.state.gasPrice;
    const gas = await signer.estimateGas({ ...tx, blockTag: "pending" } as any);
    const result: EstimateGasCostResult = {
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
    if (signer.state.gasTokenUsdPrice) {
        result.totalGasCostUsd = toUsdValue(result.totalGasCost, signer.state.gasTokenUsdPrice);
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
 * Broadcasts the given fully populated transaction (nonce, gas, gas price, etc),
 * the tx is signed once locally, with no rpc call involved, and sent as raw tx
 * through the signer's own rpc pool, that is the write rpcs for a write signer
 * (asWriteSigner) and the read rpcs otherwise, with multi broadcast enabled and a
 * pool of more than one rpc, the raw tx is sent through every rpc of the pool at
 * the same time, the first accepted one settles the send while the rest keep going
 * in the background, a node that already got the tx through another rpc answers
 * with an already known error, which counts as accepted since the tx is the same,
 * when no rpc accepts, the first error is thrown, otherwise the raw tx is sent as
 * a single request through the signer's rotating transport
 * @param signer - The RainSolverSigner instance to send the transaction with
 * @param tx - The transaction to broadcast
 * @returns The transaction hash
 */
export async function broadcastTx(
    signer: RainSolverSigner,
    tx: SendTransactionParameters<Chain, HDAccount | PrivateKeyAccount>,
): Promise<`0x${string}`> {
    // sign locally with the signer's chain id, no rpc call is involved
    const chainId = signer.state.chainConfig.id ?? (await signer.getChainId());
    const serialized = await signer.account.signTransaction(
        { ...(tx as any), chainId },
        { serializer: signer.chain?.serializers?.transaction },
    );

    // the pool is the one the signer was built on, that is the write rpcs for
    // a write signer (asWriteSigner) and the read rpcs otherwise
    const rpcState = signer.transport?.rpcState as RpcState | undefined;
    if (!signer.state.appOptions?.multiBroadcast || !rpcState || rpcState.urls.length < 2) {
        return signer.sendRawTransaction({ serializedTransaction: serialized });
    }
    const hash = keccak256(serialized);

    const sends = rpcState.urls.map(async (url) => {
        try {
            const transport = rpcState.transports[url]({
                chain: signer.chain,
                retryCount: 0,
                timeout: signer.state.rainSolverTransportConfig?.timeout,
            });
            const result = await transport.request({
                method: "eth_sendRawTransaction",
                params: [serialized],
            });
            return Result.ok<`0x${string}`, any>(result as `0x${string}`);
        } catch (error) {
            if (isAlreadyKnownTxError(error)) return Result.ok<`0x${string}`, any>(hash);
            return Result.err<`0x${string}`, any>(error);
        }
    });
    const pick = await raceFirstOk(sends);
    if (pick?.isOk()) return pick.value;

    // every rpc rejected the tx, all sends have settled at this point
    const results = await Promise.all(sends);
    throw results[0].isErr() ? results[0].error : new Error("failed to broadcast transaction");
}

/**
 * Get the associated write signer from the given signer and state, that is
 * basically the same signer wallet but configured with app's write rpc
 * @param signer - A RainSolverSigner instance
 * */
export function getWriteSignerFrom(signer: RainSolverSigner): RainSolverSigner {
    // if state doesnt have write rpc configured, return the signer as is
    if (!signer.state.writeRpc) return signer;
    return RainSolverSigner.create(signer.account, signer.state, true);
}

/**
 * Tries to get the transaction receipt for a given transaction hash.
 * this method does not leak memory as the viem's default `waitForTransactionReceipt`
 * method.
 * @param signer - The RainSolverSigner instance
 * @param hash - The transaction hash
 * @param timeout - The timeout in ms (default 60 sec)
 * @param pollingInterval - The polling interval in ms (default 3 sec)
 */
export async function tryGetReceipt(
    signer: RainSolverSigner,
    hash: `0x${string}`,
    timeout = 60_000,
    pollingInterval = 3_000,
): Promise<TransactionReceipt> {
    const start = Date.now();
    try {
        // ping "getTransactionReceipt" every "pollingInterval" until "success" or "timeout"
        const result = await promiseTimeout(
            (async () => {
                for (;;) {
                    try {
                        await sleep(pollingInterval);
                        return await signer.state.client.getTransactionReceipt({ hash });
                    } catch {
                        // ignore errors and continue polling until timeout or success
                        continue;
                    }
                }
            })(),
            timeout,
            new WaitForTransactionReceiptTimeoutError({ hash }),
        );
        // free the signer after transaction state is concluded (to not cause nonce conflicts)
        signer.busy = false;
        // capture tx mine record
        signer.state.gasManager.onTransactionMine({ didMine: true, length: Date.now() - start });
        return result;
    } catch (error) {
        // free the signer after transaction state is concluded (to not cause nonce conflicts)
        signer.busy = false;
        // capture tx mine record
        signer.state.gasManager.onTransactionMine({ didMine: false, length: Date.now() - start });
        throw error;
    }
}
