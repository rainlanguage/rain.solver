import { isTimeout } from "../error";
import { promiseTimeout, sleep } from "../common";
import { RainSolverTransportTimeoutError } from "./transport";
import { http, webSocket, Transport, HttpTransportConfig } from "viem";
import {
    shouldThrow,
    normalizeUrl,
    watchWsSocket,
    isWebSocketUrl,
    probablyPicksFrom,
} from "./helpers";

/**
 * The socket options of the ws rpcs, their transports and the openings of their
 * sockets share them, the socket of the subscriptions of the ws rpc too. viem's
 * own reconnect is off. A watch opens a socket of the rpc requests that closed
 * again, see watchWsSocket, the socket of the subscriptions opens again when
 * they subscribe again, see SharedState.openWsSocket
 */
export const WS_RPC_SOCKET_OPTIONS = { keepAlive: true, reconnect: false } as const;

/**
 * The recent success rate, in 2 fixed point decimals, from which on an rpc is
 * healthy, 20%, see RpcProgress.settledSuccessRate, RpcState.nextRpc and
 * RpcState.retryRpc
 */
export const RPC_HEALTHY_SUCCESS_RATE = 2_000;

/** How the state picks the rpc of a request among its pool, see RpcState.nextRpc and AppOptions.rpcSelection */
export enum RpcSelectionMode {
    /**
     * A draw over the rpcs' recent success rates alone, every draw lands on an
     * rpc, a healthier one more often, so the pick is at hand at once
     */
    Immediate = "immediate",
    /**
     * The draw leaves room for no pick, the share the rpcs' failures take, a
     * miss waits a polling interval and draws again, up to the polling timeout,
     * so requests are held back while every rpc fails
     */
    Throttled = "throttled",
}

/** The rpc configurations */
export type RpcConfig = {
    /** The rpc url, either http(s) or ws(s) */
    url: string;
    /** The number of latest requests to keep track of, 1 or more, default is 100 */
    trackSize?: number;
    /** The selection weight for this rpc, default is 1 */
    selectionWeight?: number;
    /**
     * Whether this rpc is a fallback one. A fallback rpc gets no first tries of
     * the requests while a main rpc, one that is not a fallback, is healthy, see
     * RpcState.nextRpc. It gets the retry of a failed request when no other main
     * rpc is healthy, see RpcState.retryRpc, so with one main rpc it gets the
     * retries. With multiBroadcast on, every transaction goes to every rpc of
     * the pool, the fallback ones included. The socket of a fallback ws rpc
     * opens once it is first used and stays open from then on. Default is false
     */
    fallback?: boolean;
    /** Viem transport configuration, batch and fetchOptions only apply to http rpcs */
    transportConfig?: Pick<HttpTransportConfig, "key" | "name" | "batch" | "fetchOptions">;
};

/**
 * Rain solver rpc state, manages and keeps track of rpcs during runtime
 */
export class RpcState {
    /** List of rpc urls */
    readonly urls: string[];
    /** A key/value object keeping metrics of each rpc */
    metrics: Record<string, RpcMetrics>;
    /** A key/value object keeping viem transport of each rpc */
    transports: Record<string, Transport>;
    /** Keeps the index of the rpc that was used for the latest request */
    lastUsedRpcIndex: number;
    /** Whether each rpc is a fallback one, by the order of urls, see RpcConfig.fallback */
    readonly fallbacks: boolean[];
    /** The url of each ws rpc as configured, by its normalized url, see watchSocket */
    private readonly wsUrls: Record<string, string> = {};

    /**
     * Creates a new instance
     * @param configs - The list of rpc configs
     */
    constructor(
        public configs: RpcConfig[],
        /** How the rpc of a request is picked, see nextRpc, immediate when unset */
        readonly selection: RpcSelectionMode = RpcSelectionMode.Immediate,
    ) {
        // throw if no rpc is given
        if (!configs.length) throw "empty list, expected at least one rpc";

        // set normalized urls
        this.urls = configs.map((v) => normalizeUrl(v.url));
        this.lastUsedRpcIndex = configs.length - 1;
        this.fallbacks = configs.map((v) => !!v.fallback);

        // for each url as k/v
        this.metrics = {};
        this.transports = {};
        configs.forEach((conf, i) => {
            const url = this.urls[i];
            const record = (this.metrics[url] = new RpcMetrics(conf));
            // pick the underlying viem transport by the url scheme and wrap
            // it with the metrics recorder, so the rpc consumption details
            // are tracked the same way regardless of the transport kind
            if (isWebSocketUrl(conf.url)) this.wsUrls[url] = conf.url;
            const transport = isWebSocketUrl(conf.url)
                ? webSocket(conf.url, {
                      key: conf.transportConfig?.key,
                      name: conf.transportConfig?.name,
                      ...WS_RPC_SOCKET_OPTIONS,
                  })
                : http(conf.url, conf.transportConfig);
            this.transports[url] = withRpcMetrics(transport, record);
        });
    }

