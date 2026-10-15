import { ABI } from "../common";
import { Hex, RawLog } from "./types";
import { hexToBigInt, hexToNumber, PublicClient } from "viem";

/** The raw eth_subscribe interface of the viem ws transport */
type WsTransportSubscribe = {
    subscribe(args: {
        params: unknown[];
        onData: (data: any) => void;
        onError?: (error: any) => void;
    }): Promise<{ unsubscribe: () => Promise<unknown> }>;
};

/** The blocks one range query asks for at most, providers cap the range */
export const LOGS_RANGE_CHUNK = 2_000n;

/** Matches a non-empty hex quantity string */
const HEX_QUANTITY_PATTERN = /^0x[0-9a-f]+$/i;

/**
 * The events the sync reads, of every orderbook version, the subscription and
 * the range queries filter on them. The v5 and v6 orderbooks emit the same
 * events, the v4 ones have other names and shapes
 */
export const SYNC_EVENTS = [
    ...ABI.Orderbook.V4.Primary.OrderbookSyncEvents,
    ...ABI.Orderbook.V6.Primary.OrderbookSyncEvents,
] as const;

/**
 * The topics filter of the subscription, the selectors of the sync events as
 * one nested list, any of them at the first topic. A flat list would mean one
 * selector per topic position, all at once, and match nothing
 */
export const SYNC_TOPICS = [
    [
        ...ABI.Orderbook.V4.Primary.OrderbookSyncEventTopics,
        ...ABI.Orderbook.V6.Primary.OrderbookSyncEventTopics,
    ],
] as const;

/**
 * Turns a log as a node serves it, over a subscription or from a range query,
 * into the raw log the module reads. A subscription serves the numbers as hex
 * strings, viem's range query as a bigint and a number, both are taken. A
 * pending log, one with no block yet, resolves to undefined
 * @param log - The log as served
 */
export function toRawLog(log: any): RawLog | undefined {
    if (!log || typeof log !== "object") return undefined;
    const blockNumber = quantity(log.blockNumber);
    const logIndex = quantity(log.logIndex);
    if (blockNumber === undefined || logIndex === undefined) return undefined;
    if (
        typeof log.address !== "string" ||
        typeof log.transactionHash !== "string" ||
        typeof log.data !== "string" ||
        !Array.isArray(log.topics)
    ) {
        return undefined;
    }
    return {
        address: log.address as Hex,
        topics: log.topics as Hex[],
        data: log.data as Hex,
        blockNumber,
        ...(typeof log.blockHash === "string"
            ? { blockHash: log.blockHash.toLowerCase() as Hex }
            : {}),
        transactionHash: log.transactionHash as Hex,
        logIndex: Number(logIndex),
        removed: !!log.removed,
    };
}

/** A block number or a log index, from a hex string, a bigint or a number */
function quantity(value: unknown): bigint | undefined {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && HEX_QUANTITY_PATTERN.test(value)) {
        return hexToBigInt(value as Hex);
    }
    return undefined;
}

/**
 * Subscribes to the logs of the given orderbooks over the ws client, one
 * subscription for all of them, the sync events
 * only, every log the node serves goes to the given callback as a raw log, a
 * removed log too, the reorg flag on it. The subscription is the raw eth_subscribe, since viem's
 * event watchers drop the reorg flag on the way. With flashblocks the
 * subscription is pendingLogs instead, the logs of the flashblocks as they
 * come, chunks of the block being built, the same logs the sealed block
 * carries a moment later, so nothing downstream tells them apart, only the
 * block hash is zero on them. A flashblock that is dropped with no removed
 * log for it leaves its logs applied, which is rare. An errored subscription is
 * reported to onError, maybe more than once for one failure until the caller
 * unsubscribes, and left to the caller to open again, the ws client does not
 * reconnect by itself, see SharedState.openWsSocket, and nothing
 * replays the subscriptions
 * @param wsClient - The ws client to subscribe through
 * @param orderbooks - The orderbook addresses
 * @param onLog - Called with every log
 * @param onError - Called when the subscription errors
 * @param flashblocks - Whether to take the logs of the flashblocks, default is false
 * @param onOpen - Called once the node acknowledged the subscription, every log from then on is served
 * @returns A function that unsubscribes
 */
export function subscribeToOrderbookLogs(
    wsClient: PublicClient,
    orderbooks: Hex[],
    onLog: (log: RawLog) => void,
    onError: (error: any) => void,
    flashblocks = false,
    onOpen?: () => void,
): () => void {
    let active = true;
    let unsubscribe: () => unknown = () => (active = false);
    (async () => {
        try {
            const transport = wsClient.transport as unknown as WsTransportSubscribe;
            const { unsubscribe: unsubscribe_ } = await transport.subscribe({
                params: [
                    flashblocks ? "pendingLogs" : "logs",
                    { address: orderbooks, topics: SYNC_TOPICS },
                ],
                onData(data: any) {
                    if (!active) return;
                    const log = toRawLog(data?.result);
                    if (log) onLog(log);
                },
                onError(error: any) {
                    if (active) onError(error);
                },
            });
            unsubscribe = unsubscribe_;
            if (!active) unsubscribe();
            else onOpen?.();
        } catch (err) {
            if (active) onError(err);
        }
    })();
    return () => {
        active = false;
        unsubscribe();
    };
}

/**
 * Fetches the logs of the given orderbooks over a block range with range
 * queries, one query per chunk for all of them, the sync events only, in
 * chunks the providers accept, and hands them over in chain order. The http
 * poll reads the new blocks with it, also while it stands in for a dropped ws
 * subscription, and the start reads the gap below its buffer. The range
 * is inclusive on both ends
 * @param client - The client to query through
 * @param orderbooks - The orderbook addresses
 * @param fromBlock - The first block of the range
 * @param toBlock - The last block of the range
 * @param onLog - Called with every log
 * @returns How many logs were handed over
 */
export async function fetchOrderbookLogs(
    client: PublicClient,
    orderbooks: Hex[],
    fromBlock: bigint,
    toBlock: bigint,
    onLog: (log: RawLog) => void,
): Promise<number> {
    let count = 0;
    for (let start = fromBlock; start <= toBlock; start += LOGS_RANGE_CHUNK) {
        const end =
            start + LOGS_RANGE_CHUNK - 1n < toBlock ? start + LOGS_RANGE_CHUNK - 1n : toBlock;
        const logs = await client.getLogs({
            address: orderbooks,
            events: SYNC_EVENTS,
            fromBlock: start,
            toBlock: end,
        });
        for (const log of logs) {
            const raw = toRawLog(log);
            if (!raw) continue;
            onLog(raw);
            count++;
        }
    }
    return count;
}

/** The hex quantity helper, for the tests */
export { hexToNumber };
