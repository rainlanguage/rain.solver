import { RpcState } from "./rpc";
import { sleep } from "../common";
import { getWsSocketClient, openSharedWsSocket, shouldThrow, WsSocketKey } from "./helpers";
import {
    BaseError,
    Transport,
    TimeoutError,
    TransportConfig,
    createTransport,
    RpcRequestError,
} from "viem";

/**
 * RainSolver transport default configurations
 */
export namespace RainSolverTransportDefaults {
    export const DEDUPE = true as const;
    export const RETRY_COUNT = 0 as const;
    export const TIMEOUT = 10_000 as const;
    export const RETRY_DELAY = 10 as const;
    export const RETRY_COUNT_NEXT = 1 as const;
    export const POLLING_INTERVAL = 50 as const;
    export const POLLING_TIMEOUT = 10_000 as const;
    export const KEY = "RainSolverTransport" as const;
    export const NAME = "Rain Solver Transport" as const;
}

/** Rain solver transport configurations */
export type RainSolverTransportConfig = {
    /** The key of the transport */
    key?: TransportConfig["key"];
    /** The name of the transport */
    name?: TransportConfig["name"];
    /** The request timeout in milliseconds, default: 10_000ms */
    timeout?: TransportConfig["timeout"];
    /** The max number of times to retry, default: 0 */
    retryCount?: TransportConfig["retryCount"];
    /** The base delay (in ms) between retries, default: 10ms */
    retryDelay?: TransportConfig["retryDelay"];
    /** The polling timeout in milliseconds when no rpc becomes available, default: 10_000ms */
    pollingTimeout?: number;
    /** The polling interval (in ms) to check for next available rpc, default: 100ms */
    pollingInterval?: number;
    /** The max number of times to retry with next rpc, default: 1 */
    retryCountNext?: number;
    /** Whether to deduplicate in-flight requests, default: true */
    dedupe?: boolean;
};

/**
 * Type of Rainsolver timeout error in viem error type format
 */
export type TimeoutErrorType = RainSolverTransportTimeoutError & {
    name: "RainSolverTransportTimeoutError";
};

/**
 * Viem based timeout error format for RainSolver transport
 */
export class RainSolverTransportTimeoutError extends BaseError {
    constructor(timeout: number) {
        super("Timed out while waiting for next RPC to become available.", {
            details: "No RPC available for the moment",
            metaMessages: [`timed out in: ${timeout} ms`],
            name: "RainSolverTransportTimeoutError",
        });
    }
}

/** Type of rain solver viem transport */
export type RainSolverTransport = Transport<"RainSolverTransport">;

/**
 * RainSolver viem Transport that can be used for any viem client, it operates on
 * the given `RpcState` with as many number of desired urls, incoming requests are
 * passed to any transport that `RpcState.nextRpc` provides at the time, so the
 * `RpcState.nextRpc` inner logic dictates which rpc is used for any incoming requests.
 * @param state - The rpc state
 * @param config - Configurations
 */