    /**
     * Last used rpc
     */
    get lastUsedRpc(): Transport {
        return this.transports[this.lastUsedUrl];
    }
    /**
     * Last used rpc url
     */
    get lastUsedUrl(): string {
        return this.urls[this.lastUsedRpcIndex];
    }

    /**
     * Get next rpc to use which is picked based on past performance, returns
     * the picked transport atomically paired with its url, since reading the
     * shared lastUsedUrl after the call can race with concurrent callers. The
     * draw takes the main rpcs, the ones that are not fallbacks, while one of
     * them is healthy, see RPC_HEALTHY_SUCCESS_RATE. While none is, the fallback
     * rpcs join the draw, and the main rpcs stay in it with their low rates, so
     * one that comes back gets picks again and its rate rises. With no fallback,
     * or no main rpc, every rpc is in the draw. In the immediate selection mode
     * every draw lands and the pick returns at once, in the throttled mode a
     * draw can land on nothing and the pick waits a polling interval and draws
     * again, up to the timeout, see RpcSelectionMode
     * @param timeout - The longest wait for a pick in the throttled mode, in ms
     * @param pollingInterval - The wait between two draws in the throttled mode, in ms
     */
    async nextRpc({
        timeout = 10_000,
        pollingInterval = 100,
    }: {
        timeout?: number;
        pollingInterval?: number;
    }): Promise<{ transport: Transport; url: string }> {
        const all = this.urls.map((_, i) => i);
        const mains = all.filter((i) => !this.fallbacks[i]);
        const pool =
            mains.length && mains.length < all.length && mains.some((i) => this.isHealthy(i))
                ? mains
                : all;
        return this.pick(pool, timeout, pollingInterval);
    }

    /**
     * Gets the rpc to retry a request on after it failed on the given rpc, never
     * that rpc: a healthy main rpc, else a fallback rpc, else any other rpc,
     * picked by the draw of nextRpc among them, see nextRpc
     * @param failedUrl - The url of the rpc the request failed on
     * @param timeout - The longest wait for a pick in the throttled mode, in ms
     * @param pollingInterval - The wait between two draws in the throttled mode, in ms
     * @returns The picked rpc, undefined when the pool has no other rpc
     */
    async retryRpc({
        failedUrl,
        timeout = 10_000,
        pollingInterval = 100,
    }: {
        failedUrl: string;
        timeout?: number;
        pollingInterval?: number;
    }): Promise<{ transport: Transport; url: string } | undefined> {
        const others = this.urls.map((_, i) => i).filter((i) => this.urls[i] !== failedUrl);
        if (!others.length) return undefined;
        const healthyMains = others.filter((i) => !this.fallbacks[i] && this.isHealthy(i));
        const fallbacks = others.filter((i) => this.fallbacks[i]);
        const pool = healthyMains.length ? healthyMains : fallbacks.length ? fallbacks : others;
        return this.pick(pool, timeout, pollingInterval);
    }

    /**
     * Whether the rpc of the given url is a fallback one, see RpcConfig.fallback
     * @param url - The normalized url of the rpc
     */
    isFallback(url: string): boolean {
        return this.fallbacks[this.urls.indexOf(url)] ?? false;
    }

    /**
     * Opens the socket of a ws rpc and watches it, see watchWsSocket, so the
     * requests on it share one opening, a no-op for an http rpc and for a socket
     * watched already. A fallback ws rpc opens its socket once it is first picked
     * or used, not before
     * @param url - The normalized url of the rpc
     */
    watchSocket(url: string) {
        const wsUrl = this.wsUrls[url];
        if (wsUrl) watchWsSocket(wsUrl, WS_RPC_SOCKET_OPTIONS);
    }

    /**
     * Whether the rpc at the given index is healthy, see RPC_HEALTHY_SUCCESS_RATE,
     * its requests with no reply yet do not count, see RpcProgress.settledSuccessRate
     */
    private isHealthy(index: number) {
        const { progress } = this.metrics[this.urls[index]];
        return progress.settledSuccessRate >= RPC_HEALTHY_SUCCESS_RATE;
    }

