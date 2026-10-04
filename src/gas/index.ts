import { PublicClient } from "viem";
import { getGasPrice } from "./price";
import { ChainConfig } from "../state/chain";

/** Configuration for the gas manager */
export type GasManagerConfig = {
    /** Public client for interacting with the blockchain */
    client: PublicClient;
    /** Chain configuration for the operating chain */
    chainConfig: ChainConfig;
    /** Base gas price multiplier, the multiplier can't go below this value */
    baseGasPriceMultiplier: number;
    /** Maximum gas price multiplier, the multiplier can't go above this value */
    maxGasPriceMultiplier?: number;
    /** The points to increase the gas price multiplier at each step */
    gasIncreasePointsPerStep?: number;
    /** The time to stay in increased gas price multiplier before resetting to base value */
    gasIncreaseStepTime?: number;
    /** The time threshold (in ms) for transaction mine time before considering it as a trigger for gas price multiplier increase */
    txTimeThreshold: number;
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
 * - Dynamically increases the gas price multiplier if mined transactions take longer than a threshold to mine, at most one step per configurable period, every slow transaction holds the level for another period, a timed out receipt wait is not a gas signal and does not count.
 * - Steps the gas price multiplier down towards its base value, one step per configurable period, whether a transaction mines or not.
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
    readonly gasIncreasePointsPerStep: number = 10; // default increase by 10 points
    /** The time to stay in increased the gas price multiplier before reseting to base */
    readonly gasIncreaseStepTime: number = 6 * 60 * 1000; // default 6 minutes in milliseconds
    /** The threshold for transaction time before considering it as a trigger for gas price multiplierincrease */
    readonly txTimeThreshold: number; // default 15 seconds threshold

    /** Current gas price of the operating chain */
    gasPrice = 0n;
    /** Current L1 gas price of the operating chain, if the chain is a L2 chain, otherwise it is set to 0 */
    l1GasPrice = 0n;
    /** Current gas price multiplier */
    gasPriceMultiplier: number;
    /** Deadline for gas price increase to reset */
    deadline: number | undefined;
    /** Timestamp of the last gas price multiplier step up, undefined when none has happened yet */
    lastStepUp: number | undefined;

    private gasPriceWatcher: ReturnType<typeof setInterval> | undefined;

    constructor(config: GasManagerConfig) {
        this.client = config.client;
        this.chainConfig = config.chainConfig;
        this.baseGasPriceMultiplier = config.baseGasPriceMultiplier;
        this.txTimeThreshold = config.txTimeThreshold;
        if (config.gasIncreasePointsPerStep !== undefined) {
            this.gasIncreasePointsPerStep = config.gasIncreasePointsPerStep;
        }
        if (config.gasIncreaseStepTime !== undefined) {
            this.gasIncreaseStepTime = config.gasIncreaseStepTime;
        }
        if (config.maxGasPriceMultiplier !== undefined) {
            // the ceiling can never sit below the base
            this.maxGasPriceMultiplier = Math.max(
                config.baseGasPriceMultiplier,
                config.maxGasPriceMultiplier,
            );
        } else {
            this.maxGasPriceMultiplier = this.baseGasPriceMultiplier + 1000; // default +10x ceiling
        }
        this.gasPriceMultiplier = config.baseGasPriceMultiplier;
    }

    /**
     * Initializes a new instance of the GasManager and start watching gas price
     * @param config - Configuration for the gas manager
     */
    static async init(config: GasManagerConfig) {
        const manager = new GasManager(config);

        // get init gas price
        const { gasPrice, l1GasPrice } = await getGasPrice(
            manager.client,
            manager.chainConfig,
            manager.gasPriceMultiplier,
        );
        if (gasPrice.isOk()) {
            manager.gasPrice = gasPrice.value;
        }
        if (l1GasPrice.isOk()) {
            manager.l1GasPrice = l1GasPrice.value;
        }

        // start watcher
        manager.watchGasPrice();

        return manager;
    }

    /** Whether the gas price watcher is active */
    get isWatchingGasPrice(): boolean {
        return this.gasPriceWatcher !== undefined;
    }

    /**
     * Updates the gas price multiplier by the given transaction mining event accordingly.
     * That is done through the following logic:
     * - A timed out receipt wait is ignored, it is not a gas signal, a timeout has other
     *   causes too (an rpc not serving the receipt, a dropped tx) and counting it would
     *   drive the multiplier up with no effect on the cause.
     * - If the mined transaction took longer than the threshold to mine, it holds the
     *   current multiplier for another step time by pushing the step down deadline out,
     *   and increases the multiplier by a set number of points, up to a maximum value,
     *   at most once per step time, so sustained slow transactions climb one step per
     *   step time instead of one step per transaction, and the decay starts one step
     *   time after the last slow transaction.
     * - If the transaction mined fast and the current time is past the deadline,
     *   reduces it step by step until back to base.
     * @param txMineRecord - The transaction mining record
     */
    onTransactionMine(txMineRecord: TxMineRecord) {
        if (!txMineRecord.didMine) return;
        const now = Date.now();
        if (txMineRecord.length >= this.txTimeThreshold) {
            // a slow tx always holds the level, the step up is rate limited
            this.deadline = now + this.gasIncreaseStepTime;
            if (this.lastStepUp !== undefined && now - this.lastStepUp < this.gasIncreaseStepTime) {
                return;
            }
            this.lastStepUp = now;
            this.gasPriceMultiplier = Math.min(
                this.maxGasPriceMultiplier,
                this.gasPriceMultiplier + this.gasIncreasePointsPerStep,
            );
        } else {
            if (this.deadline && now >= this.deadline) {
                this.gasPriceMultiplier = Math.max(
                    this.baseGasPriceMultiplier,
                    this.gasPriceMultiplier - this.gasIncreasePointsPerStep,
                );
                if (this.gasPriceMultiplier <= this.baseGasPriceMultiplier) {
                    this.deadline = undefined;
                }
            }
        }
    }

    /**
     * Steps the gas price multiplier down by one step once the deadline of the
     * current step has passed, and sets the deadline of the next step, so the
     * multiplier decays one step per step time until it is back at base, where
     * the deadline gets cleared, the gas price watcher calls this on every tick,
     * so the decay goes on without mined transactions, the mine events step the
     * multiplier down on their own after the deadline, without a next deadline
     */
    stepDownGasPriceMultiplierIfDue() {
        const now = Date.now();
        if (this.deadline === undefined || now < this.deadline) return;
        this.gasPriceMultiplier = Math.max(
            this.baseGasPriceMultiplier,
            this.gasPriceMultiplier - this.gasIncreasePointsPerStep,
        );
        if (this.gasPriceMultiplier <= this.baseGasPriceMultiplier) {
            this.deadline = undefined;
        } else {
            this.deadline = now + this.gasIncreaseStepTime;
        }
    }

    /**
     * Watches gas price during runtime by reading it periodically, each tick also
     * steps an increased gas price multiplier down once its deadline has passed
     * @param interval - Interval to update gas price in milliseconds, default is 20 seconds
     */
    watchGasPrice(interval = 20_000) {
        if (this.isWatchingGasPrice) return;
        this.gasPriceWatcher = setInterval(async () => {
            this.stepDownGasPriceMultiplierIfDue();
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
