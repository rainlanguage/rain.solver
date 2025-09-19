import assert from "assert";
import { formatUnits } from "viem";
import { SharedState } from "../state";
import { RainSolverSigner } from "../signer";
import { PreAssembledSpan } from "../logger";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorSeverity, errorSnapshot } from "../error";
import { WalletConfig, WalletType, MainAccountDerivationIndex } from "./config";
import {
    HDAccount,
    mnemonicToAccount,
    PrivateKeyAccount,
    privateKeyToAccount,
} from "viem/accounts";

export * from "./config";

/**
 * Provides functionalities to manages wallet operations for RainSolver during runtime, such as:
 * - Funding worker wallets from a main wallet
 * - Monitoring wallet balances and reporting low balance conditions
 * - Adding new worker wallets into circulation as needed
 * - Sweeping bounty and profits back to main wallet and converting them into gas tokens
 *
 * In single wallet mode (private key):
 * - Only one wallet is used for all operations
 * - No worker wallets are created or managed
 *
 * In multi-wallet mode (mnemonic):
 * - The main wallet is derived at index 0 to fund worker wallets
 * - Multiple worker wallets are derived from the same mnemonic key with incremental derivation indexes
 * - Each worker wallet is funded from the main wallet
 */
export class WalletManager {
    readonly state: SharedState;
    readonly config: WalletConfig;
    readonly mainSigner: RainSolverSigner;
    readonly mainWallet: HDAccount | PrivateKeyAccount;
    readonly workers: {
        readonly signers: Map<string, RainSolverSigner>;
        lastUsedDerivationIndex: number;
    };

    private constructor(state: SharedState) {
        this.state = state;
        this.config = state.walletConfig;
        if (this.config.type === WalletType.PrivateKey) {
            this.mainWallet = privateKeyToAccount(this.config.key);
            // set workers to an empty frozen obj when in single wallet mode
            this.workers = Object.freeze({
                signers: Object.freeze(new Map()),
                lastUsedDerivationIndex: NaN,
            });
        } else {
            this.mainWallet = mnemonicToAccount(this.config.key, {
                addressIndex: MainAccountDerivationIndex,
            });
            let lastUsedDerivationIndex = 0;
            const signers = new Map();
            for (let i = 0; i < this.config.count; i++) {
                const wallet = mnemonicToAccount(this.config.key, {
                    addressIndex: ++lastUsedDerivationIndex,
                });
                signers.set(
                    wallet.address.toLowerCase(),
                    RainSolverSigner.create(wallet, this.state),
                );
            }
            this.workers = {
                signers,
                lastUsedDerivationIndex,
            };
            assert(
                this.workers!.lastUsedDerivationIndex === this.config.count,
                "Failed to create expected number of worker wallets, something went wrong!",
            );
        }
        this.mainSigner = RainSolverSigner.create(this.mainWallet, this.state);
    }

    /**
     * Initializes the wallet manager and funds the workers if this is a multiwallet setup
     * @returns The wallet manager and the reports of the funding process
     */
    static async init(
        state: SharedState,
    ): Promise<{ walletManager: WalletManager; reports: PreAssembledSpan[] }> {
        const walletManager = new WalletManager(state);

        // topup workers if this is a multiwallet setup
        const reports = [];
        if (walletManager.config.type === WalletType.Mnemonic) {
            for (const [address] of walletManager.workers.signers) {
                reports.push(
                    await walletManager
                        .fundWallet(address)
                        .catch((error: any) => error as any as PreAssembledSpan),
                );
            }
        }

        return { walletManager, reports };
    }

