import { SharedState } from "../state";
import { RainSolverSignerActions } from "./actions";
import { rainSolverTransport, RainSolverTransport } from "../transport";
import {
    Chain,
    Client,
    Prettify,
    HDAccount,
    PublicActions,
    publicActions,
    WalletActions,
    WalletRpcSchema,
    PrivateKeyAccount,
    createWalletClient,
    TransactionRequestBase,
} from "viem";

export { RainSolverSignerActions } from "./actions";

/**
 * RainSolverSigner is a custom viem client type that extends viem Client, it provides wallet
 * actions for sending transactions, public actions for chain interaction, and custom methods
 * for transaction management in the RainSolver app
 *
 * @remarks
 * This follows the viem pattern of extending and creating Client types
 *
 * @example
 * ```ts
 * // Create a new signer instance
 * const signer = await RainSolverSigner.create(
 *   privateKeyToAccount('0x...'), // Account
 *   sharedState // SharedState instance
 * );
 *
 * // Send a transaction
 * const hash = await signer.sendTx({
 *   to: '0x...',
 *   value: parseEther('0.1')
 * });
 *
 * // Estimate gas costs (includes L1 fees for L2 chains)
 * const costs = await signer.estimateGasCost({
 *   to: '0x...',
 *   data: '0x...'
 * });
 * ```
 */
export type RainSolverSigner<
    account extends HDAccount | PrivateKeyAccount = HDAccount | PrivateKeyAccount,
> = Prettify<
    Client<
        RainSolverTransport,
        Chain,
        account,
        WalletRpcSchema,
        WalletActions<Chain, account> &
            PublicActions<RainSolverTransport, Chain, account> &
            RainSolverSignerActions<account>
    >
>;

export namespace RainSolverSigner {
    /**
     * Creates a new RainSolverSigner instance for the given account and state.
     * @param account - The account to use for the signer
     * @param state - The state to use for the signer
     * @returns A new RainSolverSigner instance
     */
    export function create<account extends HDAccount | PrivateKeyAccount>(
        account: account,
        state: SharedState,
    ): RainSolverSigner<account> {
        return createWalletClient({
            account,
            chain: state.chainConfig,
            transport: rainSolverTransport(state.rpc, state.rainSolverTransportConfig),
        })
            .extend(publicActions)
            .extend(() => ({ state }))
            .extend(
                RainSolverSignerActions.fromSharedState(state) as any,
            ) as RainSolverSigner<account>;
    }
}

/** Type of RainSolverSigner for mnemonic accounts */
export type RainSolverMnemonicSigner = RainSolverSigner<HDAccount>;

/** Type of RainSolverSigner for private key accounts */
export type RainSolverPrivateKeySigner = RainSolverSigner<PrivateKeyAccount>;

/** Represents a raw transaction type with base fields that can be sent to the network */
export type RawTransaction = Prettify<
    Omit<TransactionRequestBase, "to"> & {
        to: `0x${string}`;
    }
>;

/** Result type for gas cost estimation that includes both L1 and L2 costs */
export type EstimateGasCostResult = {
    /** The estimated gas limit */
    gas: bigint;
    /** The current gas price of the chain */
    gasPrice: bigint;
    /** The current gas price on L1 (only relevant for L2 chains) */
    l1GasPrice: bigint;
    /** The estimated L1 cost in wei (only relevant for L2 chains) */
    l1Cost: bigint;
    /** The total estimated gas cost (L1 + L2 costs combined) */
    totalGasCost: bigint;
};
