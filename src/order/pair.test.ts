import { CounterpartySource, OrderbooksPairMap, Pair } from "./types";
import { addToPairMap, removeFromPairMap, getSortedPairList, sortPairList } from "./pair";
import { describe, it, expect, beforeEach } from "vitest";

describe("Test add/remove to pairMap functions", () => {
    const orderbook1 = "0xorderbook1";
    const orderbook2 = "0xorderbook2";
    const tkn1 = "0xtoken1";
    const tkn2 = "0xtoken2";
    const tkn3 = "0xtoken3";
    const tkn4 = "0xtoken4";
    const hash1 = "0xhash1";
    const hash2 = "0xhash2";
    const hash3 = "0xhash3";

    let pairMap: OrderbooksPairMap = new Map();

    const getPair = (orderbook: string, hash: string, output: string, input: string) =>
        ({
            orderbook,
            buyToken: input,
            sellToken: output,
            takeOrder: { id: hash },
        }) as any;

    beforeEach(() => {
        pairMap = new Map();
    });

    describe("Test addToPairMap funtion", () => {
        it("should add pair to empty pair map", async () => {
            const pair = getPair(orderbook1, hash1, tkn1, tkn2);

            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pair);
            const map = pairMap.get(orderbook1);
            expect(map).toBeDefined();

            const outputMap = map!.get(tkn1);
            expect(outputMap).toBeDefined();

            const pairList = outputMap!.get(tkn2);
            expect(pairList).toBeDefined();
            expect(pairList?.size).toBe(1);
            expect(pairList!.get(hash1)).toBe(pair);
        });

        it("should add pair to existing orderbook map", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn3, tkn4);

            // add first pair
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, existingPair);
            const map = pairMap.get(orderbook1);
            expect(map).toBeDefined();

            const outputMap = map!.get(tkn1);
            expect(outputMap).toBeDefined();

            const pairList = outputMap!.get(tkn2);
            expect(pairList).toBeDefined();
            expect(pairList?.size).toBe(1);
            expect(pairList!.get(hash1)).toBe(existingPair);

            // add second pair
            addToPairMap(pairMap, orderbook1, hash2, tkn3, tkn4, newPair);
            const map2 = pairMap.get(orderbook1);
            expect(map2).toBeDefined();

            const outputMap2 = map2!.get(tkn3);
            expect(outputMap2).toBeDefined();

            const pairList2 = outputMap2!.get(tkn4);
            expect(pairList2).toBeDefined();
            expect(pairList2?.size).toBe(1);
            expect(pairList2!.get(hash2)).toBe(newPair);
        });

        it("should add pair to existing output token map", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn1, tkn3);

            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, existingPair);
            addToPairMap(pairMap, orderbook1, hash2, tkn1, tkn3, newPair);

            const map = pairMap.get(orderbook1);
            expect(map).toBeDefined();

            const outputMap = map!.get(tkn1);
            expect(outputMap).toBeDefined();
            expect(outputMap!.size).toBe(2);
        });

        it("should add pair to existing buy token list", async () => {
            const existingPair = getPair(orderbook1, hash1, tkn1, tkn2);
            const newPair = getPair(orderbook1, hash2, tkn1, tkn2);

            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, existingPair);
            addToPairMap(pairMap, orderbook1, hash2, tkn1, tkn2, newPair);
            const map = pairMap.get(orderbook1);
            expect(map).toBeDefined();

            const outputMap = map!.get(tkn1);
            expect(outputMap).toBeDefined();
            expect(outputMap!.size).toBe(1);
            const pairList = outputMap!.get(tkn2);
            expect(pairList).toBeDefined();
            expect(pairList?.size).toBe(2);
        });

        it("should handle different orderbooks independently", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook2, hash1, tkn1, tkn2);
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pairs1);
            addToPairMap(pairMap, orderbook2, hash1, tkn1, tkn2, pairs2);

            expect(pairMap.size).toBe(2);
            expect(pairMap.get(orderbook1)).toBeDefined();
            expect(pairMap.get(orderbook2)).toBeDefined();

            // check that each orderbook has its own pairs
            expect(pairMap.get(orderbook1)!.get(tkn1)).toBeDefined();
            expect(pairMap.get(orderbook2)!.get(tkn1)).toBeDefined();
        });
    });

    describe("Test deleteFromPairMap function", () => {
        it("should delete pair from pair map", async () => {
            const pairs = getPair(orderbook1, hash1, tkn1, tkn2);

            // add pair first
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pairs);

            // verify pair exists
            const mapBefore = pairMap.get(orderbook1);
            expect(mapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(1);

            // delete pair
            removeFromPairMap(pairMap, orderbook1, hash1, tkn1, tkn2);

            // verify pair is deleted
            const mapAfter = pairMap.get(orderbook1);
            expect(mapAfter?.get(tkn1)?.get(tkn2)).toBeUndefined();
            expect(mapAfter?.get(tkn1)).toBeUndefined();
            expect(mapAfter?.size).toBe(0);
        });

        it("should only remove specific order from list when multiple orders exist for same pair", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook1, hash2, tkn1, tkn2);

            // add two pairs with same tokens but different order hashes
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pairs1);
            addToPairMap(pairMap, orderbook1, hash2, tkn1, tkn2, pairs2);

            // verify both pairs exist
            const mapBefore = pairMap.get(orderbook1);
            expect(mapBefore?.get(tkn1)?.get(tkn2)).toHaveLength(2);

            // delete only the first order
            removeFromPairMap(pairMap, orderbook1, hash1, tkn1, tkn2);

            // verify only one pair remains
            const mapAfter = pairMap.get(orderbook1);
            const remainingPairs = mapAfter?.get(tkn1)?.get(tkn2);
            expect(remainingPairs?.size).toBe(1);
            expect(remainingPairs?.get(hash2)).toBeDefined();
        });

        it("should not affect other orderbooks when deleting from one", async () => {
            const pairs1 = getPair(orderbook1, hash1, tkn1, tkn2);
            const pairs2 = getPair(orderbook2, hash2, tkn1, tkn2);

            // add pairs to both orderbooks
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pairs1);
            addToPairMap(pairMap, orderbook2, hash2, tkn1, tkn2, pairs2);

            // verify both orderbooks have pairs
            expect(pairMap.get(orderbook1)?.get(tkn1)?.get(tkn2)).toHaveLength(1);
            expect(pairMap.get(orderbook2)?.get(tkn1)?.get(tkn2)).toHaveLength(1);

            // delete from orderbook1 only
            removeFromPairMap(pairMap, orderbook1, hash1, tkn1, tkn2);

            // verify orderbook1 is empty but orderbook2 still has pairs
            expect(pairMap.get(orderbook1)?.size).toBe(0);
            expect(pairMap.get(orderbook2)?.get(tkn1)?.get(tkn2)).toHaveLength(1);
        });

        it("should handle deletion from non-existent orderbook gracefully", async () => {
            // Should not throw error when deleting from non-existent orderbook
            expect(() => {
                removeFromPairMap(pairMap, "0xnonexistent", hash1, tkn1, tkn2);
            }).not.toThrow();
        });

        it("should handle deletion of non-existent order gracefully", async () => {
            const pair = getPair(orderbook1, hash1, tkn1, tkn2);

            // add pair
            addToPairMap(pairMap, orderbook1, hash1, tkn1, tkn2, pair);

            // Try to delete non-existent order
            removeFromPairMap(pairMap, orderbook1, hash2, tkn1, tkn2);

            // verify original pair still exists
            const map = pairMap.get(orderbook1);
            expect(map?.get(tkn1)?.get(tkn2)).toHaveLength(1);
            expect(map?.get(tkn1)?.get(tkn2)?.get(hash1)?.takeOrder.id).toBe(hash1);
        });

        it("should handle complex deletion scenario with mixed pairs", async () => {
            const pairs = [
                getPair(orderbook1, hash1, tkn1, tkn2),
                getPair(orderbook1, hash2, tkn1, tkn2), // Same pair, different order
                getPair(orderbook1, hash1, tkn1, tkn3), // Same output, different input
                getPair(orderbook1, hash3, tkn2, tkn1), // different output-input combination
            ];

            // add all pairs
            for (const pair of pairs) {
                addToPairMap(
                    pairMap,
                    pair.orderbook,
                    pair.takeOrder.id,
                    pair.sellToken,
                    pair.buyToken,
                    pair,
                );
            }

            // verify initial state
            const mapBefore = pairMap.get(orderbook1);
            expect(mapBefore?.get(tkn1)?.get(tkn2)?.size).toBe(2); // hash1 and hash2
            expect(mapBefore?.get(tkn1)?.get(tkn3)?.size).toBe(1); // hash1
            expect(mapBefore?.get(tkn2)?.get(tkn1)?.size).toBe(1); // hash3

            // delete hash1 order (should affect tkn1->tkn2 and tkn1->tkn3)
            removeFromPairMap(pairMap, orderbook1, hash1, tkn1, tkn2);
            removeFromPairMap(pairMap, orderbook1, hash1, tkn1, tkn3);

            // verify final state
            const mapAfter = pairMap.get(orderbook1);
            expect(mapAfter?.get(tkn1)?.get(tkn2)).toHaveLength(1); // Only hash2 remains
            expect(mapAfter?.get(tkn1)?.get(tkn2)?.get(hash2)?.takeOrder.id).toBe(hash2);
            expect(mapAfter?.get(tkn1)?.get(tkn3)).toBeUndefined(); // hash1 removed, list deleted
            expect(mapAfter?.get(tkn2)?.get(tkn1)).toHaveLength(1); // hash3 unaffected
            expect(mapAfter?.get(tkn2)?.get(tkn1)?.get(hash3)?.takeOrder.id).toBe(hash3);
        });
    });
});

