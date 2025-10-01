import { PublicClient } from "viem";
import { getGasPrice } from "./price";
import { ChainConfig } from "../state/chain";

/** Configuration for the gas manager */
export type GasManagerConfig = {
    chainConfig: ChainConfig;
    client: PublicClient;
    baseGasPriceMultiplier: number;
    maxGasPriceMultiplier?: number;
    gasIncreasePointsPerStep?: number;
    gasIncreaseStepTime?: number;
    txTimeThreshold?: number;
};

/** Transaction mining record */
export type TxMineRecord = {
    /** Time it took for the transaction to mine */
    length: number;
    /** Whether the transaction was mined successfully or timeout */
    didMine: boolean;
};

/**
 * The `GasManager` class provides mechanisms to dynamically adjust gas price multipliers
 * based on transaction mining times, periodically fetch current gas prices from the blockchain.
 *
 * Features:
 * - Tracks and updates the current gas price and L1 gas price (for L2 chains).
 * - Dynamically increases the gas price multiplier if transactions take longer than a threshold to mine for certain period.
 * - Resets the gas price multiplier to its base value after a configurable period.
 * - Periodically fetches and updates gas prices from the blockchain.
 * - Allows functionalities for starting and stopping gas price watcher.
 *
 * @example
 * ```typescript
 * const config = {
 *   client,
 *   chainConfig,
 *   baseGasPriceMultiplier: 1,
 *   maxGasPriceMultiplier: 10,
 *   gasIncreasePointsPerStep: 3,
 *   gasIncreaseStepTime: 60 * 60 * 1000,
 *   txTimeThreshold: 30_000,
 * };
 * const gasManager = await GasManager.init(config);
 * gasManager.watchGasPrice();
 * ```
 */
export class GasManager {
    /** Public client for interacting with the blockchain */
    readonly client: PublicClient;
    /** Chain configuration for the operating chain */
    readonly chainConfig: ChainConfig;
    /** Base gas price multiplier */
    readonly baseGasPriceMultiplier: number;
    /** Maximum gas price multiplier */
    readonly maxGasPriceMultiplier: number;
    /** The points to increase the gas price multiplier at each step */
    readonly gasIncreasePointsPerStep: number = 3; // default increase by 3 points
    /** The time to stay in increased the gas price multiplier before reseting to base */
    readonly gasIncreaseStepTime: number = 60 * 60 * 1000; // default 60 minutes in milliseconds
    /** The threshold for transaction time before considering it as a trigger for gas price multiplierincrease */
    readonly txTimeThreshold: number = 30_000; // default 30 seconds threshold

    /** Current gas price of the operating chain */
    gasPrice = 0n;
    /** Current L1 gas price of the operating chain, if the chain is a L2 chain, otherwise it is set to 0 */
    l1GasPrice = 0n;
    /** Current gas price multiplier */
    gasPriceMultiplier: number;
    /** Deadline for gas price increase to reset */
    deadline: number | undefined;

    private gasPriceWatcher: NodeJS.Timeout | undefined;

    constructor(config: GasManagerConfig) {
        this.client = config.client;
        this.chainConfig = config.chainConfig;
        this.baseGasPriceMultiplier = config.baseGasPriceMultiplier;
        if (config.txTimeThreshold) {
            this.txTimeThreshold = config.txTimeThreshold;
        }
        if (config.gasIncreasePointsPerStep) {
            this.gasIncreasePointsPerStep = config.gasIncreasePointsPerStep;
        }
        if (config.gasIncreaseStepTime) {
            this.gasIncreaseStepTime = config.gasIncreaseStepTime;
        }
        if (config.maxGasPriceMultiplier) {
            this.maxGasPriceMultiplier = config.maxGasPriceMultiplier;
        } else {
            this.maxGasPriceMultiplier = this.baseGasPriceMultiplier + 50;
        }
        this.gasPriceMultiplier = config.baseGasPriceMultiplier;
    }

    /**
     * Initializes a new instance of the GasManager and start watching gas price
     * @param config - Configuration for the gas manager
     */
    static init(config: GasManagerConfig) {
        const manager = new GasManager(config);
        manager.watchGasPrice();
        return manager;
    }

    /** Whether the gas price watcher is active */
    get isWatchingGasPrice(): boolean {
        if (this.gasPriceWatcher) return true;
        else return false;
    }

    /**
     * Updates the gas price multiplier by transaction mining event accordingly.
     * That is done through the following logic:
     * - If the transaction took longer than the threshold to mine, increase the gas price
     *   multiplier by a set number of points, up to a maximum value, and set a deadline for
     *   when the multiplier can be reset.
     * - If the transaction mined successfully and the current time is past the deadline,
     *   reset the gas price multiplier to its base value.
     * @param txMineRecord - The transaction mining record
     */
    onTransactionMine(txMineRecord: TxMineRecord) {
        if (txMineRecord.length >= this.txTimeThreshold) {
            this.deadline = Date.now() + this.gasIncreaseStepTime;
            this.gasPriceMultiplier = Math.min(
                this.maxGasPriceMultiplier,
                this.gasPriceMultiplier + this.gasIncreasePointsPerStep,
            );
        } else {
            if (this.deadline && Date.now() >= this.deadline) {
                this.gasPriceMultiplier = this.baseGasPriceMultiplier;
                this.deadline = undefined;
            }
        }
    }

    /**
     * Watches gas price during runtime by reading it periodically
     * @param interval - Interval to update gas price in milliseconds, default is 20 seconds
     */
    watchGasPrice(interval = 20_000) {
        if (this.isWatchingGasPrice) return;
        this.gasPriceWatcher = setInterval(async () => {
            const { gasPrice, l1GasPrice } = await getGasPrice(
                this.client,
                this.chainConfig,
                this.gasPriceMultiplier,
            );
            if (gasPrice.isOk()) {
                this.gasPrice = gasPrice.value;
            }
            if (l1GasPrice.isOk()) {
                this.l1GasPrice = l1GasPrice.value;
            }
        }, interval);
    }

    /** Unwatches gas price if the watcher has been already active */
    unwatchGasPrice() {
        if (this.isWatchingGasPrice) {
            clearInterval(this.gasPriceWatcher);
            this.gasPriceWatcher = undefined;
        }
    }
}