    /**
     * Picks an rpc among the given ones by a draw over their recent success
     * rates and weights, see nextRpc, and opens its socket when it is a ws rpc
     * with none yet, see watchSocket
     * @param pool - The indexes of the rpcs to draw from
     * @param timeout - The longest wait for a pick in the throttled mode, in ms
     * @param pollingInterval - The wait between two draws in the throttled mode, in ms
     */
    private async pick(
        pool: number[],
        timeout: number,
        pollingInterval: number,
    ): Promise<{ transport: Transport; url: string }> {
        // rpcs selection rate, each rate determines the probability of selecting that
        // rpc which is just a percentage of that rpc's latest success rate in 2 fixed
        // point decimals relative to other rpcs sucess rates, so the bigger the rate,
        // the higher chance of being selected
        const rates = pool.map((i) => this.metrics[this.urls[i]].progress.selectionRate);
        const weights = pool.map((i) => this.metrics[this.urls[i]].progress.selectionWeight);
        const picked = (at: number) => {
            const index = pool[at];
            this.lastUsedRpcIndex = index;
            const url = this.urls[index];
            this.watchSocket(url);
            return { transport: this.transports[url], url };
        };
        if (this.selection === RpcSelectionMode.Immediate) {
            // every draw lands, see probablyPicksFrom, no wait and no timer to
            // run, the rates are never all zero so the draw cannot miss, the
            // first rpc stands in should it ever do
            let at = 0;
            if (pool.length > 1) {
                const drawn = probablyPicksFrom(rates, weights, true);
                at = isNaN(drawn) ? 0 : drawn;
            }
            return picked(at);
        }
        // the pick loop runs only while the wait is unsettled, so a timed out
        // wait does not keep polling in the background nor picks an rpc late
        let active = true;
        try {
            return await promiseTimeout(
                (async () => {
                    while (active) {
                        // pick a random one
                        const at = probablyPicksFrom(rates, weights);
                        if (isNaN(at)) {
                            await sleep(pollingInterval);
                        } else {
                            return picked(at);
                        }
                    }
                    // only reached once the wait has already timed out
                    return undefined as unknown as { transport: Transport; url: string };
                })(),
                timeout,
                new RainSolverTransportTimeoutError(timeout),
            );
        } finally {
            active = false;
        }
    }
}

/**
 * Wraps the given viem transport with the given rpc metrics recorder, the
 * request outcome determines the records the same way regardless of the
 * underlying transport kind (http or websocket):
 * - a resolved request records a success
 * - a rejection with a node level error (shouldThrow) records a success,
 *   since the rpc itself responded fine and the call semantically failed
 * - a rejection with a timeout error records neither, it is derived as a
 *   timeout from the count of requests without a success/failure record, it
 *   records a timeout, which only ends the request in the progress
 * - any other rejection records a failure
 * @param transport - The transport to wrap
 * @param record - The rpc metrics recorder of the wrapped transport's rpc
 */
export function withRpcMetrics(transport: Transport, record: RpcMetrics): Transport {
    return ((opts) => {
        const instance = transport(opts);
        return {
            ...instance,
            request: async (args: any, options?: any) => {
                record.recordRequest();
                try {
                    const result = await instance.request(args, options);
                    record.recordSuccess();
                    return result;
                } catch (error: any) {
                    if (shouldThrow(error)) {
                        record.recordSuccess();
                    } else if (!isTimeout(error)) {
                        record.recordFailure();
                    } else {
                        record.recordTimeout();
                    }
                    throw error;
                }
            },
        };
    }) as Transport;
}

/**
 * Metrics of a rpc consumption details
 */
export class RpcMetrics {
    /** Number of requests */
    req = 0;
    /** Number of successful requests */
    success = 0;
    /** Number of unsuccessful requests */
    failure = 0;
    /** Last request timestamp in milliseconds unix format */
    lastRequestTimestamp = 0;
    /** List of times between 2 consecutive requests in milliseconds */
    requestIntervals: number[] = [];
    /** A utility cache, that can hold any data betwen separate requests and runtime */
    cache: Record<string, any> = {};
    /** Hold progress details of this rpc */
    progress: RpcProgress;

    /**
     * Creates a new instance
     * @param config - (optional) The rpc configurations
     */
    constructor(config?: RpcConfig) {
        this.progress = new RpcProgress(config);
    }

    /** Number of timeout requests */
    get timeout() {
        return Math.max(this.req - (this.success + this.failure), 0);
    }

    /** Average request intervals */
    get avgRequestIntervals() {
        if (!this.requestIntervals.length) {
            if (!this.lastRequestTimestamp) return 0;
            else return Date.now() - this.lastRequestTimestamp;
        } else {
            return Math.floor(
                this.requestIntervals.reduce((a, b) => a + b, 0) / this.requestIntervals.length,
            );
        }
    }

    /** Resets the records */
    reset() {
        this.req = 0;
        this.success = 0;
        this.failure = 0;
        this.requestIntervals = [];
    }

