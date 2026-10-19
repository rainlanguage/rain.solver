import { clearChanges, decodeOrderbookLog } from "./decode";
import { passesFilters, SgFilter } from "../subgraph/filter";
import {
    Hex,
    RawLog,
    MetaEvent,
    AfterClearLog,
    ClearStartLog,
    AddOrderEvent,
    OrderbookEvent,
} from "./types";

/** What the ingestor hands out, the event and whether it was undone by a reorg */
export type IngestedEvent = {
    event: OrderbookEvent;
    /** True when the log was removed by a reorg, the event is to be reversed */
    reverted: boolean;
};

/** A listener for the events of live mode */
export type EventListener = (ingested: IngestedEvent) => void;

/**
 * The key an add and its meta meet at. The orderbook emits the meta of an
 * order straight after its add with nothing in between, so the meta sits at
 * the add's log index plus one, and it carries the order hash, so both the
 * hash and the index are checked
 */
function addKey(tx: string, orderHash: Hex, addLogIndex: number): string {
    return `${tx}:${orderHash}:${addLogIndex}`;
}

/**
 * Takes the raw logs of one orderbook as they come and turns them into events
 * in chain order. It drops a log seen before, pairs the two halves of a clear
 * and the meta log with the add of the same transaction, and turns a log the
 * chain removed in a reorg into the reverse event. In buffer mode it keeps the
 * events, so the ones above a snapshot block can be replayed once the snapshot
 * is in, in live mode it hands every event to the listener as it comes.
 *
 * The orderbook logs the meta of an order after the add, in the same
 * transaction, and the oracle url of an order comes from it. In buffer mode the
 * meta lands on the buffered add. In live mode the add goes out at once, and the
 * meta goes out after it as its own event, the syncer applies it to the order.
 * A meta that comes before its add, from a range query that serves an older
 * log after the stream say, also waits for the add and lands on it.
 */
export class LogIngestor {
    /** The orderbook the logs belong to, lower cased */
    readonly orderbook: Hex;
    /** Buffer until told to go live */
    mode: "buffer" | "live" = "buffer";
    /**
     * The order filters, an add or a removal of an order they leave out is
     * dropped right after the decode, before anything downstream spends on it
     */
    readonly filters?: SgFilter;
    /** How many adds and removals the filters dropped */
    filtered = 0;
    /**
     * The adds the filters dropped, by their add key with the block for the
     * prune, so the meta that follows one is dropped too rather than kept for
     * an add that never comes
     */
    private readonly filteredAdds = new Map<string, bigint>();
    /**
     * The logs seen so far, by block, transaction hash and log index, with the
     * block for the prune, a transaction mined again after a reorg lands in a
     * new block with the same hash and often the same log index, so the block
     * is part of the key
     */
    private readonly seen = new Map<string, bigint>();
    /** The highest block seen so far, the prune of the seen logs runs off it */
    private newestBlock = 0n;
    /**
     * The block the snapshot holds at, set once the syncer applies it. A
     * removed log above it that was never seen was never applied, so it is
     * dropped, at or below it the snapshot may hold the log
     */
    snapshotBlock?: bigint;
    /**
     * The seen logs of blocks this far behind the newest are forgotten. A reorg
     * is usually 1 or 2 blocks deep. The deepest block that a read gives again
     * is in the first poll after a ws drop. That poll starts BACKFILL_LOOKBACK
     * blocks below the last ws head and reads POLL_REREAD_BLOCKS more below
     * that. This window is deeper than both together, so a log that a read
     * gives again is never taken as new
     */
    static readonly SEEN_BLOCKS = 24n;
    /** The seen logs get pruned once they count this many */
    static readonly SEEN_PRUNE_AT = 10_000;
    /** The size of the seen logs that starts the next prune, it moves up when a prune keeps many */
    private nextPruneAt = LogIngestor.SEEN_PRUNE_AT;
    /** The buffered events, sorted on drain */
    private buffer: IngestedEvent[] = [];
    /**
     * The clear halves waiting for their other half, by block, transaction hash
     * and reorg flag. A transaction can clear more than once, a multicall say, and
     * the orderbook emits nothing of its own between a clear and its after
     * clear, so the halves of one clear sit next to each other by log index and
     * pair by that, whatever order they arrive in
     */
    private readonly clearStarts = new Map<string, ClearStartLog[]>();
    private readonly afterClears = new Map<string, AfterClearLog[]>();
    /** The meta logs waiting for their add, by block, transaction hash, order hash and reorg flag */
    private readonly metas = new Map<string, MetaEvent>();
    /** The buffered adds a later meta of the same transaction may still land on */
    private readonly bufferedAdds = new Map<string, AddOrderEvent>();
    private listener: EventListener;
    /** The count of the logs that carried a known event but did not decode, since the start */
    badLogCount = 0;