describe("Test getSortedPairList function", () => {
    let pairMap: OrderbooksPairMap;
    const orderbook1 = "0xorderbook1";
    const orderbook2 = "0xorderbook2";
    const orderbook3 = "0xorderbook3";
    const outputToken = "0xoutput";
    const inputToken = "0xinput";

    const createPair = (
        orderbook: string,
        hash: string,
        quote?: { ratio: bigint; maxOutput: bigint },
    ): Pair =>
        ({
            orderbook,
            buyToken: inputToken,
            sellToken: outputToken,
            takeOrder: {
                id: hash,
                takeOrder: {} as any,
                quote,
            },
        }) as any;

    beforeEach(() => {
        pairMap = new Map();

        // setup orderbook1 with multiple pairs
        const ob1Map = new Map();
        const ob1OutputMap = new Map();
        const ob1PairMap = new Map();

        ob1PairMap.set("hash1", createPair(orderbook1, "hash1", { ratio: 10n, maxOutput: 500n }));
        ob1PairMap.set("hash2", createPair(orderbook1, "hash2", { ratio: 20n, maxOutput: 300n }));
        ob1PairMap.set("hash3", createPair(orderbook1, "hash3", { ratio: 10n, maxOutput: 800n }));
        ob1PairMap.set("hash4", createPair(orderbook1, "hash4")); // no quote

        ob1OutputMap.set(inputToken, ob1PairMap);
        ob1Map.set(outputToken, ob1OutputMap);
        pairMap.set(orderbook1, ob1Map);

        // setup orderbook2 with pairs
        const ob2Map = new Map();
        const ob2OutputMap = new Map();
        const ob2PairMap = new Map();

        ob2PairMap.set("hash5", createPair(orderbook2, "hash5", { ratio: 5n, maxOutput: 400n }));
        ob2PairMap.set("hash6", createPair(orderbook2, "hash6", { ratio: 5n, maxOutput: 600n }));

        ob2OutputMap.set(inputToken, ob2PairMap);
        ob2Map.set(outputToken, ob2OutputMap);
        pairMap.set(orderbook2, ob2Map);

        // setup orderbook3 with pairs
        const ob3Map = new Map();
        const ob3OutputMap = new Map();
        const ob3PairMap = new Map();

        ob3PairMap.set("hash7", createPair(orderbook3, "hash7", { ratio: 25n, maxOutput: 200n }));
        ob3PairMap.set("hash8", createPair(orderbook3, "hash8", { ratio: 30n, maxOutput: 200n }));

        ob3OutputMap.set(inputToken, ob3PairMap);
        ob3Map.set(outputToken, ob3OutputMap);
        pairMap.set(orderbook3, ob3Map);
    });

    it("should return the list with same order book true", () => {
        const result = getSortedPairList(
            pairMap,
            orderbook1,
            outputToken,
            inputToken,
            CounterpartySource.IntraOrderbook,
        );

        // should return Pair[] (single array of pairs from same orderbook)
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(4);

        // check sorting order: descending by ratio, then by maxOutput
        // expected order: hash2 (20n, 300n), hash3 (10n, 800n), hash1 (10n, 500n), hash4 (no quote)
        expect(result[0].takeOrder.id).toBe("hash3");
        expect(result[0].takeOrder.quote?.ratio).toBe(10n);
        expect(result[0].takeOrder.quote?.maxOutput).toBe(800n);

        expect(result[1].takeOrder.id).toBe("hash1");
        expect(result[1].takeOrder.quote?.ratio).toBe(10n);
        expect(result[1].takeOrder.quote?.maxOutput).toBe(500n);

        expect(result[2].takeOrder.id).toBe("hash2");
        expect(result[2].takeOrder.quote?.ratio).toBe(20n);
        expect(result[2].takeOrder.quote?.maxOutput).toBe(300n);

        expect(result[3].takeOrder.id).toBe("hash4");
        expect(result[3].takeOrder.quote).toBeUndefined();

        // verify the internal map is also sorted
        const internalMap = pairMap.get(orderbook1)?.get(outputToken)?.get(inputToken);
        const internalEntries = Array.from(internalMap!.entries());
        expect(internalEntries[0][0]).toBe("hash3");
        expect(internalEntries[1][0]).toBe("hash1");
        expect(internalEntries[2][0]).toBe("hash2");
        expect(internalEntries[3][0]).toBe("hash4");
    });

    it("should return the list with same order book false", () => {
        const result = getSortedPairList(
            pairMap,
            orderbook1,
            outputToken,
            inputToken,
            CounterpartySource.InterOrderbook,
        );

        // should return Pair[][] (array of arrays, one for each different orderbook)
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2); // orderbook2 and orderbook3 (excluding orderbook1)

        // check that each element is an array of pairs
        expect(Array.isArray(result[0])).toBe(true);
        expect(Array.isArray(result[1])).toBe(true);

        // find which result array corresponds to which orderbook
        const ob2Results = result[0];
        const ob3Results = result[1];

        expect(ob2Results).toBeDefined();
        expect(ob3Results).toBeDefined();

        // check orderbook2 sorting: hash6 (5n, 600n), hash5 (5n, 400n)
        expect(ob2Results).toHaveLength(2);
        expect(ob2Results[0].takeOrder.id).toBe("hash6");
        expect(ob2Results[0].takeOrder.quote?.ratio).toBe(5n);
        expect(ob2Results[1].takeOrder.id).toBe("hash5");
        expect(ob2Results[1].takeOrder.quote?.ratio).toBe(5n);

        // check orderbook3 sorting: hash8 (30n, 200n), hash7 (25n, 200n)
        expect(ob3Results).toHaveLength(2);
        expect(ob3Results[0].takeOrder.id).toBe("hash7");
        expect(ob3Results[0].takeOrder.quote?.ratio).toBe(25n);
        expect(ob3Results[1].takeOrder.id).toBe("hash8");
        expect(ob3Results[1].takeOrder.quote?.ratio).toBe(30n);

        // verify internal maps are also sorted
        const ob2InternalMap = pairMap.get(orderbook2)?.get(outputToken)?.get(inputToken);
        const ob2InternalEntries = Array.from(ob2InternalMap!.entries());
        expect(ob2InternalEntries[0][0]).toBe("hash6");
        expect(ob2InternalEntries[1][0]).toBe("hash5");

        const ob3InternalMap = pairMap.get(orderbook3)?.get(outputToken)?.get(inputToken);
        const ob3InternalEntries = Array.from(ob3InternalMap!.entries());
        expect(ob3InternalEntries[0][0]).toBe("hash7");
        expect(ob3InternalEntries[1][0]).toBe("hash8");
    });
});

