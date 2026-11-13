import { describe, it, assert, expect, vi, Mock } from "vitest";
import { getWebSocketRpcClient, socketClientCache } from "viem/utils";
import {
    getRpcError,
    normalizeUrl,
    shouldThrow,
    watchWsSocket,
    unwatchWsSocket,
    WS_REOPEN_DELAY,
    WS_OPEN_TIMEOUT,
    WS_MAX_OPENINGS,
    WS_CHECK_INTERVAL,
    probablyPicksFrom,
    openSharedWsSocket,
    reopenClosedWsSocket,
} from "./helpers";
import {
    BaseError,
    ExecutionRevertedError,
    UserRejectedRequestError,
    TransactionRejectedRpcError,
} from "viem";

vi.mock("viem/utils", async (importOriginal) => ({
    ...(await importOriginal()),
    getWebSocketRpcClient: vi.fn(),
    socketClientCache: new Map(),
}));

describe("Test rpc helpers", async function () {
    it("should normalize url", async function () {
        const url1 = "https://example1.com/";
        const result1 = normalizeUrl(url1);
        assert.equal(result1, "https://example1.com/");

        const url2 = "https://example2.com";
        const result2 = normalizeUrl(url2);
        assert.equal(result2, "https://example2.com/");
    });

    it("should test probablyPicksFrom", async function () {
        const selectionRange = [
            6000, // 60% succes rate, equals to 20% of all probabilities adjusted with weights
            3000, // 30% succes rate, equals to 10% of all probabilities adjusted with weights
            1000, // 10% succes rate, equals to 4% of all probabilities adjusted with weights
        ];
        const weights = [1, 1, 0.5]; // weights to adjust the probability of each item being picked
        const result = {
            first: 0,
            second: 0,
            third: 0,
            outOfRange: 0,
        };

        // run 10000 times to get a accurate distribution of results for test
        for (let i = 0; i < 10000; i++) {
            const rand = probablyPicksFrom(selectionRange, weights);
            if (rand === 0) result.first++;
            else if (rand === 1) result.second++;
            else if (rand === 2) result.third++;
            else result.outOfRange++;
        }

        // convert to percentage
        result.first /= 100;
        result.second /= 100;
        result.third /= 100;
        result.outOfRange /= 100;

        assert.closeTo(result.first, 24, 2); // has been picked close to 24% of times (60% adjusted with weight of 1)
        assert.closeTo(result.second, 12, 2); // has been picked close to 12% of times (30% adjusted with weight of 1)
        assert.closeTo(result.third, 4, 2); // has been picked close to 4% of times (10% adjusted with weight of 0.5)
        assert.closeTo(result.outOfRange, 60, 2); // has been picked close to 60% of times (out of range)
    });

    it("should always land in proportion to the ranges when asked to", async function () {
        const ranges = [6000, 3000, 1000];
        const weights = [1, 1, 0.5]; // play no part in a draw that always lands
        const counts = [0, 0, 0];
        for (let i = 0; i < 10000; i++) {
            const picked = probablyPicksFrom(ranges, weights, true);
            expect(Number.isNaN(picked)).toBe(false);
            counts[picked]++;
        }
        assert.closeTo(counts[0] / 100, 60, 2);
        assert.closeTo(counts[1] / 100, 30, 2);
        assert.closeTo(counts[2] / 100, 10, 2);

        // the floor rates alone still land, every time
        for (let i = 0; i < 1000; i++) {
            expect([0, 1]).toContain(probablyPicksFrom([10, 10], [1, 1], true));
        }

        // a zero range is never picked, and nothing to land on is a miss
        for (let i = 0; i < 1000; i++) {
            expect(probablyPicksFrom([0, 5000], [1, 1], true)).toBe(1);
        }
        expect(Number.isNaN(probablyPicksFrom([0, 0], [1, 1], true))).toBe(true);
    });

    it("should match the draw against the ranges alone when asked to always land", async function () {
        const ranges = [6000, 3000, 1000];
        const weights = [1, 1, 0.5];
        const randomSpy = vi.spyOn(Math, "random");

        // a 10000 wide draw, the slots are [1, 6000], [6001, 9000] and [9001, 10000]
        const cases: [number, number][] = [
            [0, 0],
            [0.59995, 0],
            [0.60005, 1],
            [0.89995, 1],
            [0.90005, 2],
            [0.99999, 2],
        ];
        for (const [random, expected] of cases) {
            randomSpy.mockReturnValueOnce(random);
            expect(probablyPicksFrom(ranges, weights, true)).toBe(expected);
        }

        // the same draw misses when the weights reserve room, the default
        randomSpy.mockReturnValueOnce(0.60005);
        expect(Number.isNaN(probablyPicksFrom(ranges, weights, false))).toBe(true);
        randomSpy.mockReturnValueOnce(0.60005);
        expect(Number.isNaN(probablyPicksFrom(ranges, weights))).toBe(true);

        randomSpy.mockRestore();
    });

    describe("Test getRpcError", () => {
        it("should extract RPC error from nested cause", () => {
            const mockError = new Error("Outer error") as any;
            mockError.cause = {
                code: -32000,
                message: "execution reverted",
                data: "0x08c379a0",
            };
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32000,
                message: "execution reverted",
                data: "0x08c379a0",
            });
        });

        it("should extract RPC error from direct properties", () => {
            const mockError = {
                code: -32603,
                message: "Internal error",
                data: "0x12345678",
            } as any;
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32603,
                message: "Internal error",
                data: "0x12345678",
            });
        });

        it("should handle deeply nested causes", () => {
            const mockError = new Error("Level 1") as any;
            mockError.cause = {
                cause: {
                    cause: {
                        code: -32000,
                        message: "Deep nested error",
                        data: "0xdeep",
                    },
                },
            };
            const result = getRpcError(mockError);
            expect(result).toEqual({
                code: -32000,
                message: "Deep nested error",
                data: "0xdeep",
            });
        });

        it("should handle breaker limit to prevent infinite recursion", () => {
            const mockError = new Error("Recursive error") as any;
            mockError.cause = mockError; // circular reference
            const result = getRpcError(mockError);
            expect(result.message).toBe("Found no rpc error in the given viem error");
        });
    });

    describe("Test openSharedWsSocket", () => {
        const url = "wss://example.com";
        const key = `socket:${url}`;
        const options = { keepAlive: true, reconnect: true };

        it("should put the opening in the cache at once, and leave a cached url as it is", async () => {
            socketClientCache.clear();
            (getWebSocketRpcClient as Mock).mockReset();
            let open!: (client: any) => void;
            (getWebSocketRpcClient as Mock).mockImplementationOnce(
                () => new Promise((resolve) => (open = resolve)),
            );
            const opening = openSharedWsSocket(url, options);
            expect(getWebSocketRpcClient).toHaveBeenCalledWith(url, options);
            // the requests made during the opening get the opening, see viem's getSocketRpcClient
            expect(socketClientCache.get(key)).toBe(opening);
            expect(openSharedWsSocket(url, options)).toBe(opening);
            expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);

            // viem puts the client in place of the opening once the socket is open
            const client = { socket: { readyState: 1 } };
            socketClientCache.set(key, client as any);
            open(client);
            await expect(opening).resolves.toBe(client);
            await expect(openSharedWsSocket(url, options)).resolves.toBe(client);
            expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);
            socketClientCache.clear();
        });

        it("should keep a failed opening in the cache and open again after the delay", async () => {
            vi.useFakeTimers();
            try {
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                (getWebSocketRpcClient as Mock)
                    .mockRejectedValueOnce(new Error("refused"))
                    .mockReturnValueOnce(new Promise(() => {}));
                const failed = openSharedWsSocket(url, options);
                await expect(failed).rejects.toThrow("refused");
                // the requests meanwhile fail at once with its error and open nothing
                expect(socketClientCache.get(key)).toBe(failed);
                await vi.advanceTimersByTimeAsync(WS_REOPEN_DELAY - 1);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(1);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
                expect(getWebSocketRpcClient).toHaveBeenLastCalledWith(url, options);
                expect(socketClientCache.get(key)).not.toBe(failed);

                // a failed opening that something else replaced meanwhile opens nothing
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockRejectedValueOnce(new Error("refused"));
                const replaced = openSharedWsSocket(url, options);
                await expect(replaced).rejects.toThrow("refused");
                socketClientCache.set(key, { socket: { readyState: 1 } } as any);
                await vi.advanceTimersByTimeAsync(WS_REOPEN_DELAY);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(3);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("Test an opening that does not open in time", () => {
        const options = { keepAlive: true, reconnect: false };
        // a client as viem caches it once its socket is open, its close drops it from there
        const opened = (key: string, readyState = 1) => {
            const client = {
                socket: { readyState },
                close: vi.fn(() => socketClientCache.delete(key)),
            };
            socketClientCache.set(key, client as any);
            return client;
        };

        it("should fail it after WS_OPEN_TIMEOUT and open again after WS_REOPEN_DELAY", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://timeout.example.com";
                const key = `socket:${url}`;
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                (getWebSocketRpcClient as Mock).mockReturnValue(new Promise(() => {}));
                const entry = openSharedWsSocket(url, options);
                const failed = expect(entry).rejects.toThrow(
                    `the ws socket did not open within ${WS_OPEN_TIMEOUT} ms`,
                );
                await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT);
                await failed;
                // the requests meanwhile fail at once with it and open nothing
                expect(socketClientCache.get(key)).toBe(entry);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(WS_REOPEN_DELAY);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
                expect(socketClientCache.get(key)).not.toBe(entry);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should close a late opening that finds an open socket, and put the open one back", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://late.example.com";
                const key = `socket:${url}`;
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                let openLate!: () => void;
                const late = { socket: { readyState: 1 }, close: vi.fn() };
                // the first opening opens after its timeout, viem caches its client all the same
                (getWebSocketRpcClient as Mock).mockReturnValueOnce(
                    new Promise((resolve) => {
                        openLate = () => {
                            socketClientCache.set(key, late as any);
                            late.close.mockImplementation(() => socketClientCache.delete(key));
                            resolve(late);
                        };
                    }),
                );
                // the second one opens on the next tick, viem caches its client in place of the opening
                (getWebSocketRpcClient as Mock).mockImplementationOnce(() =>
                    Promise.resolve().then(() => opened(key)),
                );
                const entry = openSharedWsSocket(url, options);
                entry.catch(() => {});
                await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT + WS_REOPEN_DELAY);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
                const open = socketClientCache.get(key) as any;
                expect(open.socket.readyState).toBe(1);

                openLate();
                await vi.advanceTimersByTimeAsync(0);
                expect(late.close).toHaveBeenCalledTimes(1);
                expect(socketClientCache.get(key)).toBe(open);
                expect(open.close).not.toHaveBeenCalled();
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should run at most WS_MAX_OPENINGS openings of a url, and start the next one when one ends", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://stalled.example.com";
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                // the handshakes stall, Node gives up on each one only much later
                const giveUp: (() => void)[] = [];
                (getWebSocketRpcClient as Mock).mockImplementation(
                    () =>
                        new Promise((_, reject) =>
                            giveUp.push(() => reject(new Error("handshake timed out"))),
                        ),
                );
                openSharedWsSocket(url, options).catch(() => {});

                // the openings time out one after another, the ones that timed out still run
                for (let i = 0; i < 4; i++) {
                    await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT + WS_REOPEN_DELAY);
                }
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(WS_MAX_OPENINGS);

                // Node gives up on the first one, the opening that waits starts at once
                giveUp[0]();
                await vi.advanceTimersByTimeAsync(0);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(WS_MAX_OPENINGS + 1);

                // and the limit holds again
                await vi.advanceTimersByTimeAsync(2 * (WS_OPEN_TIMEOUT + WS_REOPEN_DELAY));
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(WS_MAX_OPENINGS + 1);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should settle a pending opening with the late client the url keeps", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://late-pending.example.com";
                const key = `socket:${url}`;
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                // an opening that viem opens when told, it caches the client then
                const later = () => {
                    const client = {
                        socket: { readyState: 1 },
                        close: vi.fn(() => socketClientCache.delete(key)),
                    };
                    let open!: () => void;
                    const opening = new Promise((resolve) => {
                        open = () => {
                            socketClientCache.set(key, client as any);
                            resolve(client);
                        };
                    });
                    return { client, opening, open: () => open() };
                };
                const late = later();
                const next = later();
                (getWebSocketRpcClient as Mock)
                    .mockReturnValueOnce(late.opening)
                    .mockReturnValueOnce(next.opening);
                openSharedWsSocket(url, options).catch(() => {});
                await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT + WS_REOPEN_DELAY);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
                // the callers of the next opening wait on its entry
                const pending = socketClientCache.get(key) as unknown as Promise<unknown>;

                // the late one opens while the next one is pending, the url keeps it
                late.open();
                await vi.advanceTimersByTimeAsync(0);
                expect(socketClientCache.get(key)).toBe(late.client);

                // the next one opens in time, it is closed, and its callers get the late one
                next.open();
                await expect(pending).resolves.toBe(late.client);
                expect(next.client.close).toHaveBeenCalledTimes(1);
                expect(late.client.close).not.toHaveBeenCalled();
                expect(socketClientCache.get(key)).toBe(late.client);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should close a closed client that a late opening takes the place of", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://late-closed.example.com";
                const key = `socket:${url}`;
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                let openLate!: () => void;
                const late = { socket: { readyState: 1 }, close: vi.fn() };
                (getWebSocketRpcClient as Mock).mockReturnValueOnce(
                    new Promise((resolve) => {
                        openLate = () => {
                            socketClientCache.set(key, late as any);
                            resolve(late);
                        };
                    }),
                );
                // the next one opens on the next tick, viem caches its client in place of the opening
                (getWebSocketRpcClient as Mock).mockImplementationOnce(() =>
                    Promise.resolve().then(() => opened(key)),
                );
                openSharedWsSocket(url, options).catch(() => {});
                await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT + WS_REOPEN_DELAY);
                const dropped = socketClientCache.get(key) as any;
                expect(dropped.socket.readyState).toBe(1);

                // the server drops it, and the late one opens before the watch replaced it
                dropped.socket.readyState = 3;
                openLate();
                await vi.advanceTimersByTimeAsync(0);
                expect(dropped.close).toHaveBeenCalledTimes(1);
                expect(late.close).not.toHaveBeenCalled();
                expect(socketClientCache.get(key)).toBe(late);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });

        it("should keep a late opening that finds no open socket, and open none again", async () => {
            vi.useFakeTimers();
            try {
                const url = "wss://late-alone.example.com";
                const key = `socket:${url}`;
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                let openLate!: () => void;
                const late = { socket: { readyState: 1 }, close: vi.fn() };
                (getWebSocketRpcClient as Mock).mockReturnValueOnce(
                    new Promise((resolve) => {
                        openLate = () => {
                            socketClientCache.set(key, late as any);
                            resolve(late);
                        };
                    }),
                );
                const entry = openSharedWsSocket(url, options);
                entry.catch(() => {});
                await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT);
                // it opens before the next opening, the late socket is the one in place
                openLate();
                await vi.advanceTimersByTimeAsync(WS_REOPEN_DELAY);
                expect(late.close).not.toHaveBeenCalled();
                expect(socketClientCache.get(key)).toBe(late);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);
                socketClientCache.clear();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("Test reopenClosedWsSocket and watchWsSocket", () => {
        const url = "wss://example.com";
        const key = `socket:${url}`;
        const options = { keepAlive: true, reconnect: false };
        // a client as viem caches it, its close drops it from the cache
        const client = (readyState: number) => {
            const c = {
                socket: { readyState },
                close: vi.fn(() => socketClientCache.delete(key)),
            };
            socketClientCache.set(key, c as any);
            return c;
        };

        it("should open again only a closing or closed socket, in place of it at once", () => {
            socketClientCache.clear();
            (getWebSocketRpcClient as Mock).mockReset();
            (getWebSocketRpcClient as Mock).mockReturnValue(new Promise(() => {}));

            // an open or opening socket, and an opening in the cache, stay
            for (const readyState of [0, 1]) {
                const open = client(readyState);
                expect(reopenClosedWsSocket(url, options)).toBeUndefined();
                expect(open.close).not.toHaveBeenCalled();
            }
            const pending = new Promise(() => {});
            socketClientCache.set(key, pending as any);
            expect(reopenClosedWsSocket(url, options)).toBeUndefined();
            expect(getWebSocketRpcClient).not.toHaveBeenCalled();

            // a closing or a closed one is closed and the opening takes its place
            for (const readyState of [2, 3]) {
                const closed = client(readyState);
                const opening = reopenClosedWsSocket(url, options);
                expect(closed.close).toHaveBeenCalledTimes(1);
                expect(opening).toBeInstanceOf(Promise);
                expect(socketClientCache.get(key)).toBe(opening);
            }
            expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
            expect(getWebSocketRpcClient).toHaveBeenLastCalledWith(url, options);

            // an empty cache gets an opening too
            socketClientCache.clear();
            expect(reopenClosedWsSocket(url, options)).toBeInstanceOf(Promise);
            expect(getWebSocketRpcClient).toHaveBeenCalledTimes(3);
            socketClientCache.clear();
        });

        it("should open the socket once and check it every interval until the unwatch", async () => {
            vi.useFakeTimers();
            try {
                socketClientCache.clear();
                (getWebSocketRpcClient as Mock).mockReset();
                (getWebSocketRpcClient as Mock).mockReturnValue(new Promise(() => {}));
                watchWsSocket(url, options);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);
                expect(getWebSocketRpcClient).toHaveBeenCalledWith(url, options);
                // a url watched already is left as it is
                watchWsSocket(url, options);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);

                // an open socket stays across the checks
                const open = client(1);
                await vi.advanceTimersByTimeAsync(2 * WS_CHECK_INTERVAL);
                expect(open.close).not.toHaveBeenCalled();
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(1);

                // a socket that closed opens again on the next check
                open.socket.readyState = 3;
                await vi.advanceTimersByTimeAsync(WS_CHECK_INTERVAL);
                expect(open.close).toHaveBeenCalledTimes(1);
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);

                // no check after the unwatch
                unwatchWsSocket(url);
                const closed = client(3);
                await vi.advanceTimersByTimeAsync(2 * WS_CHECK_INTERVAL);
                expect(closed.close).not.toHaveBeenCalled();
                expect(getWebSocketRpcClient).toHaveBeenCalledTimes(2);
                socketClientCache.clear();
            } finally {
                unwatchWsSocket(url);
                vi.useRealTimers();
            }
        });
    });

    describe("Test shouldThrow", () => {
        it("should return true for execution reverted message", () => {
            const mockError = new BaseError("Transaction execution reverted") as any;
            mockError.name = "ExecutionError";
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for unknown reason message", () => {
            const mockError = new BaseError("Transaction failed for unknown reason") as any;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true when RPC error has data", () => {
            const mockError = new Error("Test error") as any;
            mockError.cause = {
                data: "0x08c379a0",
            };
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for ExecutionRevertedError instance", () => {
            const mockError = new ExecutionRevertedError({
                cause: new BaseError("Execution reverted"),
            });
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for UserRejectedRequestError code", () => {
            const mockError = new Error("User rejected") as any;
            mockError.code = UserRejectedRequestError.code;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for TransactionRejectedRpcError code", () => {
            const mockError = new Error("Transaction rejected") as any;
            mockError.code = TransactionRejectedRpcError.code;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return true for UserRejectedRequestError code (5000)", () => {
            const mockError = new Error("User rejected CAIP") as any;
            mockError.code = 5000;
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should return false for generic network errors", () => {
            const mockError = new Error("Network timeout");
            const result = shouldThrow(mockError);
            expect(result).toBe(false);
        });

        it("should check error details and shortMessage", () => {
            const mockError = new Error("Test error") as any;
            mockError.details = "execution reverted: insufficient balance";
            mockError.shortMessage = "Call failed";
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });

        it("should handle missing properties gracefully", () => {
            const mockError = new Error("Test error") as any;
            // Intentionally not setting name, details, shortMessage
            const result = shouldThrow(mockError);
            expect(result).toBe(false);
        });

        it("should check nested cause for execution reverted", () => {
            const mockError = new BaseError("Outer error") as any;
            mockError.cause = {
                code: 1,
                message: "inner execution reverted",
            };
            const result = shouldThrow(mockError);
            expect(result).toBe(true);
        });
    });
});
