import { isTimeout } from "../error";
import { promiseTimeout, sleep } from "../common";
import { RainSolverTransportTimeoutError } from "./transport";
import { http, webSocket, Transport, HttpTransportConfig } from "viem";
import { normalizeUrl, probablyPicksFrom, isWebSocketUrl, shouldThrow } from "./helpers";

/** The rpc configurations */
export type RpcConfig = {
    /** The rpc url, either http(s) or ws(s) */
    url: string;
    /** The number of latest requests to keep track of, default is 100 */
    trackSize?: number;
    /** The selection weight for this rpc, default is 1 */
    selectionWeight?: number;
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

    /**
     * Creates a new instance
     * @param configs - The list of rpc configs
     */
    constructor(public configs: RpcConfig[]) {
        // throw if no rpc is given
        if (!configs.length) throw "empty list, expected at least one rpc";

        // set normalized urls
        this.urls = configs.map((v) => normalizeUrl(v.url));
        this.lastUsedRpcIndex = configs.length - 1;

        // for each url as k/v
        this.metrics = {};
        this.transports = {};
        configs.forEach((conf, i) => {
            const url = this.urls[i];
            const record = (this.metrics[url] = new RpcMetrics(conf));
            // pick the underlying viem transport by the url scheme and wrap
            // it with the metrics recorder, so the rpc consumption details
            // are tracked the same way regardless of the transport kind
            const transport = isWebSocketUrl(conf.url)
                ? webSocket(conf.url, {
                      key: conf.transportConfig?.key,
                      name: conf.transportConfig?.name,
                      keepAlive: true,
                      reconnect: true,
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
     * shared lastUsedUrl after the call can race with concurrent callers
     */
    async nextRpc({
        timeout = 10_000,
        pollingInterval = 100,
    }: {
        timeout?: number;
        pollingInterval?: number;
    }): Promise<{ transport: Transport; url: string }> {
        // rpcs selection rate, each rate determines the probability of selecting that
        // rpc which is just a percentage of that rpc's latest success rate in 2 fixed
        // point decimals relative to other rpcs sucess rates, so the bigger the rate,
        // the higher chance of being selected
        const rates = this.urls.map((url) => this.metrics[url].progress.selectionRate);
        const weights = this.urls.map((url) => this.metrics[url].progress.selectionWeight);
        return await promiseTimeout(
            (async () => {
                for (;;) {
                    // pick a random one
                    const index = probablyPicksFrom(rates, weights);
                    if (isNaN(index)) {
                        await sleep(pollingInterval);
                    } else {
                        this.lastUsedRpcIndex = index;
                        const url = this.urls[index];
                        return { transport: this.transports[url], url };
                    }
                }
            })(),
            timeout,
            new RainSolverTransportTimeoutError(timeout),
        );
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
 *   timeout from the count of requests without a success/failure record
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
        this.failure++;
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
        // set the latest item in buffer to success
        const index = this.buffer.lastIndexOf(RpcBufferType.Failure);
        if (index > -1) {
            this.success++;
            this.buffer[index] = RpcBufferType.Success;
        }
    }
}