export function rainSolverTransport(
    state: RpcState,
    config: RainSolverTransportConfig = {},
): RainSolverTransport {
    const {
        key = RainSolverTransportDefaults.KEY,
        name = RainSolverTransportDefaults.NAME,
        dedupe = RainSolverTransportDefaults.DEDUPE,
        timeout = RainSolverTransportDefaults.TIMEOUT,
        retryCount = RainSolverTransportDefaults.RETRY_COUNT,
        retryDelay = RainSolverTransportDefaults.RETRY_DELAY,
        pollingTimeout = RainSolverTransportDefaults.POLLING_TIMEOUT,
        pollingInterval = RainSolverTransportDefaults.POLLING_INTERVAL,
        retryCountNext = RainSolverTransportDefaults.RETRY_COUNT_NEXT,
    } = config;
    return (({ chain }) => {
        // cached transport instance of each rpc url, an instance is created once
        // on first use and reused for all future requests to that url, a stable
        // instance keeps viem's dedupe id stable, so identical concurrent requests
        // to the same rpc get deduplicated into a single wire request by viem,
        // the instance takes the configured timeout, so a read is bound by it
        // the same way a send is, see broadcastTx
        const instances: Record<string, ReturnType<Transport>> = {};
        const getInstance = (transport: Transport, url: string) =>
            (instances[url] ??= transport({ chain, retryCount: 0, timeout }));
        return createTransport(
            {
                key,
                name,
                timeout,
                retryDelay,
                retryCount: 0,
                type: "RainSolverTransport",
                async request(args, options) {
                    const req = async (
                        tryNextCount: number,
                        prevUrl?: string,
                        prevError?: any,
                    ): Promise<any> => {
                        // transport comes atomically paired with its url, reading
                        // state.lastUsedUrl here instead could race with concurrent
                        // requests that already moved it by their own nextRpc calls
                        const { transport, url } = await state.nextRpc({
                            timeout: pollingTimeout,
                            pollingInterval,
                        });
                        // when the rotation lands on the same rpc that just failed,
                        // dont waste another attempt on it and bail out with its
                        // error, its recorded failure has already lowered its chance
                        // of selection, so this balances out over future requests
                        if (url === prevUrl) throw prevError;
                        const instance = getInstance(transport, url);
                        const attempt = async (retrySameCount: number): Promise<any> => {
                            try {
                                return await instance.request(args, {
                                    ...options,
                                    dedupe,
                                });
                            } catch (error: any) {
                                if (shouldThrow(error)) throw error;
                                // retry the same rpc as long as it keeps a success rate
                                // above 20% threshold, this replaces the viem transport
                                // inner retries which were cancelled by the same criteria
                                if (
                                    retrySameCount > 0 &&
                                    tryNextCount > 0 &&
                                    state.metrics[url].progress.successRate > 2000
                                ) {
                                    await sleep(retryDelay);
                                    return attempt(retrySameCount - 1);
                                }
                                throw error;
                            }
                        };
                        try {
                            return await attempt(retryCount);
                        } catch (error: any) {
                            if (shouldThrow(error)) throw error;
                            if (tryNextCount) return req(tryNextCount - 1, url, error);
                            throw error;
                        }
                    };
                    return req(retryCountNext);
                },
            },
            {
                // expose the rpc pool on the transport value, so a client can reach
                // every rpc of its pool, eg to broadcast a signed tx through all
                rpcState: state,
            },
        );
    }) as RainSolverTransport;
}

/**
 * How long a subscribe that timed out waits for a late reply, in timeouts of
 * its transport, see subscriptionWebSocket, a reply after that finds nothing
 */
export const WS_LATE_REPLY_TIMEOUTS = 3;

/**
 * Drops the requests of a socket client that carry the given error callback
 * once the given time passes, unless their reply came first. A request with no
 * reply stays in the client until its socket closes, see getSocketRpcClient
 * @param rpcClient - The socket client
 * @param onError - The error callback of the requests
 * @param ms - The time to wait in milliseconds
 */
function dropRequestsAfter(
    rpcClient: Awaited<ReturnType<typeof getWsSocketClient>>,
    onError: unknown,
    ms: number,
) {
    const timer = setTimeout(() => {
        for (const [id, request] of rpcClient.requests) {
            if (request.onError === onError) rpcClient.requests.delete(id);
        }
    }, ms);
    // the wait must not keep the process alive on its own
    timer.unref?.();
}

/**
 * The ws transport of the subscriptions of the ws rpc, on a socket of its own,
 * apart from the socket of the rpc requests of the same url, see
 * WsSocketKey.Subscription. It is viem's ws transport, see webSocket in viem
 * 2.21.35, with the socket client of the subscription key, taken from its shared
 * opening, see openSharedWsSocket, viem's ws transport takes no key of its own.
 * A subscribe that gets no reply within the timeout fails with a TimeoutError,
 * viem's ws transport waits for the reply with no limit. The subscription of a
 * reply that comes after the timeout, within WS_LATE_REPLY_TIMEOUTS more
 * timeouts, is ended at once with eth_unsubscribe
 * @param url - The ws url
 * @param options - The keep alive and reconnect options of the socket
 */
