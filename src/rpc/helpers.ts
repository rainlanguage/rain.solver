import {
    ExecutionRevertedError,
    UserRejectedRequestError,
    TransactionRejectedRpcError,
} from "viem";
import { getWebSocketRpcClient, socketClientCache } from "viem/utils";

/** EVM JSON-RPC error codes */
export const RpcErrorCode = [
    -32700, // Parse error
    -32600, // Invalid request
    -32601, // Method not found
    -32602, // Invalid params
    -32603, // Internal error
    -32000, // Invalid input
    -32001, // Resource not found
    -32002, // Resource unavailable
    -32003, // Transaction rejected
    -32004, // Method not supported
    -32005, // Limit exceeded
    -32006, // JSON-RPC version not supported
    -32042, // Method not found
] as const;

/** EVM JSON-RPC provider error codes */
export const ProviderRpcErrorCode = [
    4001, // User Rejected Request
    4100, // Unauthorized
    4200, // Unsupported Method
    4900, // Disconnected
    4901, // Chain Disconnected
    4902, // Chain Not Recognized
] as const;

/** Represents a JSON-RPC request type */
export type RpcRequest = {
    jsonrpc: `${number}`;
    method: string;
    params?: any | undefined;
    id: number;
};

/** Represents a JSON-RPC response type, either error or success */
export type RpcResponse<result = any, error = any> = {
    jsonrpc: `${number}`;
    id: number;
} & (RpcSuccessResult<result> | RpcErrorResult<error>);

/** Represents a JSON-RPC success result type */
export type RpcSuccessResult<result> = {
    method?: undefined;
    result: result;
    error?: undefined;
};

/** Represents a JSON-RPC error result type */
export type RpcErrorResult<error> = {
    method?: undefined;
    result?: undefined;
    error: error;
};

/** Raw error type returned from rpc call */
export type RawRpcError = {
    code: number;
    message: string;
    data?: string | number;
};

/** Checks if the given value is a JSON-RPC request */
export function isRpcRequest(v: any): v is RpcRequest {
    if (
        typeof v === "object" &&
        v !== null &&
        "jsonrpc" in v &&
        "id" in v &&
        typeof v.id === "number"
    )
        return true;
    else return false;
}

/** Checks if the given value is a JSON-RPC response */
export function isRpcResponse(v: any): v is RpcResponse {
    if (
        typeof v === "object" &&
        v !== null &&
        "jsonrpc" in v &&
        "id" in v &&
        typeof v.id === "number"
    )
        return true;
    else return false;
}

/** Normalizes the given url */
export function normalizeUrl(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}

/** Checks if the given url is a websocket url */
export function isWebSocketUrl(url: string): boolean {
    return /^wss?:\/\//.test(url);
}

/** The wait (in ms) before a ws socket that failed to open opens again, see openSharedWsSocket */
export const WS_REOPEN_DELAY = 5_000;

/**
 * The longest wait (in ms) for a ws socket to open, a longer opening counts as
 * failed, see openSharedWsSocket, the same as the default request timeout of viem
 */
export const WS_OPEN_TIMEOUT = 10_000;

/**
 * The most openings of one ws socket that run at once, see openSharedWsSocket.
 * An opening that times out cannot be stopped, viem gives no handle to its
 * socket, so it runs until Node gives up on its handshake, and a new opening
 * waits while this many still run
 */
export const WS_MAX_OPENINGS = 2;

/** The client of each cached ws url once its socket opened, see openSharedWsSocket */
const openedWsSockets = new Map<string, Awaited<ReturnType<typeof getWebSocketRpcClient>>>();

/** The openings of each cached ws url that still run, see WS_MAX_OPENINGS */
const runningWsOpenings = new Map<string, number>();

/** The opening of each cached ws url that waits for a running one to end, see WS_MAX_OPENINGS */
const waitingWsOpenings = new Map<string, () => void>();

/**
 * Opens the socket of a ws url and puts the opening in viem's socket cache at
 * once. viem caches a socket client only once its socket is open, and a call
 * that finds none opens one more socket, so each request made during an
 * opening would open its own socket, and nothing ever closes the extra ones.
 * viem hands what its cache holds to every caller as it is, so the requests
 * made during this opening wait for its socket, and viem puts the client in
 * its place once the socket is open. A url that is in the cache already is
 * left as it is. An opening that fails, or that does not open within
 * WS_OPEN_TIMEOUT, stays in the cache as a failed one, so the requests fail at
 * once with its error and open nothing, and the socket opens again after
 * WS_REOPEN_DELAY, unless something else took its place meanwhile. An opening
 * that times out still runs, so the next one waits while WS_MAX_OPENINGS of the
 * url run, and starts once one of them ends. viem puts the client of an opening
 * that opens after its timeout in the cache all the same, such a late one that
 * finds an open socket is closed, and the open one goes back in its place, and a
 * closed client it takes the place of is closed for good. An opening settles
 * with the client the url keeps, so its callers never get a client that is
 * closed again. The cache key is the one of the viem ws transport, "socket:"
 * and the url
 * @param url - The ws url
 * @param options - The keep alive and reconnect options of the socket, the ones of the transports that use it
 * @returns The opening, or the cached client when there is one
 */