describe("Test sortPairList function", () => {
    it("should sort pairs correctly in descending order by ratio then by maxOutput", () => {
        const createPair = (quote?: { ratio: bigint; maxOutput: bigint }): any => [
            "",
            { takeOrder: { quote } },
        ];

        // create pairs with different combinations of quotes
        const pairs: any[] = [
            createPair(undefined), // no quote - should be last
            createPair({ ratio: 5n, maxOutput: 500n }), // lower ratio, lower maxOutput
            createPair({ ratio: 5n, maxOutput: 1000n }), // lower ratio, higher maxOutput
            createPair({ ratio: 10n, maxOutput: 200n }), // higher ratio, lower maxOutput
            createPair({ ratio: 10n, maxOutput: 800n }), // higher ratio, higher maxOutput
            createPair({ ratio: 20n, maxOutput: 300n }), // highest ratio, medium maxOutput
            createPair(undefined), // another no quote - should be last
        ];
        const sorted = [...pairs].sort(sortPairList);

        // expected order (descending by ratio, then descending by maxOutput for same ratios):
        // 1. ratio: 5n, maxOutput: 1000n
        // 2. ratio: 5n, maxOutput: 500n
        // 3. ratio: 10n, maxOutput: 800n
        // 4. ratio: 10n, maxOutput: 200n
        // 5. ratio: 20n, maxOutput: 300n
        // 6. undefined quote
        // 7. undefined quote

        expect(sorted[0][1].takeOrder.quote?.ratio).toBe(5n);
        expect(sorted[0][1].takeOrder.quote?.maxOutput).toBe(1000n);

        expect(sorted[1][1].takeOrder.quote?.ratio).toBe(5n);
        expect(sorted[1][1].takeOrder.quote?.maxOutput).toBe(500n);

        expect(sorted[2][1].takeOrder.quote?.ratio).toBe(10n);
        expect(sorted[2][1].takeOrder.quote?.maxOutput).toBe(800n);

        expect(sorted[3][1].takeOrder.quote?.ratio).toBe(10n);
        expect(sorted[3][1].takeOrder.quote?.maxOutput).toBe(200n);

        expect(sorted[4][1].takeOrder.quote?.ratio).toBe(20n);
        expect(sorted[4][1].takeOrder.quote?.maxOutput).toBe(300n);

        // last two should have no quotes
        expect(sorted[5][1].takeOrder.quote).toBeUndefined();
        expect(sorted[6][1].takeOrder.quote).toBeUndefined();
    });
});