export function subscriptionWebSocket(
    url: string,
    options: { keepAlive: boolean; reconnect: boolean },
): Transport {
    return ({ retryCount, timeout = 10_000 }) => {
        // the shared opening of the socket, the cached one, or a new one with its
        // timeout and its limit when the cache holds none, so a subscription opens
        // no socket of its own whatever ran before it, see openSharedWsSocket
        const getRpcClient = () =>
            openSharedWsSocket(url, options, WsSocketKey.Subscription) as ReturnType<
                typeof getWsSocketClient
            >;
        return createTransport(
            {
                key: "subscriptionWebSocket",
                name: "WebSocket JSON-RPC subscriptions",
                type: "webSocket",
                retryCount,
                timeout,
                async request({ method, params }) {
                    const body = { method, params };
                    const rpcClient = await getRpcClient();
                    const { error, result } = await rpcClient.requestAsync({ body, timeout });
                    if (error) throw new RpcRequestError({ body, error, url });
                    return result;
                },
            },
            {
                getRpcClient,
                async subscribe({
                    params,
                    onData,
                    onError,
                }: {
                    params: unknown[];
                    onData: (data: any) => void;
                    onError?: (error: any) => void;
                }) {
                    const rpcClient = await getRpcClient();
                    const body = { method: "eth_subscribe", params };
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const { result: subscriptionId } = await new Promise<any>((resolve, reject) => {
                        const fail = (error: any) => {
                            clearTimeout(timer);
                            reject(error);
                            onError?.(error);
                        };
                        // an open socket with no reply to the subscribe gives no error, so the
                        // wait ends after the timeout. A late reply still sets up the subscription
                        // on the node, so the request stays with a stub in place of the caller's
                        // callbacks, the stub ends the subscription of a late reply at once. A
                        // node that never replies would keep the stub for good, so it is dropped
                        // after WS_LATE_REPLY_TIMEOUTS more timeouts, and so is an unsubscribe
                        // with no reply after one timeout
                        timer = setTimeout(() => {
                            const ignore = () => {};
                            for (const [id, request] of rpcClient.requests) {
                                if (request.onError !== fail) continue;
                                rpcClient.requests.set(id, {
                                    onResponse(response: any) {
                                        if (typeof response.result !== "string") return;
                                        const ignoreUnsubscribe = () => {};
                                        rpcClient.request({
                                            body: {
                                                method: "eth_unsubscribe",
                                                params: [response.result],
                                            },
                                            onError: ignoreUnsubscribe,
                                            onResponse() {},
                                        });
                                        dropRequestsAfter(rpcClient, ignoreUnsubscribe, timeout);
                                    },
                                    onError: ignore,
                                });
                            }
                            dropRequestsAfter(rpcClient, ignore, timeout * WS_LATE_REPLY_TIMEOUTS);
                            fail(new TimeoutError({ body, url }));
                        }, timeout);
                        // the wait must not keep the process alive on its own
                        timer.unref?.();
                        rpcClient.request({
                            body,
                            onError: fail,
                            onResponse(response: any) {
                                if (response.error) {
                                    fail(response.error);
                                    return;
                                }
                                if (typeof response.id === "number") {
                                    clearTimeout(timer);
                                    resolve(response);
                                    return;
                                }
                                if (response.method !== "eth_subscription") return;
                                onData(response.params);
                            },
                        });
                    });
                    return {
                        subscriptionId,
                        async unsubscribe() {
                            return new Promise((resolve) =>
                                rpcClient.request({
                                    body: { method: "eth_unsubscribe", params: [subscriptionId] },
                                    onResponse: resolve,
                                }),
                            );
                        },
                    };
                },
            },
        );
    };
}
