import { CounterpartySource, OrderbooksPairMap, Pair } from "./types";

/**
 * Adds the given order pair to the given pair map
 * @param pairMap - The pair map to add the pair to
 * @param orderbook - The orderbook address
 * @param orderHash - The hash of the order
 * @param output - The output token address
 * @param input - The input token address
 * @param pair - The order pair object
 */
export function addToPairMap(
    pairMap: OrderbooksPairMap,
    orderbook: string,
    orderHash: string,
    output: string,
    input: string,
    pair: Pair,
) {
    const map = pairMap.get(orderbook);
    if (map) {
        const innerMap = map.get(output);
        if (!innerMap) {
            map.set(output, new Map([[input, new Map([[orderHash, pair]])]]));
        } else {
            const list = innerMap.get(input);
            if (!list) {
                innerMap.set(input, new Map([[orderHash, pair]]));
            } else {
                list.set(orderHash, pair);
            }
        }
    } else {
        pairMap.set(
            orderbook,
            new Map([[output, new Map([[input, new Map([[orderHash, pair]])]])]]),
        );
    }
}

/**
 * Removes the order from the given pair map
 * @param pairMap - The pair map to remove the pair from
 * @param orderbook - The orderbook address
 * @param orderHash - The hash of the order
 * @param output - The output token address
 * @param input - The input token address
 */
export function removeFromPairMap(
    pairMap: OrderbooksPairMap,
    orderbook: string,
    orderHash: string,
    output: string,
    input: string,
) {
    const map = pairMap.get(orderbook.toLowerCase());
    if (map) {
        const innerMap = map.get(output);
        if (innerMap) {
            const list = innerMap.get(input);
            if (list) {
                // remove the order from the list
                list.delete(orderHash);
                if (list.size === 0) {
                    innerMap.delete(input);
                }
                if (innerMap.size === 0) {
                    map.delete(output);
                }
            }
        }
    }
}

/**
 * Gets descending sorted list of pairs from the given pairMap by their ratios
 * @param pairMap - The pair map to get pairs from
 * @param orderbook - The orderbook address to get pairs from
 * @param output - The output token address to get pairs from
 * @param input - The input token address to get pairs from
 * @param counterpartySource - Determines the type of counterparty orders source to return
 */
export function getSortedPairList<
    counterpartySource extends CounterpartySource = CounterpartySource.IntraOrderbook,
>(
    pairMap: OrderbooksPairMap,
    orderbook: string,
    output: string,
    input: string,
    counterpartySource: CounterpartySource,
): counterpartySource extends CounterpartySource.IntraOrderbook ? Pair[] : Pair[][] {
    const empty = new Map<string, Pair>();
    if (counterpartySource === CounterpartySource.IntraOrderbook) {
        // get orders as array and set them back as new sorted map
        const arr = Array.from(pairMap.get(orderbook)?.get(output)?.get(input) ?? empty).sort(
            sortPairList,
        );
        pairMap.get(orderbook)?.get(output)?.set(input, new Map(arr));

        // return the sorted orders
        return Array.from(
            pairMap.get(orderbook)?.get(output)?.get(input)?.values() ?? empty.values(),
        ) as counterpartySource extends CounterpartySource.IntraOrderbook ? Pair[] : Pair[][];
    } else {
        const counterpartyOrders: Pair[][] = [];
        pairMap.forEach((innerMap, ob) => {
            // skip same orderbook
            if (ob === orderbook) return;

            // get orders as array and set them back as new sorted map
            const arr = Array.from(innerMap.get(output)?.get(input) ?? empty).sort(sortPairList);
            innerMap.get(output)?.set(input, new Map(arr));

            // push the sorted orders to the result
            counterpartyOrders.push(
                Array.from(innerMap.get(output)?.get(input)?.values() ?? empty.values()),
            );
        });
        return counterpartyOrders as counterpartySource extends CounterpartySource.IntraOrderbook
            ? Pair[]
            : Pair[][];
    }
}

/**
 * Sorts a pair list in ascending order by their quotes ratio and descending maxoutput
 * @param a - The first pair to compare
 * @param b - The second pair to compare
 */
export function sortPairList(a: [string, Pair], b: [string, Pair]): number {
    if (!a[1].takeOrder.quote && !b[1].takeOrder.quote) return 0;
    if (!a[1].takeOrder.quote) return 1;
    if (!b[1].takeOrder.quote) return -1;
    if (a[1].takeOrder.quote.ratio < b[1].takeOrder.quote.ratio) {
        return -1;
    } else if (a[1].takeOrder.quote.ratio > b[1].takeOrder.quote.ratio) {
        return 1;
    } else {
        // if ratios are equal, sort by maxoutput
        if (a[1].takeOrder.quote.maxOutput < b[1].takeOrder.quote.maxOutput) {
            return 1;
        } else if (a[1].takeOrder.quote.maxOutput > b[1].takeOrder.quote.maxOutput) {
            return -1;
        } else {
            return 0;
        }
    }
}