    constructor(orderbook: Hex, listener: EventListener, filters?: SgFilter) {
        this.orderbook = orderbook.toLowerCase() as Hex;
        this.listener = listener;
        this.filters = filters;
    }

    /** Replaces the listener the live events go to */
    listen(listener: EventListener) {
        this.listener = listener;
    }

    /**
     * Takes one raw log. A log of another address, an unknown event, a log
     * seen before, or an add or a removal of an order the filters leave out is
     * dropped.
     */
    push(rawLog: RawLog) {
        // every hex of the log is lower cased once here, so a log served in
        // another case, or the same log served in two cases, keys the same way
        const log = normalizeLog(rawLog);
        if (log.address !== this.orderbook) return;
        const reverted = !!log.removed;
        const seenKey = (r: boolean) =>
            `${log.blockNumber}:${log.transactionHash}:${log.logIndex}:${r ? "r" : ""}`;
        const key = seenKey(reverted);
        if (this.seen.has(key)) return;
        // the removal of a log that was never seen undoes nothing, a log of a
        // block the socket missed that a reorg removed before the poll read it say
        if (
            reverted &&
            !this.seen.has(seenKey(false)) &&
            (this.snapshotBlock === undefined || log.blockNumber > this.snapshotBlock)
        ) {
            return;
        }
        this.seen.set(key, log.blockNumber);
        // a log and its removal alternate, a transaction mined again at the same
        // height after a reorg lands with the same hash and often the same log
        // index, so the removal forgets the log and the log the removal, and
        // each new turn of the two applies
        this.seen.delete(seenKey(!reverted));
        this.pruneSeen(log.blockNumber);

        // the halves of a clear and an add with its meta sit in one block of one
        // transaction, a transaction mined again after a reorg is another one
        const base = `${log.blockNumber}:${log.transactionHash}:`;
        const tx = base + (reverted ? "r" : "");
        const decoded = decodeOrderbookLog(log);
        if (decoded.isErr()) this.badLogCount++;
        const item = decoded.isOk() ? decoded.value : undefined;
        if (!item) return;

        // an order the filters leave out goes no further, its owner and hash
        // are on the event so the check costs nothing downstream
        if (item.type === "AddOrder" || item.type === "RemoveOrder") {
            const keys = {
                orderbook: this.orderbook,
                orderHash: item.orderHash,
                owner: item.order.owner,
            };
            if (!passesFilters(keys, this.filters)) {
                this.filtered++;
                if (item.type === "AddOrder") {
                    const key = addKey(tx, item.orderHash, log.logIndex);
                    // its meta, whether it came first or comes next, is dropped too
                    this.metas.delete(key);
                    this.filteredAdds.set(key, log.blockNumber);
                }
                return;
            }
        }

        switch (item.type) {
            case "ClearStart": {
                // in buffer mode the halves pair at the drain, see pairClears
                if (this.mode === "buffer") {
                    bufferHalf(this.clearStarts, base, item, reverted);
                    return;
                }
                // the after clear of this start is the nearest one above it
                const after = takeNearest(
                    this.afterClears,
                    tx,
                    (candidate) => candidate.ref.logIndex > item.ref.logIndex,
                    (a, b) => a.ref.logIndex - b.ref.logIndex,
                );
                if (!after) {
                    push(this.clearStarts, tx, item);
                    return;
                }
                this.emitClear(item, after, reverted);
                return;
            }
            case "AfterClear": {
                if (this.mode === "buffer") {
                    bufferHalf(this.afterClears, base, item, reverted);
                    return;
                }
                // the start of this after clear is the nearest one below it
                const start = takeNearest(
                    this.clearStarts,
                    tx,
                    (candidate) => candidate.ref.logIndex < item.ref.logIndex,
                    (a, b) => b.ref.logIndex - a.ref.logIndex,
                );
                if (!start) {
                    push(this.afterClears, tx, item);
                    return;
                }
                this.emitClear(start, item, reverted);
                return;
            }
            case "Meta": {
                // the add of this meta is the one right below it
                const key = addKey(tx, item.orderHash, item.ref.logIndex - 1);
                if (this.filteredAdds.delete(key)) return;
                const bufferedAdd = this.bufferedAdds.get(key);
                if (bufferedAdd) {
                    bufferedAdd.meta = item.meta;
                    this.bufferedAdds.delete(key);
                    return;
                }
                // the add went out already, or it comes later, so the meta goes
                // out as an update, and it also waits for an add that comes later,
                // the syncer applies a meta the order has already as a no-op, the
                // prune of the seen logs forgets a meta whose add never comes
                this.metas.set(key, item);
                this.out({ event: item, reverted });
                return;
            }
            case "AddOrder": {
                const key = addKey(tx, item.orderHash, item.ref.logIndex);
                const meta = this.metas.get(key);
                if (meta) {
                    this.metas.delete(key);
                    item.meta = meta.meta;
                } else if (this.mode === "buffer") {
                    // the add waits in the buffer, a meta that follows lands on it there
                    this.bufferedAdds.set(key, item);
                }
                this.out({ event: item, reverted });
                return;
            }
            default:
                this.out({ event: item, reverted });
        }
    }