    /** Handles a request */
    recordRequest() {
        this.req++;
        this.progress.recordRequest();
        const now = Date.now();
        if (!this.lastRequestTimestamp) {
            this.lastRequestTimestamp = now;
        } else {
            const prevRequestTimestamp = this.lastRequestTimestamp;
            this.lastRequestTimestamp = now;
            this.requestIntervals.push(now - prevRequestTimestamp);
        }
    }

    /** Records a success response */
    recordSuccess() {
        this.progress.recordSuccess();
        this.success++;
    }

    /** Records a failure response */
    recordFailure() {
        this.progress.recordFailure();
        this.failure++;
    }

    /**
     * Records a timeout response, it ends the request in the progress, see
     * RpcProgress.recordFailure, the count of timeouts is derived, see timeout
     */
    recordTimeout() {
        this.progress.recordFailure();
    }
}

/** A helper enum for RpcProgress buffer item type */
export enum RpcBufferType {
    Failure,
    Success,
}

/**
 * Holds progress details of a rpc that persist during runtime rounds
 */
export class RpcProgress {
    /** Number of latest requests to keep track of, default is 100 */
    trackSize = 100;
    /** Multiplier to selection rate of this rpc, default is 1 */
    selectionWeight = 1;
    /** Number of latest successful requests, max possible value equals to trackSize */
    success: number;
    /** The buffer that keeps the latest response types with the length of trackSize */
    buffer: RpcBufferType[];
    /**
     * The buffer that keeps the response types of the latest requests that have
     * a reply, a timeout included, with the length of trackSize, see settledSuccessRate
     */
    settledBuffer: RpcBufferType[] = [];
    /** Number of successful requests in settledBuffer */
    settledSuccess = 0;

    /**
     * Creates a new instance with given configuration
     * @param config - (optional) The rpc configurations
     */
    constructor(config?: RpcConfig) {
        this.success = 0;
        this.buffer = [];
        if (typeof config?.trackSize === "number") {
            this.trackSize = config.trackSize;
        }
        if (typeof config?.selectionWeight === "number") {
            this.selectionWeight = config.selectionWeight;
        }
    }

    /** Current success rate in 2 fixed decimals points percentage */
    get successRate() {
        // at start when no previous record is available, we start from 50%
        if (this.buffer.length === 0) return 5_000;
        return Math.ceil((this.success / this.buffer.length) * 10_000);
    }

    /**
     * Current success rate of the latest requests that have a reply, a timeout
     * included, in 2 fixed point decimals. The success rate counts a request with
     * no reply yet as a failure, this one leaves it out until its reply or its
     * timeout, so many requests at once do not lower it, and a timeout lowers it
     * once it ends. 50% when no request has a reply yet, see RPC_HEALTHY_SUCCESS_RATE
     */
    get settledSuccessRate() {
        // at start when no request has a reply yet, we start from 50%
        if (this.settledBuffer.length === 0) return 5_000;
        return Math.ceil((this.settledSuccess / this.settledBuffer.length) * 10_000);
    }

    /**
     * Current selection rate, determines the relative chance to get picked.
     * min of 0.1% if zero success rate, in order to allow for a slim chance of
     * being picked again so it doesnt get stuck at zero rate forever, in case
     * of 2 fixed point decimals, 0.1% equates to 10
     */
    get selectionRate() {
        return Math.max(Math.ceil(this.successRate * this.selectionWeight), 10);
    }

    /** Handles a request */
    recordRequest() {
        // we consider every req a failure, it only gets changed
        // to success when the success response gets recorded
        //
        // buffer length saturates at trackSize
        this.buffer.push(RpcBufferType.Failure);
        if (this.buffer.length > this.trackSize) {
            // knock the first item out
            if (this.buffer[0] === RpcBufferType.Success) this.success--;
            this.buffer = this.buffer.slice(1);
        }
    }

    /** Records a success response */
    recordSuccess() {
        this.settle(RpcBufferType.Success);
        // set the latest item in buffer to success
        const index = this.buffer.lastIndexOf(RpcBufferType.Failure);
        if (index > -1) {
            this.success++;
            this.buffer[index] = RpcBufferType.Success;
        }
    }

    /** Records a failure or a timeout response, the request stays a failure in the buffer */
    recordFailure() {
        this.settle(RpcBufferType.Failure);
    }

    /** Keeps the response type of a request that has a reply, see settledBuffer */
    private settle(type: RpcBufferType) {
        // settled buffer length saturates at trackSize
        this.settledBuffer.push(type);
        if (type === RpcBufferType.Success) this.settledSuccess++;
        if (this.settledBuffer.length > this.trackSize) {
            // knock the first item out
            if (this.settledBuffer.shift() === RpcBufferType.Success) this.settledSuccess--;
        }
    }
}
