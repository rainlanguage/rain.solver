import http from "http";
import { Socket } from "net";
import { AddressInfo } from "net";
import { createHash } from "crypto";
import { WS_RPC_SOCKET_OPTIONS } from "./rpc";
import { socketClientCache } from "viem/utils";
import { createPublicClient, webSocket, TimeoutError } from "viem";
import { subscriptionWebSocket, WS_LATE_REPLY_TIMEOUTS } from "./transport";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
    WsSocketKey,
    watchWsSocket,
    unwatchWsSocket,
    WS_REOPEN_DELAY,
    WS_OPEN_TIMEOUT,
    WS_CHECK_INTERVAL,
    reopenClosedWsSocket,
} from "./helpers";

// These tests run the real viem socket client against a local ws server, the
// fix relies on its internals: getSocketRpcClient hands out what its socket
// cache holds, a cached opening included, under the key "socket:" and the url,
// and it caches a client only once its socket is open

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A short text frame of a server, not masked */
function textFrame(data: unknown) {
    const body = Buffer.from(JSON.stringify(data));
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

/**
 * A minimal ws server on node's http, enough for viem: it answers an upgrade
 * after the delay, the first one after the first delay when it is set, refuses
 * it with a 503 while refusing, or never answers it while hanging, and answers
 * every json rpc request with "0x1" but the methods it ignores, an eth_subscribe
 * after the subscribe delay when it is set, so "0x1" is the id of a
 * subscription. It counts the upgrade attempts, keeps the requests it received,
 * the open sockets and the ones that subscribed, and notifies these of a new head
 */
async function wsServer() {
    const server = http.createServer();
    const sockets = new Set<Socket>();
    const unanswered = new Set<Socket>();
    const subscribers = new Set<Socket>();
    const notify = (result: unknown) => {
        for (const socket of subscribers) {
            socket.write(
                textFrame({
                    jsonrpc: "2.0",
                    method: "eth_subscription",
                    params: { subscription: "0x1", result },
                }),
            );
        }
    };
    const self = {
        url: "",
        attempts: 0,
        delay: 0,
        firstDelay: undefined as number | undefined,
        refusing: false,
        hanging: false,
        ignoring: new Set<string>(),
        subscribeDelay: 0,
        received: [] as { method: string; params: unknown }[],
        sockets,
        subscribers,
        notify,
    };
    server.on("upgrade", (req: http.IncomingMessage, socket: Socket) => {
        self.attempts++;
        if (self.refusing) {
            socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        // the connection stays open with no answer to the upgrade
        if (self.hanging) {
            unanswered.add(socket);
            return;
        }
        const delay = (self.attempts === 1 ? self.firstDelay : undefined) ?? self.delay;
        setTimeout(() => {
            const accept = createHash("sha1")
                .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sockets.add(socket);
            socket.on("close", () => {
                sockets.delete(socket);
                subscribers.delete(socket);
            });
            let buffer = Buffer.alloc(0);
            socket.on("data", (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                // the frames of a client are masked, the ones here are short, a 7 or a 16 bit length
                while (buffer.length >= 6) {
                    const opcode = buffer[0] & 0x0f;
                    let length = buffer[1] & 0x7f;
                    let offset = 2;
                    if (length === 126) {
                        if (buffer.length < 8) return;
                        length = buffer.readUInt16BE(2);
                        offset = 4;
                    }
                    if (buffer.length < offset + 4 + length) return;
                    const mask = buffer.subarray(offset, offset + 4);
                    const payload = buffer
                        .subarray(offset + 4, offset + 4 + length)
                        .map((byte, i) => byte ^ mask[i % 4]);
                    buffer = buffer.subarray(offset + 4 + length);
                    // a close frame
                    if (opcode === 8) {
                        socket.destroy();
                        return;
                    }
                    // a text frame, the reply is short and not masked
                    if (opcode !== 1) continue;
                    const { id, method, params } = JSON.parse(Buffer.from(payload).toString());
                    self.received.push({ method, params });
                    if (method === "eth_subscribe") subscribers.add(socket);
                    if (self.ignoring.has(method)) continue;
                    const reply = textFrame({ jsonrpc: "2.0", id, result: "0x1" });
                    if (method === "eth_subscribe" && self.subscribeDelay) {
                        setTimeout(() => {
                            if (!socket.destroyed) socket.write(reply);
                        }, self.subscribeDelay);
                        continue;
                    }
                    socket.write(reply);
                }
            });
        }, delay);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    self.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(() => {
        unwatchWsSocket(self.url);
        for (const key of Object.values(WsSocketKey)) {
            const cacheKey = `${key}:${self.url}`;
            const cached = socketClientCache.get(cacheKey) as { close?: () => void } | undefined;
            if (typeof cached?.close === "function") cached.close();
            socketClientCache.delete(cacheKey);
        }
        for (const socket of [...sockets, ...unanswered]) socket.destroy();
        server.close();
    });
    return self;
}

/** A client of the url as the rpc state makes it, no retries of its own */
function client(url: string) {
    return createPublicClient({
        transport: webSocket(url, { ...WS_RPC_SOCKET_OPTIONS, retryCount: 0 }),
    });
}

describe("Test the shared ws socket with the real viem socket client", () => {
    it("should open one socket for the requests made across ticks during a slow opening", async () => {
        const server = await wsServer();
        server.delay = 300;
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        const requests: Promise<unknown>[] = [];
        for (let i = 0; i < 10; i++) {
            // a plain request, getChainId dedupes the calls and would hide a second socket
            requests.push(rpc.request({ method: "eth_chainId" }));
            await sleep(20);
        }
        expect(await Promise.all(requests)).toEqual(Array(10).fill("0x1"));
        expect(server.attempts).toBe(1);
        expect(server.sockets.size).toBe(1);
    });

    it("should open exactly one new socket on the next check after the server drops it", async () => {
        const server = await wsServer();
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        expect(server.attempts).toBe(1);

        for (const socket of server.sockets) socket.destroy();
        // the requests on the closed socket fail and open no socket of their own
        for (let i = 0; i < 5; i++) {
            await expect(rpc.request({ method: "eth_chainId" })).rejects.toBeDefined();
            await sleep(20);
        }
        expect(server.attempts).toBe(1);
        await sleep(WS_CHECK_INTERVAL + 500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");

        // and no other one on the next check
        await sleep(WS_CHECK_INTERVAL);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
    });

    it("should make one attempt per WS_REOPEN_DELAY while the server refuses, and open one socket after", async () => {
        const server = await wsServer();
        server.refusing = true;
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        // the requests meanwhile fail with the failed opening and open nothing
        for (let i = 0; i < 10; i++) {
            await expect(rpc.request({ method: "eth_chainId" })).rejects.toBeDefined();
        }
        await sleep(500);
        expect(server.attempts).toBe(1);
        await sleep(WS_REOPEN_DELAY);
        expect(server.attempts).toBe(2);

        // the server takes upgrades again, the next attempt opens the one socket
        server.refusing = false;
        await sleep(WS_REOPEN_DELAY);
        expect(server.attempts).toBe(3);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
    });

    it("should fail the requests after WS_OPEN_TIMEOUT while the server never answers the upgrade, and open again after WS_REOPEN_DELAY", async () => {
        const server = await wsServer();
        server.hanging = true;
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);

        // the request waits for the opening until its timeout, not for the socket's own
        let start = Date.now();
        await expect(rpc.request({ method: "eth_chainId" })).rejects.toThrow("did not open within");
        expect(Date.now() - start).toBeGreaterThanOrEqual(WS_OPEN_TIMEOUT - 500);
        expect(Date.now() - start).toBeLessThan(WS_OPEN_TIMEOUT + 1000);
        expect(server.attempts).toBe(1);

        // a later request fails at once with the failed opening and opens nothing
        start = Date.now();
        await expect(rpc.request({ method: "eth_chainId" })).rejects.toThrow("did not open within");
        expect(Date.now() - start).toBeLessThan(500);
        expect(server.attempts).toBe(1);

        // the server answers again, the next opening opens the one socket
        server.hanging = false;
        await sleep(WS_REOPEN_DELAY + 500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
    });

    it("should take an opening that opens after its timeout, and open no other socket", async () => {
        const server = await wsServer();
        // the first upgrade is answered after the timeout, before the next opening
        server.firstDelay = WS_OPEN_TIMEOUT + 2000;
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);

        // viem caches the late client in place of the failed opening
        await sleep(WS_OPEN_TIMEOUT + 3000);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        expect(server.attempts).toBe(1);
        expect(server.sockets.size).toBe(1);

        // and the next opening, due after the failed one, never starts
        await sleep(WS_REOPEN_DELAY);
        expect(server.attempts).toBe(1);
        expect(server.sockets.size).toBe(1);
    });

    it("should close an opening that opens after its timeout when the next one opened meanwhile", async () => {
        const server = await wsServer();
        // the first upgrade is answered after the next opening opened
        server.firstDelay = WS_OPEN_TIMEOUT + WS_REOPEN_DELAY + 2000;
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);

        await sleep(WS_OPEN_TIMEOUT + WS_REOPEN_DELAY + 500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");

        // the late one opens, it is closed again, and the open one stays
        await sleep(2500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
    });

    it("should keep the subscriptions on a socket apart from the rpc requests of the same url", async () => {
        const server = await wsServer();
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");

        // a subscription as the ws client makes it, see SharedState.openWsSocket and getWsClient
        const ws = createPublicClient({
            transport: subscriptionWebSocket(server.url, WS_RPC_SOCKET_OPTIONS),
        });
        const heads: unknown[] = [];
        const onError = vi.fn();
        const subscribe = () => {
            reopenClosedWsSocket(server.url, WS_RPC_SOCKET_OPTIONS, WsSocketKey.Subscription);
            return (ws.transport as any).subscribe({
                params: ["newHeads"],
                onData: (data: any) => heads.push(data.result),
                onError,
            });
        };
        expect((await subscribe()).subscriptionId).toBe("0x1");
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(2);
        expect(server.subscribers.size).toBe(1);
        server.notify({ number: "0x10" });
        await vi.waitFor(() => expect(heads).toEqual([{ number: "0x10" }]));

        // a drop of the socket of the subscriptions reaches the subscription, its
        // resubscribe hangs on that, and leaves the socket of the rpc requests as it is
        expect(onError).not.toHaveBeenCalled();
        for (const socket of server.subscribers) socket.destroy();
        await vi.waitFor(() => expect(onError).toHaveBeenCalled());
        await sleep(WS_CHECK_INTERVAL + 500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");

        // the next subscription opens its socket again, the one socket of its own
        await subscribe();
        expect(server.attempts).toBe(3);
        expect(server.sockets.size).toBe(2);
        server.notify({ number: "0x11" });
        await vi.waitFor(() => expect(heads).toEqual([{ number: "0x10" }, { number: "0x11" }]));
    });

    it("should open one socket for subscriptions made across ticks during a slow opening, with no opening before them", async () => {
        const server = await wsServer();
        server.delay = 300;
        const ws = createPublicClient({
            transport: subscriptionWebSocket(server.url, WS_RPC_SOCKET_OPTIONS),
        });
        // no openWsSocket before them, they take the shared opening by themselves
        const subscriptions: Promise<{ subscriptionId: string }>[] = [];
        for (let i = 0; i < 5; i++) {
            subscriptions.push(
                (ws.transport as any).subscribe({
                    params: ["newHeads"],
                    onData: () => {},
                    onError: () => {},
                }),
            );
            await sleep(20);
        }
        for (const subscription of await Promise.all(subscriptions)) {
            expect(subscription.subscriptionId).toBe("0x1");
        }
        expect(server.attempts).toBe(1);
        expect(server.sockets.size).toBe(1);
    });

    it("should leave a subscription and its heads as they are when the socket of the rpc requests of the same url drops and its opening hangs", async () => {
        const server = await wsServer();
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        const ws = createPublicClient({
            transport: subscriptionWebSocket(server.url, WS_RPC_SOCKET_OPTIONS),
        });
        const heads: unknown[] = [];
        const onError = vi.fn();
        await (ws.transport as any).subscribe({
            params: ["newHeads"],
            onData: (data: any) => heads.push(data.result),
            onError,
        });
        expect(server.sockets.size).toBe(2);
        expect(server.subscribers.size).toBe(1);

        // the socket of the rpc requests drops, and its watch opens it again into an upgrade that hangs
        server.hanging = true;
        const rpcSocket = [...server.sockets].find((socket) => !server.subscribers.has(socket));
        expect(rpcSocket).toBeDefined();
        rpcSocket!.destroy();
        await sleep(WS_CHECK_INTERVAL + 500);
        expect(server.attempts).toBe(3);
        server.notify({ number: "0x10" });
        await vi.waitFor(() => expect(heads).toEqual([{ number: "0x10" }]));

        // the rpc requests fail once the opening times out, the subscription goes on
        await expect(rpc.request({ method: "eth_chainId" })).rejects.toThrow("did not open within");
        server.notify({ number: "0x11" });
        await vi.waitFor(() => expect(heads).toEqual([{ number: "0x10" }, { number: "0x11" }]));
        expect(onError).not.toHaveBeenCalled();
        expect(server.subscribers.size).toBe(1);
    });

    it("should fail a subscription while the server refuses the upgrade of its socket, and leave the socket of the rpc requests as it is", async () => {
        const server = await wsServer();
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        const ws = createPublicClient({
            transport: subscriptionWebSocket(server.url, WS_RPC_SOCKET_OPTIONS),
        });
        const subscribe = () =>
            (ws.transport as any).subscribe({
                params: ["newHeads"],
                onData: () => {},
                onError: () => {},
            });

        // the socket of the subscriptions fails to open, a later subscription fails at once and opens nothing
        server.refusing = true;
        await expect(subscribe()).rejects.toBeDefined();
        await expect(subscribe()).rejects.toBeDefined();
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
    });

    it("should fail a subscription after WS_OPEN_TIMEOUT while the server never answers the upgrade of its socket, and leave the socket of the rpc requests as it is", async () => {
        const server = await wsServer();
        watchWsSocket(server.url, WS_RPC_SOCKET_OPTIONS);
        const rpc = client(server.url);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        const ws = createPublicClient({
            transport: subscriptionWebSocket(server.url, WS_RPC_SOCKET_OPTIONS),
        });

        server.hanging = true;
        const start = Date.now();
        const subscription = (ws.transport as any).subscribe({
            params: ["newHeads"],
            onData: () => {},
            onError: () => {},
        });
        // the rpc requests meanwhile go on their own open socket
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
        await expect(subscription).rejects.toThrow("did not open within");
        expect(Date.now() - start).toBeGreaterThanOrEqual(WS_OPEN_TIMEOUT - 500);
        expect(server.attempts).toBe(2);
        expect(server.sockets.size).toBe(1);
        expect(await rpc.request({ method: "eth_chainId" })).toBe("0x1");
    });

    it("should fail a subscription that gets no reply within the timeout, and drop its request after the wait for a late reply", async () => {
        const server = await wsServer();
        server.ignoring.add("eth_subscribe");
        // the transport as a client takes it, with a short timeout
        const transport = subscriptionWebSocket(
            server.url,
            WS_RPC_SOCKET_OPTIONS,
        )({
            timeout: 500,
        }).value as any;
        const onError = vi.fn();
        await expect(
            transport.subscribe({ params: ["newHeads"], onData: () => {}, onError }),
        ).rejects.toThrow(TimeoutError);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBeInstanceOf(TimeoutError);
        const rpcClient = await transport.getRpcClient();
        expect(rpcClient.subscriptions.size).toBe(0);

        // the request waits for a late reply, and is dropped after that
        expect(rpcClient.requests.size).toBe(1);
        await vi.waitFor(() => expect(rpcClient.requests.size).toBe(0), {
            timeout: 500 * WS_LATE_REPLY_TIMEOUTS + 1_000,
        });

        // the socket stays open, and a subscription that gets its reply goes on it
        server.ignoring.delete("eth_subscribe");
        const { subscriptionId } = await transport.subscribe({
            params: ["newHeads"],
            onData: () => {},
            onError,
        });
        expect(subscriptionId).toBe("0x1");
        expect(server.attempts).toBe(1);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("should end the subscription of a reply that comes after the timeout, and hand nothing of it to the caller", async () => {
        const server = await wsServer();
        server.subscribeDelay = 1_000;
        // the transport as a client takes it, with a short timeout
        const transport = subscriptionWebSocket(
            server.url,
            WS_RPC_SOCKET_OPTIONS,
        )({
            timeout: 500,
        }).value as any;
        const onData = vi.fn();
        const onError = vi.fn();
        await expect(
            transport.subscribe({ params: ["newHeads"], onData, onError }),
        ).rejects.toThrow(TimeoutError);
        expect(onError).toHaveBeenCalledTimes(1);

        // the late reply sets up the subscription on the node, it is ended at once
        await vi.waitFor(
            () =>
                expect(server.received).toContainEqual({
                    method: "eth_unsubscribe",
                    params: ["0x1"],
                }),
            { timeout: 3_000 },
        );
        const rpcClient = await transport.getRpcClient();
        await vi.waitFor(() => expect(rpcClient.requests.size).toBe(0));
        expect(rpcClient.subscriptions.size).toBe(0);

        // its heads reach no caller
        server.notify({ number: "0x10" });
        await sleep(100);
        expect(onData).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("should drop the unsubscribe of a late reply after the timeout when it gets no reply of its own", async () => {
        const server = await wsServer();
        server.subscribeDelay = 1_000;
        server.ignoring.add("eth_unsubscribe");
        // the transport as a client takes it, with a short timeout
        const transport = subscriptionWebSocket(
            server.url,
            WS_RPC_SOCKET_OPTIONS,
        )({
            timeout: 500,
        }).value as any;
        await expect(
            transport.subscribe({ params: ["newHeads"], onData: () => {}, onError: () => {} }),
        ).rejects.toThrow(TimeoutError);
        await vi.waitFor(
            () =>
                expect(server.received).toContainEqual({
                    method: "eth_unsubscribe",
                    params: ["0x1"],
                }),
            { timeout: 3_000 },
        );

        // the unsubscribe waits for its reply until the timeout, and is dropped after that
        const rpcClient = await transport.getRpcClient();
        expect(rpcClient.requests.size).toBe(1);
        await vi.waitFor(() => expect(rpcClient.requests.size).toBe(0), { timeout: 1_500 });
    });

    it("should subscribe on the url the url function gives at each call", async () => {
        const first = await wsServer();
        const second = await wsServer();
        let url = first.url;
        // as the ws client of the state gives the url in use, see SharedState.activeWsUrl
        const ws = createPublicClient({
            transport: subscriptionWebSocket(() => url, WS_RPC_SOCKET_OPTIONS),
        });
        const subscribe = () =>
            (ws.transport as any).subscribe({
                params: ["newHeads"],
                onData: () => {},
                onError: () => {},
            });
        await subscribe();
        expect(first.subscribers.size).toBe(1);
        expect(second.attempts).toBe(0);

        // the url changes, the next subscription goes to the other url, the first one stays
        url = second.url;
        await subscribe();
        expect(second.subscribers.size).toBe(1);
        expect(first.subscribers.size).toBe(1);
        expect(first.attempts).toBe(1);
    });
});
