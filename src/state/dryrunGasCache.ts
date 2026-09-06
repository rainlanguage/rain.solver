import { Pair } from "../order";

/** Represents the accumulated dryrun gas samples of an order pair */
export type DryrunGasCacheEntry = {
    /** The sum of all gas limit samples */
    gasSum: bigint;
    /** The sum of all L1 cost samples, 0 on non special L2 chains */
    l1CostSum: bigint;
    /** The number of all samples, init and final dryruns */
    count: number;
    /** The number of init dryrun samples */
    initCount: number;
};

/** Represents the average dryrun gas values of an order pair */
export type DryrunGasCacheValue = {
    /** The average gas limit */
    gas: bigint;
    /** The average L1 cost, 0 on non special L2 chains */
    l1Cost: bigint;
};

/**
 * Keeps an average of the dryrun gas limit per order pair for sushi route processor trades,
 * so once enough init dryrun samples are in for a pair, the init dryrun of its later simulations can be skipped and
 * the cached average is used in its place to calculate the min expected bounty for the
 * final dryrun, the average takes in the first init dryruns up to the minimum sample count
 * and every final dryrun after that, the whole cache resets periodically at the configured
 * interval, so the averages follow the chain state over time
 */
export class DryrunGasCache {
    /** The number of init dryrun samples required before the cached average gets used */
    static readonly MIN_INIT_SAMPLES = 5;

    /** The interval (in ms) at which the whole cache resets, no reset if not greater than 0 */
    readonly resetInterval: number;
    /** The cached samples keyed by order pair */
    readonly entries: Map<string, DryrunGasCacheEntry> = new Map();
    /** The timestamp of the last reset */
    lastReset = Date.now();

    constructor(resetInterval: number) {
        this.resetInterval = resetInterval;
    }

    /** Builds the cache key of the given order pair */
    static key(pair: Pair): string {
        return `${pair.orderbook}-${pair.takeOrder.id}-${pair.sellToken}-${pair.buyToken}`.toLowerCase();
    }

    /**
     * Gets the cached average for the given key, undefined if the key has
     * not yet collected enough init dryrun samples
     * @param key - The order pair key
     */
    get(key: string): DryrunGasCacheValue | undefined {
        this.maybeReset();
        const entry = this.entries.get(key);
        if (!entry || entry.initCount < DryrunGasCache.MIN_INIT_SAMPLES) {
            return undefined;
        }
        const count = BigInt(entry.count);
        return {
            gas: entry.gasSum / count,
            l1Cost: entry.l1CostSum / count,
        };
    }

    /**
     * Records an init dryrun sample for the given key, ignored once the
     * key has collected the minimum init samples
     * @param key - The order pair key
     * @param gas - The dryrun gas limit
     * @param l1Cost - The dryrun L1 cost
     */
    recordInit(key: string, gas: bigint, l1Cost: bigint) {
        this.maybeReset();
        const entry = this.getOrCreate(key);
        if (entry.initCount >= DryrunGasCache.MIN_INIT_SAMPLES) return;
        entry.initCount++;
        this.add(entry, gas, l1Cost);
    }

    /**
     * Records a final dryrun sample for the given key
     * @param key - The order pair key
     * @param gas - The dryrun gas limit
     * @param l1Cost - The dryrun L1 cost
     */
    recordFinal(key: string, gas: bigint, l1Cost: bigint) {
        this.maybeReset();
        this.add(this.getOrCreate(key), gas, l1Cost);
    }

    /** Clears all cached samples */
    clear() {
        this.entries.clear();
        this.lastReset = Date.now();
    }

    private getOrCreate(key: string): DryrunGasCacheEntry {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { gasSum: 0n, l1CostSum: 0n, count: 0, initCount: 0 };
            this.entries.set(key, entry);
        }
        return entry;
    }

    private add(entry: DryrunGasCacheEntry, gas: bigint, l1Cost: bigint) {
        entry.gasSum += gas;
        entry.l1CostSum += l1Cost;
        entry.count++;
    }

    private maybeReset() {
        if (this.resetInterval > 0 && Date.now() - this.lastReset >= this.resetInterval) {
            this.clear();
        }
    }
}