    /**
     * Hands out the buffered events above the given block and empties the
     * buffer, the events at or below the block are dropped as the snapshot
     * holds them already. A log and its removal that are both in the buffer
     * cancel out, and a second copy of a log or of a removal, one that the seen
     * logs forgot after a prune, is dropped. The removals left undo events
     * applied before the buffer, so they go first, newest first, and the other
     * events follow in chain order
     * @param afterBlock - (optional) The block the events must be above, every
     * buffered event when it is not given
     */
    drain(afterBlock?: bigint): IngestedEvent[] {
        this.pairClears();
        const dropped = new Set<IngestedEvent>();
        // the last turn of each log in the buffer, the log or its removal
        const last = new Map<string, IngestedEvent>();
        for (const ingested of this.buffer) {
            const { blockNumber, transactionHash, logIndex } = ingested.event.ref;
            const key = `${blockNumber}:${transactionHash}:${logIndex}`;
            const previous = last.get(key);
            if (previous?.reverted === ingested.reverted) {
                dropped.add(ingested);
                continue;
            }
            if (previous && !previous.reverted) {
                dropped.add(previous);
                dropped.add(ingested);
            }
            last.set(key, ingested);
        }
        const kept = this.buffer.filter(
            (ingested) =>
                !dropped.has(ingested) &&
                (afterBlock === undefined || ingested.event.ref.blockNumber > afterBlock),
        );
        this.buffer = [];
        this.bufferedAdds.clear();
        return [
            ...kept.filter(({ reverted }) => reverted).sort((a, b) => compare(b, a)),
            ...kept.filter(({ reverted }) => !reverted).sort(compare),
        ];
    }

