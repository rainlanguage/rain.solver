import { BlockTag, PublicClient } from "viem";
import { TxType } from "../config";
import { promiseTimeout } from "../common";
import { ChainConfig } from "../state/chain";
import { getChainGasPrice, getFeeHistoryFees, getGasPrice, getL1GasPrice } from "./price";

/** The longest wait for a fee fetch in ms, see GasManager.updateFees */
export const FEE_FETCH_TIMEOUT = 120_000;

/** The fee fields of a transaction, a gas price for a legacy one, a max fee and a tip for an eip1559 one */
export type TxFees =
    | { gasPrice: bigint; maxFeePerGas?: undefined; maxPriorityFeePerGas?: undefined }
    | { gasPrice?: undefined; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** Configuration for the gas manager */
export type GasManagerConfig = {
    /** Public client for interacting with the blockchain */
    client: PublicClient;
    /** Chain configuration for the operating chain */
    chainConfig: ChainConfig;
    /** The type of the transactions, legacy when unset, see AppOptions.txType */
    txType?: TxType;
    /** The number of sealed blocks between two fee fetches, 10 when unset, see AppOptions.gasFeeBlockInterval */
    gasFeeBlockInterval?: number;
    /** The percentiles of each block's tips in the fee history, [75] when unset, see AppOptions.priorityFeePercentiles */
    priorityFeePercentiles?: number[];
    /** The headroom of the max fee over the base fee, 2 when unset, see AppOptions.maxFeeBaseFeeMultiplier */
    maxFeeBaseFeeMultiplier?: number;
    /** The multiplier on the fee history's tip, 1 when unset, see AppOptions.priorityFeeMultiplier */
    priorityFeeMultiplier?: number;
    /** The newest block of the fee history, latest when unset, the configured call block tag */
    feeHistoryBlockTag?: BlockTag;
};

/**
 * The `GasManager` class keeps the gas fees of the transactions current.
 *
 * Features:
 * - Keeps the fees of a transaction, the gas price of a legacy one, or the base fee, the tip (priority fee) and the max fee of an eip1559 one, and the L1 gas price on an L2 chain, see txFees. The tip is the market one off the fee history times priorityFeeMultiplier.
 * - Keeps the expected gas price the estimates count with, the base fee plus the tip in eip1559 mode, see gasPrice.
 * - Takes the base fee of every new head, see setBaseFee, and fetches the fees once every gasFeeBlockInterval sealed blocks, the fee history in eip1559 mode, the gas price in legacy mode, see onBlock and updateFees. The sweep command fetches on a timer instead, see watchGasPrice.
 * - Falls back to legacy transactions on a chain without a base fee, and to the node's gas price for the tip when the fee history fails, see updateFees.
 *
 * @example
 * ```typescript
 * const config = {
 *   client,
 *   chainConfig,
 *   txType: TxType.Eip1559,
 *   gasFeeBlockInterval: 10,
 *   priorityFeePercentiles: [75],
 *   maxFeeBaseFeeMultiplier: 2,
 *   priorityFeeMultiplier: 1.07,
 * };
 * const gasManager = await GasManager.init(config);
 * ```
 */
export class GasManager {
    /** Public client for interacting with the blockchain */
    readonly client: PublicClient;
    /** Chain configuration for the operating chain */
    readonly chainConfig: ChainConfig;
    /** The type of the transactions, a chain without a base fee always gets legacy ones */
    readonly txType: TxType = TxType.Legacy;
    /** The number of sealed blocks between two fee fetches */
    readonly gasFeeBlockInterval: number = 10;
    /** The percentiles of each block's tips in the fee history */
    readonly priorityFeePercentiles: number[] = [75];
    /** The headroom of the max fee over the base fee, see maxFeePerGas */
    readonly maxFeeBaseFeeMultiplier: number = 2;
    /** The multiplier on the fee history's tip, applied at its fetch, see updateFees */
    readonly priorityFeeMultiplier: number = 1;
    /** The newest block of the fee history, latest when unset */
    readonly feeHistoryBlockTag?: BlockTag;

    /**
     * The expected gas price of a transaction, what the estimates count with, the
     * fetched gas price in legacy mode, the base fee plus the tip in eip1559 mode.
     * In eip1559 mode the legacy gas price stands in until both the base fee and
     * the tip are known, it holds the node's own tip, a base fee alone never
     * replaces it, see isEip1559
     */
    gasPrice = 0n;
    /**
     * The base fee of the chain's latest head, undefined until known, null when the
     * chain has no base fee, then the transactions are legacy ones
     */
    baseFeePerGas: bigint | null | undefined;
    /** The tip of an eip1559 transaction, the fee history's tip times the multiplier at its fetch */
    priorityFee = 0n;
    /**
     * Whether the tip has been read at least once, off the fee history or off the
     * node's gas price, the fees are legacy ones until then, see isEip1559
     */
    private tipKnown = false;
    /**
     * The fee history fetches that failed in a row, a successful one resets it,
     * the tip comes off the fallback meanwhile, see updateFees
     */
    feeFetchFailures = 0;
    /** The error of the last failed fee history fetch, cleared by a successful one */
    lastFeeFetchError: string | undefined;
    /** The sealed block the fees were last fetched at, see onBlock */
    private feesFetchedAt: bigint | undefined;
    /** Whether a fee fetch is in flight, a new block does not start another one meanwhile */
    private feesFetchInFlight = false;
    /** Current L1 gas price of the operating chain, if the chain is a L2 chain, otherwise it is set to 0 */
    l1GasPrice = 0n;

    private gasPriceWatcher: ReturnType<typeof setInterval> | undefined;

    constructor(config: GasManagerConfig) {
        this.client = config.client;
        this.chainConfig = config.chainConfig;
        if (config.txType !== undefined) this.txType = config.txType;
        if (config.gasFeeBlockInterval !== undefined) {
            this.gasFeeBlockInterval = config.gasFeeBlockInterval;
        }
        if (config.priorityFeePercentiles !== undefined) {
            this.priorityFeePercentiles = config.priorityFeePercentiles;
        }
        if (config.maxFeeBaseFeeMultiplier !== undefined) {
            this.maxFeeBaseFeeMultiplier = config.maxFeeBaseFeeMultiplier;
        }
        if (config.priorityFeeMultiplier !== undefined) {
            this.priorityFeeMultiplier = config.priorityFeeMultiplier;
        }
        this.feeHistoryBlockTag = config.feeHistoryBlockTag;
    }

    /**
     * The given market tip times priorityFeeMultiplier, applied with 2 decimals
     * @param tip - The tip as read
     */
    private scaleTip(tip: bigint): bigint {
        return (tip * BigInt(Math.round(this.priorityFeeMultiplier * 100))) / 100n;
    }

    /**
     * Whether the transactions go out as eip1559 ones, the type asks for it, the
     * chain has a base fee and the tip has been read, a read tip of 0 counts, a
     * chain whose blocks pay none orders by arrival. A base fee alone makes no
     * eip1559 transaction, the tip is not known yet, and no gas price, the legacy
     * one that stands in holds the node's own tip
     */
    get isEip1559(): boolean {
        return (
            this.txType === TxType.Eip1559 &&
            typeof this.baseFeePerGas === "bigint" &&
            this.tipKnown
        );
    }

    /**
     * The max fee of an eip1559 transaction at the market tip, the base fee times
     * the headroom plus the tip, undefined in legacy mode, the headroom is applied
     * with 2 decimals. The transaction pays the base fee plus the tip at inclusion,
     * the headroom lets the base fee rise before inclusion
     */
    get maxFeePerGas(): bigint | undefined {
        if (!this.isEip1559) return undefined;
        const headroom = BigInt(Math.round(this.maxFeeBaseFeeMultiplier * 100));
        return ((this.baseFeePerGas as bigint) * headroom) / 100n + this.priorityFee;
    }

    /**
     * The fee fields of a transaction as things stand, the max fee and the tip in
     * eip1559 mode, the gas price otherwise
     */
    txFees(): TxFees {
        const maxFeePerGas = this.maxFeePerGas;
        if (maxFeePerGas === undefined) return { gasPrice: this.gasPrice };
        return { maxFeePerGas, maxPriorityFeePerGas: this.priorityFee };
    }

    /**
     * Takes the base fee of a new head, undefined when the head did not carry one,
     * which changes nothing, null when the chain has no base fee, which makes the
     * transactions legacy ones. In eip1559 mode the gas price follows it right away
     * @param baseFeePerGas - The head's base fee
     */
    setBaseFee(baseFeePerGas: bigint | null | undefined) {
        if (baseFeePerGas === undefined) return;
        this.baseFeePerGas = baseFeePerGas;
        this.refreshGasPrice();
    }

    /**
     * Takes a new sealed block and fetches the fees once every gasFeeBlockInterval
     * sealed blocks, in the background, one fetch at a time
     * @param blockNumber - The new sealed block number
     */
    onBlock(blockNumber: bigint) {
        if (
            this.feesFetchedAt !== undefined &&
            blockNumber - this.feesFetchedAt < BigInt(this.gasFeeBlockInterval)
        ) {
            return;
        }
        if (this.feesFetchInFlight) return;
        this.feesFetchedAt = blockNumber;
        void this.updateFees();
    }

    /**
     * Fetches the fees. With eip1559 asked for, the latest block is read for the
     * base fee while no block has given one, a block tells whether the chain has a
     * base fee at all, null for none, and a chain with none gets legacy
     * transactions. The fee history then gives the tip, and the base fee too while
     * the block read failed, unless it gives 0 for it, which is what it gives for a
     * chain without one. The tip takes priorityFeeMultiplier at its fetch. A chain
     * with a base fee gets only its L1 gas price fetched besides, otherwise the gas
     * price of the legacy mode is fetched as before. A fee history that fails is
     * counted, see feeFetchFailures, and the tip then comes off the node's gas price
     * instead, the gas price above the base fee, with the same multiplier, so a
     * failing fee history never leaves the tip at nothing. While the base fee or
     * the tip is not known, the legacy gas price stands in, see isEip1559. The L1
     * gas price of an L2 chain is read alongside all of that, it depends on none
     * of it. Any other failed fetch keeps the previous values. A fetch that does
     * not settle within FEE_FETCH_TIMEOUT, such as one on a ws rpc that never
     * opens, frees the guard of onBlock, it applies its fees if it settles later
     */
    async updateFees() {
        if (this.feesFetchInFlight) return;
        this.feesFetchInFlight = true;
        const fetchFees = async () => {
            // the L1 gas price goes out first and is taken last, so it overlaps the rest
            const l1Promise = getL1GasPrice(this.client, this.chainConfig);
            let feeHistoryFailed = false;
            if (this.txType === TxType.Eip1559 && this.baseFeePerGas === undefined) {
                const block = await this.client.getBlock().catch(() => undefined);
                this.setBaseFee(block?.baseFeePerGas);
            }
            if (this.txType === TxType.Eip1559 && this.baseFeePerGas !== null) {
                const fees = await getFeeHistoryFees(
                    this.client,
                    this.gasFeeBlockInterval,
                    this.priorityFeePercentiles,
                    this.feeHistoryBlockTag,
                );
                if (fees.isOk()) {
                    this.feeFetchFailures = 0;
                    this.lastFeeFetchError = undefined;
                    if (fees.value.tip !== undefined) {
                        this.priorityFee = this.scaleTip(fees.value.tip);
                        this.tipKnown = true;
                    }
                    // a base fee of 0 is not taken off the fee history, a chain without
                    // one gives that, a block read tells them apart, see above
                    if (this.baseFeePerGas === undefined && fees.value.nextBaseFee) {
                        this.baseFeePerGas = fees.value.nextBaseFee;
                    }
                } else {
                    feeHistoryFailed = true;
                    this.feeFetchFailures++;
                    this.lastFeeFetchError = describeError(fees.error);
                }
            }
            const hasBaseFee =
                this.txType === TxType.Eip1559 && typeof this.baseFeePerGas === "bigint";
            if (hasBaseFee && feeHistoryFailed) {
                // the node's gas price is the base fee plus the tip it suggests
                const gasPrice = await getChainGasPrice(this.client);
                if (gasPrice.isOk()) {
                    const tip = gasPrice.value - (this.baseFeePerGas as bigint);
                    this.priorityFee = this.scaleTip(tip > 0n ? tip : 0n);
                    this.tipKnown = true;
                }
            }
            if (this.isEip1559) {
                this.refreshGasPrice();
            } else if (!(hasBaseFee && feeHistoryFailed)) {
                // the legacy mode, or an eip1559 chain whose base fee or tip is not known
                // yet, the legacy gas price stands in, it holds the node's own tip. Not
                // after the tip off the node's gas price failed just above, that is the
                // same read, before the first tip it leaves the previous gas price
                const gasPrice = await getChainGasPrice(this.client);
                if (gasPrice.isOk()) this.gasPrice = gasPrice.value;
            }
            const l1GasPrice = await l1Promise;
            if (l1GasPrice.isOk()) this.l1GasPrice = l1GasPrice.value;
        };
        try {
            await promiseTimeout(fetchFees(), FEE_FETCH_TIMEOUT, "fee fetch timed out");
        } catch {
            // the timeout, the fetch itself does not throw
        } finally {
            this.feesFetchInFlight = false;
        }
    }

    /** Sets the gas price to the base fee plus the tip in eip1559 mode, a noop otherwise */
    private refreshGasPrice() {
        if (this.isEip1559) this.gasPrice = (this.baseFeePerGas as bigint) + this.priorityFee;
    }

    /**
     * Initializes a new instance of the GasManager with its first fees, see
     * updateFees. The fees are fetched again on new blocks after, see onBlock, or
     * on a timer, see watchGasPrice
     * @param config - Configuration for the gas manager
     */
    static async init(config: GasManagerConfig) {
        const manager = new GasManager(config);
        await manager.updateFees();
        return manager;
    }

    /** Whether the gas price watcher is active */
    get isWatchingGasPrice(): boolean {
        return this.gasPriceWatcher !== undefined;
    }

    /**
     * Watches gas price during runtime by reading it periodically
     * @param interval - Interval to update gas price in milliseconds, default is 20 seconds
     */
    watchGasPrice(interval = 20_000) {
        if (this.isWatchingGasPrice) return;
        this.gasPriceWatcher = setInterval(async () => {
            const { gasPrice, l1GasPrice } = await getGasPrice(this.client, this.chainConfig);
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

/**
 * A short text of a fetch error for a span, viem's short message when it has
 * one, the message otherwise
 * @param error - The error
 */
function describeError(error: unknown): string {
    if (error instanceof Error)
        return (error as { shortMessage?: string }).shortMessage ?? error.message;
    return String(error);
}