    /**
     * Sends gas token the given wallet address from the main wallet
     * @param wallet - The destination wallet address
     * @param topupAmount - (optional) Topup amount, default is the top up amount in this.config
     * @returns The report of the funding process
     * @throws If topup amount is not defined or fails to successfully top up
     */
    async fundWallet(wallet: string, topupAmount?: bigint): Promise<PreAssembledSpan> {
        let amount: bigint | undefined = topupAmount;
        if (amount === undefined && this.config.type === WalletType.Mnemonic) {
            amount = this.config.topupAmount;
        }
        if (typeof amount === "undefined") throw new Error("undefined topup amount");

        const report = new PreAssembledSpan("fund-wallet");
        report.setAttr("details.wallet", wallet);
        report.setAttr("details.amount", formatUnits(amount, 18));

        if (amount <= 0n) {
            report.setStatus({ code: SpanStatusCode.OK, message: "Zero topup amount" });
            report.end();
            return report;
        } else {
            try {
                const mainWalletBalance = await this.mainSigner.getSelfBalance();

                // exit early if the main wallet has insufficient balance
                if (mainWalletBalance <= amount) {
                    report.setAttr("severity", ErrorSeverity.MEDIUM);
                    report.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: [
                            "Low on funds to topup the wallet",
                            `current main account balance: ${formatUnits(mainWalletBalance, 18)}`,
                            `topup amount: ${formatUnits(amount, 18)}`,
                        ].join("\n"),
                    });
                    report.end();
                    return Promise.reject(report);
                }

                // fund the wallet
                const hash = await this.mainSigner.sendTx({
                    to: wallet as `0x${string}`,
                    value: amount,
                });
                const receipt = await this.mainSigner.waitForTransactionReceipt({
                    hash,
                    confirmations: 4,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    report.setStatus({
                        code: SpanStatusCode.OK,
                        message: "Successfully topped up",
                    });
                    report.end();
                    return report;
                } else {
                    report.setAttr("severity", ErrorSeverity.LOW);
                    report.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: "Failed to topup wallet: tx reverted",
                    });
                    report.end();
                    return Promise.reject(report);
                }
            } catch (error: any) {
                report.setAttr("severity", ErrorSeverity.LOW);
                report.recordException(error);
                report.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: errorSnapshot("Failed to topup wallet", error),
                });
                report.end();
                throw report;
            }
        }
    }

    /**
     * Adds a new worker wallet into circulation if this instance is a multiwallet setup
     * @returns The report of the funding process
     */
    async addWallet(): Promise<PreAssembledSpan | undefined> {
        // return early if this is single wallet mode
        if (this.config.type === WalletType.PrivateKey) return;

        const wallet = mnemonicToAccount(this.config.key, {
            addressIndex: ++this.workers.lastUsedDerivationIndex,
        });

        const report = await this.fundWallet(wallet.address).catch(
            (error: any) => error as any as PreAssembledSpan,
        );
        report.name = "add-wallet";

        this.workers.signers.set(
            wallet.address.toLowerCase(),
            RainSolverSigner.create(wallet, this.state),
        );
        return report;
    }

    /** Checks the balance of the main wallet and returns the report */
    async checkMainWalletBalance(): Promise<PreAssembledSpan> {
        const report = new PreAssembledSpan("check-wallet-balance");
        try {
            const balance = await this.mainSigner.getSelfBalance();
            if (this.config.minBalance > balance) {
                const header = `bot main wallet ${
                    this.mainWallet.address
                } is low on gas, expected at least: ${formatUnits(
                    this.config.minBalance,
                    18,
                )}, current: ${formatUnits(balance, 18)}, `;
                const fill = this.workers.signers.size
                    ? `that wallet is the one that funds the multi wallet, there are still ${
                          this.workers.signers.size + 1
                      } wallets with enough balance in circulation that clear orders, please consider topping up soon`
                    : "it will still work with remaining gas as far as it can, please topup as soon as possible";
                report.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: header + fill,
                });
                report.setAttr(
                    "severity",
                    this.workers.signers.size ? ErrorSeverity.MEDIUM : ErrorSeverity.HIGH,
                );
            } else {
                report.setStatus({ code: SpanStatusCode.OK });
            }
        } catch (error: any) {
            report.recordException(error);
            report.setStatus({
                code: SpanStatusCode.ERROR,
                message: errorSnapshot("Failed to check main wallet balance", error),
            });
            report.setAttr("severity", ErrorSeverity.LOW);
        }

        report.end();
        return report;
    }
}
