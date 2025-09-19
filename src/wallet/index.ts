import assert from "assert";
import { formatUnits } from "viem";
import { fundVault } from "./fundVault";
import { RainSolverSigner } from "../signer";
import { PreAssembledSpan } from "../logger";
import { shuffleArray, sleep } from "../utils";
import { SpanStatusCode } from "@opentelemetry/api";
import { SharedState, TokenDetails } from "../state";
import { ErrorSeverity, errorSnapshot } from "../error";
import { WalletConfig, WalletType, MainAccountDerivationIndex } from "./config";
import { transferTokenFrom, transferRemainingGasFrom, convertToGas } from "./sweep";
import {
    HDAccount,
    mnemonicToAccount,
    PrivateKeyAccount,
    privateKeyToAccount,
} from "viem/accounts";

export * from "./config";

/** Specifies the number of sweep retries that need to take place for a wallet before being disposed */
export const SWEEP_RETRY_COUNT = 3 as const;

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
    /** The shared state instance */
    readonly state: SharedState;
    /** Wallet manager configurations*/
    readonly config: WalletConfig;
    /** The main wallet signer */
    readonly mainSigner: RainSolverSigner;
    /** The main wallet in viem account format */
    readonly mainWallet: HDAccount | PrivateKeyAccount;
    /**
     * Contains details of the worker wallets that include maps of worker
     * wallets in circulation, pending add list, and pending remove list
     */
    readonly workers: {
        /** Active worker wallets in circulation */
        readonly signers: Map<string, RainSolverSigner>;
        /** Wallets to be added in circulation that require funding to then go under active workers */
        readonly pendingAdd: Map<string, RainSolverSigner>;
        /** Disposed wallets that still have some token holdings that need to be swept before being completely disposed */
        readonly pendingRemove: Map<RainSolverSigner, number>;
        /** The last derivation index used for worker wallets */
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
                pendingAdd: Object.freeze(new Map()),
                pendingRemove: Object.freeze(new Map()),
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
                pendingAdd: new Map(),
                pendingRemove: new Map(),
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

    /**
     * Transfers the given token from the given wallet to the main wallet
     * @param wallet - The wallet to transfer the token from
     * @param token - The token to transfer
     * @returns An object containing transaction hash and transferred amount
     */
    async transferTokenFrom(wallet: RainSolverSigner, token: TokenDetails) {
        return transferTokenFrom(wallet, this.mainSigner, token);
    }

    /**
     * Transfers the remaining gas from the given wallet to the main wallet
     * @param wallet - The wallet to transfer the remaining gas from
     * @returns An object containing transaction hash and transferred amount
     */
    async transferRemainingGasFrom(wallet: RainSolverSigner) {
        return transferRemainingGasFrom(wallet, this.mainWallet.address);
    }

    /**
     * Sweeps the given wallet's erc20 token holdings (from state's watched tokens list) to the main wallet,
     * this function is fully instrumented for opentelemetry and will return a report of the sweep process
     * @param wallet - The wallet to sweep
     * @returns The report of the sweep process
     */
    async sweepWallet(wallet: RainSolverSigner): Promise<PreAssembledSpan> {
        const report = new PreAssembledSpan("sweep-wallet");
        report.setAttr("details.wallet", wallet.account.address);
        report.setAttr("details.destination", this.mainWallet.address);

        let hadFailures = false;

        // sweep erc20 tokens from the wallet
        for (const [, tokenDetails] of this.state.watchedTokens) {
            report.setAttr(`details.transfers.${tokenDetails.symbol}.token`, tokenDetails.address);
            try {
                const { amount, txHash } = await this.transferTokenFrom(wallet, tokenDetails);
                if (txHash) {
                    report.setAttr(
                        `details.transfers.${tokenDetails.symbol}.tx`,
                        this.state.chainConfig.blockExplorers?.default.url + "/tx/" + txHash,
                    );
                }
                report.setAttr(
                    `details.transfers.${tokenDetails.symbol}.status`,
                    "Transferred successfully",
                );
                report.setAttr(
                    `details.transfers.${tokenDetails.symbol}.amount`,
                    formatUnits(amount, tokenDetails.decimals),
                );
            } catch (error: any) {
                hadFailures = true;
                if ("txHash" in error) {
                    report.setAttr(
                        `details.transfers.${tokenDetails.symbol}.tx`,
                        this.state.chainConfig.blockExplorers?.default.url + "/tx/" + error.txHash,
                    );
                    report.setAttr(
                        `details.transfers.${tokenDetails.symbol}.status`,
                        errorSnapshot("", error.error),
                    );
                } else {
                    report.setAttr(
                        `details.transfers.${tokenDetails.symbol}.status`,
                        errorSnapshot("Failed to transfer", error),
                    );
                }
            }
        }

        // sweep remaining gas from the wallet
        try {
            const { amount, txHash } = await this.transferRemainingGasFrom(wallet);
            if (txHash) {
                report.setAttr(
                    `details.transfers.remainingGas.tx`,
                    this.state.chainConfig.blockExplorers?.default.url + "/tx/" + txHash,
                );
            }
            report.setAttr(`details.transfers.remainingGas.status`, "Transferred successfully");
            report.setAttr(`details.transfers.remainingGas.amount`, formatUnits(amount, 18));
        } catch (error: any) {
            hadFailures = true;
            if ("txHash" in error) {
                report.setAttr(
                    `details.transfers.remainingGas.tx`,
                    this.state.chainConfig.blockExplorers?.default.url + "/tx/" + error.txHash,
                );
                report.setAttr(
                    `details.transfers.remainingGas.status`,
                    errorSnapshot("", error.error),
                );
            } else {
                report.setAttr(`details.transfers.remainingGas.status`, errorSnapshot("", error));
            }
        }

        // if there were failures, set the severity to low and set the status to error
        if (hadFailures) {
            report.setAttr("severity", ErrorSeverity.LOW);
            report.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Failed to sweep some tokens, it will try again later",
            });
        } else {
            report.setStatus({
                code: SpanStatusCode.OK,
                message: "Successfully swept wallet tokens",
            });
        }

        report.end();
        return report;
    }

    /**
     * Converts the main wallet's balance of the given token to gas if the received
     * amount is greater than the swap transaction cost * swapCostMultiplier
     * @param token - The token to swap to gas
     * @param swapCostMultiplier - The multiplier for the swap cost
     * @returns An object containing transaction hash, amount, route, received amount,
     * received amount min, status, and expected gas cost
     */
    async convertToGas(token: TokenDetails, swapCostMultiplier?: bigint) {
        return convertToGas(this.mainSigner, token, swapCostMultiplier);
    }

    /**
     * Converts the main wallet's balance of all watched tokens to gas, this method is fully
     * instrumented for opentelemetry and will return a report of the conversion process
     * @param swapCostMultiplier - The multiplier for the swap cost
     * @returns The report of the conversion process
     */
    async convertHoldingsToGas(swapCostMultiplier?: bigint): Promise<PreAssembledSpan> {
        const report = new PreAssembledSpan("sweep-wallet");
        report.setAttr("details.wallet", this.mainWallet.address);

        for (const [, tokenDetails] of this.state.watchedTokens) {
            report.setAttr(`details.swaps.${tokenDetails.symbol}.token`, tokenDetails.address);

            try {
                const {
                    route = undefined,
                    txHash = undefined,
                    amount = undefined,
                    status = undefined,
                    receivedAmount = undefined,
                    expectedGasCost = undefined,
                    receivedAmountMin = undefined,
                } = await this.convertToGas(tokenDetails, swapCostMultiplier);

                // handle the result as report attributes
                if (txHash) {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.tx`,
                        this.state.chainConfig.blockExplorers?.default.url + "/tx/" + txHash,
                    );
                }
                if (typeof status === "string") {
                    report.setAttr(`details.swaps.${tokenDetails.symbol}.status`, status);
                }
                if (typeof amount === "bigint") {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.amount`,
                        formatUnits(amount, tokenDetails.decimals),
                    );
                }
                if (typeof receivedAmount === "bigint") {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.receivedAmount`,
                        formatUnits(receivedAmount, tokenDetails.decimals),
                    );
                }
                if (typeof receivedAmountMin === "bigint") {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.receivedAmountMin`,
                        formatUnits(receivedAmountMin, tokenDetails.decimals),
                    );
                }
                if (typeof expectedGasCost === "bigint") {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.expectedGasCost`,
                        formatUnits(expectedGasCost, tokenDetails.decimals),
                    );
                }
                if (typeof route === "string") {
                    report.setAttr(`details.swaps.${tokenDetails.symbol}.route`, route);
                }
            } catch (error: any) {
                if ("txHash" in error) {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.tx`,
                        this.state.chainConfig.blockExplorers?.default.url + "/tx/" + error.txHash,
                    );
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.status`,
                        errorSnapshot("", error.error),
                    );
                } else {
                    report.setAttr(
                        `details.swaps.${tokenDetails.symbol}.status`,
                        errorSnapshot("Failed to convert token to gas", error),
                    );
                }
            }
        }

        report.end();
        return report;
    }

    /**
     * Sweeps the given wallet's tokens back to the main wallet, if the sweep fails,
     * the wallet goes into pending remove list for future retries
     * @param worker - The worker wallet to remove
     * @returns The report of the removal process
     */
    async tryRemoveWorker(worker: RainSolverSigner): Promise<PreAssembledSpan> {
        const report = await this.sweepWallet(worker);
        report.name = "remove-wallet";
        if (report.status?.code === SpanStatusCode.ERROR) {
            const tryCount = this.workers.pendingRemove.get(worker);
            if (typeof tryCount === "number") {
                if (tryCount >= SWEEP_RETRY_COUNT) {
                    this.workers.pendingRemove.delete(worker);
                } else {
                    this.workers.pendingRemove.set(worker, tryCount + 1);
                }
            } else {
                this.workers.pendingRemove.set(worker, 1);
            }
        }

        return report;
    }

    /**
     * Adds a new worker wallet into circulation, if funding the new wallet
     * fails, it goes into workers pending add list for funding retry
     * @param worker - The worker wallet to add
     * @returns The report of the addition process
     */
    async tryAddWorker(worker: RainSolverSigner): Promise<PreAssembledSpan> {
        const report = await this.fundWallet(worker.account.address)
            .then((report) => {
                this.workers.signers.set(worker.account.address.toLowerCase(), worker);
                return report;
            })
            .catch((report) => {
                this.workers.pendingAdd.set(worker.account.address.toLowerCase(), worker);
                return report as PreAssembledSpan;
            });
        report.name = "add-wallet";

        return report;
    }

    /**
     * Retries to resolve the pending workers for removal and add lists
     * @returns The reports of the retry process
     */
    async retryPendingAddWorkers(): Promise<PreAssembledSpan[]> {
        const pendingAddReports = [];
        for (const [, worker] of this.workers.pendingAdd) {
            pendingAddReports.push(await this.tryAddWorker(worker));
        }

        return pendingAddReports;
    }

    /**
     * Retries to resolve the pending workers for removal and add lists
     * @returns The reports of the retry process
     */
    async retryPendingRemoveWorkers(): Promise<PreAssembledSpan[]> {
        const pendingRemoveReports = [];
        for (const [worker] of this.workers.pendingRemove) {
            pendingRemoveReports.push(await this.tryRemoveWorker(worker));
        }

        return pendingRemoveReports;
    }

    /**
     * Identifies wallets that need to be removed from circulation and replaces them with new ones
     * @returns The reports of the removal and addition processes
     */
    async assessWorkers(): Promise<
        {
            removeWorkerReport: PreAssembledSpan;
            addWorkerReport: PreAssembledSpan;
        }[]
    > {
        // identify wallets that need to be removed from cisrculation
        // thie criteria is if their current gas balance is below avg tx gas cost
        const removeList = [];
        for (const [, worker] of this.workers.signers) {
            const balance = await worker.getSelfBalance();
            if (balance < this.state.avgGasCost * 4n) {
                removeList.push(worker);
            }
        }

        // remove the identified wallet and replace them with new ones
        const reports = [];
        for (const worker of removeList) {
            this.workers.signers.delete(worker.account.address.toLowerCase());

            // handle the worker removal
            const removeWorkerReport = await this.tryRemoveWorker(worker);

            // handle adding the new wallet
            const wallet = mnemonicToAccount(this.config.key, {
                addressIndex: ++this.workers.lastUsedDerivationIndex,
            });
            const newWorker = RainSolverSigner.create(wallet, this.state);
            const addWorkerReport = await this.tryAddWorker(newWorker);

            // push the reports into the list
            reports.push({ removeWorkerReport, addWorkerReport });
        }

        return reports;
    }

    /**
     * Funds the vaults that are owned by the main wallet, this function is fully
     * instrumented for opentelemetry and will return a report of the funding process
     */
    async fundOwnedVaults(): Promise<PreAssembledSpan[]> {
        const reports = [];
        if (this.config.selfFundVaults) {
            for (const vaultDetails of this.config.selfFundVaults) {
                // start a report with details
                const report = new PreAssembledSpan("fund-owned-vaults");
                report.setAttr("details.wallet", this.mainWallet.address);
                report.setAttr("details.vault", vaultDetails.vaultId);
                report.setAttr("details.token", vaultDetails.token);
                report.setAttr("details.orderbook", vaultDetails.orderbook);
                report.setAttr("details.topupAmount", vaultDetails.topupAmount);
                report.setAttr("details.threshold", vaultDetails.threshold);
                try {
                    const result = await fundVault(vaultDetails, this.mainSigner);
                    if (!result) continue;
                    const { txHash } = result;

                    // record funding results
                    report.setAttr(
                        "details.tx",
                        this.state.chainConfig.blockExplorers?.default.url + "/tx/" + txHash,
                    );
                    report.setStatus({
                        code: SpanStatusCode.OK,
                        message: "Successfully funded vault",
                    });
                } catch (error: any) {
                    // record funding results
                    let message = "";
                    if ("txHash" in error) {
                        message = errorSnapshot("Failed to fund vault", error.error);
                        report.setAttr(
                            "details.tx",
                            this.state.chainConfig.blockExplorers?.default.url +
                                "/tx/" +
                                error.txHash,
                        );
                    } else {
                        message = errorSnapshot("Failed to fund vault", error);
                    }
                    report.setAttr("severity", ErrorSeverity.MEDIUM);
                    report.setStatus({ code: SpanStatusCode.ERROR, message });
                }
                report.end();
                reports.push(report);
            }
        }

        return reports;
    }

    /**
     * Returns the first available signer by polling the
     * signers until first one becomes available
     */
    async getRandomSigner(shuffle = false): Promise<RainSolverSigner> {
        if (!this.workers.signers.size) {
            return this.mainSigner;
        }
        const signers = Array.from(this.workers.signers.values());
        if (shuffle) {
            shuffleArray(signers);
        }
        for (;;) {
            const acc = signers.find((v) => !v.busy);
            if (acc) {
                return acc;
            } else {
                await sleep(30);
            }
        }
    }
}