    /**
     * Forgets every log and event it holds, the buffer, the seen logs and the
     * halves and metas that wait, for a syncer that starts over
     */
    reset() {
        this.buffer = [];
        this.bufferedAdds.clear();
        this.metas.clear();
        this.clearStarts.clear();
        this.afterClears.clear();
        this.seen.clear();
        this.filteredAdds.clear();
        this.newestBlock = 0n;
        this.nextPruneAt = LogIngestor.SEEN_PRUNE_AT;
    }

    /** Switches to live mode, every event from now on goes to the listener */
    goLive() {
        this.mode = "live";
    }

    /**
     * Switches back to buffer mode, every event from now on waits in the
     * buffer until the next drain, the syncer does this while the client layer
     * reads the blocks below the start of a reopened stream
     */
    goBuffer() {
        this.mode = "buffer";
    }

    /** The events in the buffer, in chain order, for a look without draining */
    get buffered(): IngestedEvent[] {
        return [...this.buffer].sort(compare);
    }

    /** How many events wait in the buffer */
    get bufferedCount(): number {
        return this.buffer.length;
    }

    /**
     * Forgets the seen logs of blocks far behind the newest, once there are
     * enough to matter. The block of the log at hand is never forgotten, an
     * old log of a long range query keeps the halves of its clear and its meta.
     *
     * Nothing is forgotten in buffer mode. A range read can still serve old
     * blocks while the stream moves the newest block on. A log of such a block
     * may have applied before the buffer began, and only its seen key stops it
     * from applying again. The clear halves also wait for the drain there, see
     * pairClears. The prune runs again once the syncer is live
     */
    private pruneSeen(blockNumber: bigint) {
        if (blockNumber > this.newestBlock) this.newestBlock = blockNumber;
        if (this.mode === "buffer") return;
        if (this.seen.size < this.nextPruneAt) return;
        let floor = this.newestBlock - LogIngestor.SEEN_BLOCKS;
        if (blockNumber < floor) floor = blockNumber;
        for (const [key, block] of this.seen) {
            if (block < floor) this.seen.delete(key);
        }
        for (const [key, block] of this.filteredAdds) {
            if (block < floor) this.filteredAdds.delete(key);
        }
        // a meta whose add never came, one below the snapshot block say, is
        // forgotten along with them
        for (const [key, meta] of this.metas) {
            if (meta.ref.blockNumber < floor) this.metas.delete(key);
        }
        // the next prune waits until the seen logs grow past twice what is left,
        // so a scan that keeps most of them does not run again on every push
        this.nextPruneAt = Math.max(LogIngestor.SEEN_PRUNE_AT, this.seen.size * 2);
        // and a clear half whose other half never came, the halves of a
        // transaction all sit in its block
        for (const halves of [this.clearStarts, this.afterClears]) {
            for (const [key, list] of halves) {
                if (!list.length || list[0].ref.blockNumber < floor) halves.delete(key);
            }
        }
    }

    /**
     * Pairs the waiting clear halves of each transaction in log index order, a
     * start with the after clear right after it among the halves, and puts
     * the clears in the buffer. In buffer mode the halves of a transaction can
     * come in any order, from the stream and from a range query, a stream that
     * opened in the middle of a transaction say, so they pair here, once all of
     * them are in. A half with no partner waits
     */
    private pairClears() {
        // the reversals first, the drain then keeps a reversal of a clear applied
        // before apart from a copy of that clear mined again in the same block
        const keys = [...new Set([...this.clearStarts.keys(), ...this.afterClears.keys()])].sort(
            (a, b) => Number(b.endsWith(":r")) - Number(a.endsWith(":r")),
        );
        for (const key of keys) {
            const halves: (ClearStartLog | AfterClearLog)[] = [
                ...(this.clearStarts.get(key) ?? []),
                ...(this.afterClears.get(key) ?? []),
            ].sort((a, b) => a.ref.logIndex - b.ref.logIndex);
            const starts: ClearStartLog[] = [];
            const afters: AfterClearLog[] = [];
            for (let i = 0; i < halves.length; i++) {
                const half = halves[i];
                const next = halves[i + 1];
                if (half.type === "ClearStart" && next?.type === "AfterClear") {
                    this.emitClear(half, next, key.endsWith(":r"));
                    i++;
                } else if (half.type === "ClearStart") {
                    starts.push(half);
                } else {
                    afters.push(half as AfterClearLog);
                }
            }
            if (starts.length) this.clearStarts.set(key, starts);
            else this.clearStarts.delete(key);
            if (afters.length) this.afterClears.set(key, afters);
            else this.afterClears.delete(key);
        }
    }

