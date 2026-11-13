import http from "http";
import { Socket } from "net";
import { AddressInfo } from "net";
import { createHash } from "crypto";
import { WS_RPC_SOCKET_OPTIONS } from "./rpc";
import { socketClientCache } from "viem/utils";
import { createPublicClient, webSocket } from "viem";
import { describe, it, expect, afterEach } from "vitest";
import {
    watchWsSocket,
    unwatchWsSocket,
    WS_REOPEN_DELAY,
    WS_OPEN_TIMEOUT,
    WS_CHECK_INTERVAL,
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

/**
 * A minimal ws server on node's http, enough for viem: it answers an upgrade
 * after the delay, the first one after the first delay when it is set, refuses
 * it with a 503 while refusing, or never answers it while hanging, and answers
 * every json rpc request with "0x1". It counts the upgrade attempts and keeps
 * the open sockets
 */
async function wsServer() {
    const server = http.createServer();
    const sockets = new Set<Socket>();
    const unanswered = new Set<Socket>();
    const self = {
        url: "",
        attempts: 0,
        delay: 0,
        firstDelay: undefined as number | undefined,
        refusing: false,
        hanging: false,
        sockets,
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
            socket.on("close", () => sockets.delete(socket));
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
                    const { id } = JSON.parse(Buffer.from(payload).toString());
                    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
                    socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
                }
            });
        }, delay);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    self.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(() => {
        unwatchWsSocket(self.url);
        const key = `socket:${self.url}`;
        const cached = socketClientCache.get(key) as { close?: () => void } | undefined;
        if (typeof cached?.close === "function") cached.close();
        socketClientCache.delete(key);
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
});