export function openSharedWsSocket(
    url: string,
    options: { keepAlive: boolean; reconnect: boolean },
): Promise<unknown> {
    const key = `socket:${url}`;
    const cached = socketClientCache.get(key);
    if (cached) return Promise.resolve(cached);
    const opening = getWebSocketRpcClient(url, options);
    runningWsOpenings.set(key, (runningWsOpenings.get(key) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`the ws socket did not open within ${WS_OPEN_TIMEOUT} ms`)),
            WS_OPEN_TIMEOUT,
        );
        // the wait must not keep the process alive on its own
        timer.unref?.();
    });
    // the client the url keeps once the socket opens, the opening settles with it
    const kept = opening.then((client) => {
        const current = openedWsSockets.get(key);
        if (current && current !== client) {
            // 1 is OPEN, a late opening finds the one that opened meanwhile
            if (current.socket?.readyState === 1) {
                client.close();
                socketClientCache.set(key, current as any);
                return current;
            }
            // a closed client this one replaces is closed for good, which also
            // stops its keep alive timer, its close drops the key from the cache
            current.close();
            socketClientCache.set(key, client as any);
        }
        openedWsSockets.set(key, client);
        return client;
    });
    const entry = Promise.race([kept, timeout]).finally(() => clearTimeout(timer));
    socketClientCache.set(key, entry as any);
    kept.catch(() => {}).finally(() => {
        runningWsOpenings.set(key, (runningWsOpenings.get(key) ?? 1) - 1);
        // the opening that waits for one to end starts now
        const waiting = waitingWsOpenings.get(key);
        waitingWsOpenings.delete(key);
        waiting?.();
    });
    entry.catch(() => {
        const reopen = () => {
            if (socketClientCache.get(key) !== (entry as any)) return;
            if ((runningWsOpenings.get(key) ?? 0) >= WS_MAX_OPENINGS) {
                waitingWsOpenings.set(key, reopen);
                return;
            }
            socketClientCache.delete(key);
            openSharedWsSocket(url, options);
        };
        const timer = setTimeout(reopen, WS_REOPEN_DELAY);
        // the wait must not keep the process alive on its own
        timer.unref?.();
    });
    return entry;
}

/**
 * Opens the socket of a ws url again when its cached socket is closing or
 * closed. The closed client is closed first, which drops it from the cache, and
 * the opening takes its place in the same step, see openSharedWsSocket, so the
 * requests on the url never find the cache empty. An open socket, and an
 * opening in the cache, are left as they are, a failed opening opens again by
 * itself
 * @param url - The ws url
 * @param options - The keep alive and reconnect options of the socket
 * @returns The new opening, undefined when none started
 */
export function reopenClosedWsSocket(
    url: string,
    options: { keepAlive: boolean; reconnect: boolean },
): Promise<unknown> | undefined {
    const cached = socketClientCache.get(`socket:${url}`);
    if (cached) {
        const readyState = (cached.socket as { readyState?: number } | undefined)?.readyState;
        // 2 is CLOSING and 3 is CLOSED, a socket with no reconnect stays closed
        if (readyState !== 2 && readyState !== 3) return undefined;
        cached.close();
    }
    return openSharedWsSocket(url, options);
}

/** How often (in ms) a watched ws socket is checked, see watchWsSocket */
export const WS_CHECK_INTERVAL = 2_000;

/** The check timer of each watched ws url, see watchWsSocket */
const wsSocketWatches = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Opens the socket of a ws url, see openSharedWsSocket, and checks it every
 * WS_CHECK_INTERVAL from then on, a socket that closed opens again, see
 * reopenClosedWsSocket. This stands in for viem's own reconnect, which is off
 * for these sockets: viem's reconnect timers outlive their client, those of an
 * opening that failed belong to no client at all, and a socket one of them
 * opens is never closed. A url that is watched already is left as it is
 * @param url - The ws url
 * @param options - The keep alive and reconnect options of the socket, the ones of the transports that use it
 */