    /** Builds the clear event of the two halves and hands it out */
    private emitClear(start: ClearStartLog, after: AfterClearLog, reverted: boolean) {
        this.out({
            event: {
                type: "Clear",
                // the after clear log is the later of the two, the event sits where it does
                ref: after.ref,
                orderbook: start.orderbook,
                changes: clearChanges(start, after),
            },
            reverted,
        });
    }

    private out(ingested: IngestedEvent) {
        if (this.mode === "buffer") {
            this.buffer.push(ingested);
        } else {
            this.listener(ingested);
        }
    }
}

/** A copy of the log with every hex string lower cased */
export function normalizeLog(log: RawLog): RawLog {
    return {
        ...log,
        address: log.address.toLowerCase() as Hex,
        transactionHash: log.transactionHash.toLowerCase() as Hex,
        topics: log.topics.map((topic) => topic.toLowerCase() as Hex),
        data: log.data.toLowerCase() as Hex,
    };
}

/**
 * Keeps a clear half of buffer mode until the drain pairs it. A removed half
 * undoes its waiting original of the same block, transaction and log index,
 * that clear was never applied, a removed half with no waiting original waits
 * to pair into the reversal of a clear applied before
 * @param halves - The waiting halves of the kind
 * @param base - The key of the block and the transaction, with no reorg flag
 * @param half - The half
 * @param reverted - Whether the log of the half was removed
 */
function bufferHalf<T extends ClearStartLog | AfterClearLog>(
    halves: Map<string, T[]>,
    base: string,
    half: T,
    reverted: boolean,
) {
    if (reverted) {
        const waiting = halves.get(base);
        const index = waiting?.findIndex((other) => other.ref.logIndex === half.ref.logIndex);
        if (waiting && index !== undefined && index >= 0) {
            waiting.splice(index, 1);
            if (!waiting.length) halves.delete(base);
            return;
        }
    }
    push(halves, base + (reverted ? "r" : ""), half);
}

/** Appends an item to the list under the key, starting the list when there is none */
function push<T>(lists: Map<string, T[]>, key: string, item: T) {
    const list = lists.get(key);
    if (list) list.push(item);
    else lists.set(key, [item]);
}

/**
 * Takes the item out of the list that the pick allows and the order ranks
 * first, undefined when there is none
 */
function takeNearest<T>(
    lists: Map<string, T[]>,
    key: string,
    pick: (item: T) => boolean,
    order: (a: T, b: T) => number,
): T | undefined {
    const list = lists.get(key);
    if (!list) return undefined;
    const candidates = list.filter(pick).sort(order);
    const nearest = candidates[0];
    if (nearest !== undefined) list.splice(list.indexOf(nearest), 1);
    // a list taken empty leaves no key behind
    if (!list.length) lists.delete(key);
    return nearest;
}

/** Chain order, by block then by log index */
export function compare(a: IngestedEvent, b: IngestedEvent): number {
    const byBlock = a.event.ref.blockNumber - b.event.ref.blockNumber;
    if (byBlock !== 0n) return byBlock < 0n ? -1 : 1;
    return a.event.ref.logIndex - b.event.ref.logIndex;
}