export function watchWsSocket(url: string, options: { keepAlive: boolean; reconnect: boolean }) {
    if (wsSocketWatches.has(url)) return;
    void openSharedWsSocket(url, options);
    const timer = setInterval(() => void reopenClosedWsSocket(url, options), WS_CHECK_INTERVAL);
    // the watch must not keep the process alive on its own
    timer.unref?.();
    wsSocketWatches.set(url, timer);
}

/**
 * Stops the watch of a ws url, see watchWsSocket, its socket stays as it is
 * @param url - The ws url
 */
export function unwatchWsSocket(url: string) {
    clearInterval(wsSocketWatches.get(url));
    wsSocketWatches.delete(url);
}

/**
 * Probably picks an item from the given array of success rates as probablity ranges
 * which are in 2 fixed point decimalss
 * @param ranges - The array of success rates as ranges to randomly select from
 * @param weights - The array of weights to adjust the probability of each item being picked, should be in [0, 1] range
 * @param alwaysLands - (optional) Draws over the ranges alone, so every draw lands on an item, in proportion to the ranges, default is false, the weights then reserve room where a draw lands on nothing
 * @returns The index of the picked item from the array or NaN if out-of-range
 */
export function probablyPicksFrom(
    ranges: number[],
    weights: number[],
    alwaysLands = false,
): number {
    // the share of the draw each item takes: its range alone when every draw
    // must land, else the room its weight reserves, the part of it above the
    // range is where the draw lands on nothing
    const span = (i: number) =>
        alwaysLands ? ranges[i] : Math.max(ranges[i], Math.ceil(10_000 * weights[i]));
    // pick a random int from [1, max] range
    const max = ranges.reduce((a, _, i) => a + span(i), 0);
    const pick = Math.floor(Math.random() * max) + 1;

    // we now match the selection rates against
    // picked random int to get picked index
    let offset = 0;
    for (let i = 0; i < ranges.length; i++) {
        const lowerBound = offset + 1;
        const upperBound = offset + ranges[i];
        if (lowerBound <= pick && pick <= upperBound) {
            return i;
        }
        offset += span(i);
    }

    // out-of-range, picked value didnt match any of the items from the given list
    return NaN;
}

/**
 * Extracts original rpc error from the viem error
 * @param error - The error
 */
export function getRpcError(error: Error, breaker = 0): RawRpcError {
    const result: RawRpcError = {
        data: undefined,
        code: undefined,
        message: undefined,
    } as any;
    if (breaker > 10) {
        result.message = "Found no rpc error in the given viem error";
        return result;
    }
    if ("cause" in error) {
        const org = getRpcError(error.cause as any, breaker + 1);
        if ("code" in org && typeof org.code === "number") {
            result.code = org.code;
        }
        if ("message" in org && typeof org.message === "string") {
            result.message = org.message;
        }
        if ("data" in org && (typeof org.data === "string" || typeof org.data === "number")) {
            result.data = org.data;
        }
    } else {
        if ("code" in error && typeof error.code === "number" && result.code === undefined) {
            result.code = error.code;
            // include msg only if code exists
            if (
                "message" in error &&
                typeof error.message === "string" &&
                result.message === undefined
            ) {
                result.message = error.message;
            }
        }
        if ("data" in error && (typeof error.data === "string" || typeof error.data === "number")) {
            result.data = error.data;
            // include msg only if data exists
            if (
                "message" in error &&
                typeof error.message === "string" &&
                result.message === undefined
            ) {
                result.message = error.message;
            }
        }
    }
    return result;
}

/**
 * Determines if this fetch reponse is a throwable node error, this
 * is mainly used for determining success and failure rates of a rpc
 * @param error - The error thrown from rpc fetch hook
 */
export function shouldThrow(error: Error) {
    const msg: string[] = [];
    const org = getRpcError(error);
    if (typeof org.message === "string") {
        msg.push(org.message.toLowerCase());
    }
    msg.push(((error as any)?.name ?? "").toLowerCase());
    msg.push(((error as any)?.details ?? "").toLowerCase());
    msg.push(((error as any)?.shortMessage ?? "").toLowerCase());
    if (msg.some((v) => v.includes("execution reverted") || v.includes("unknown reason"))) {
        return true;
    }
    if (org.data !== undefined) return true;
    if (error instanceof ExecutionRevertedError) return true;
    if ("code" in error && typeof error.code === "number") {
        if (
            error.code === UserRejectedRequestError.code ||
            error.code === TransactionRejectedRpcError.code ||
            error.code === 5000 // CAIP UserRejectedRequestError
        )
            return true;
    }
    return false;
}
