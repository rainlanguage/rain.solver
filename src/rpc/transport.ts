import { RpcState } from "./rpc";
import { shouldThrow } from "./helpers";
import { BaseError, createTransport, Transport, TransportConfig } from "viem";

/**
 * RainSolver transport default configurations
 */
export namespace RainSolverTransportDefaults {
    export const RETRY_COUNT = 1 as const;
    export const TIMEOUT = 10_000 as const;
    export const RETRY_DELAY = 100 as const;
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
    /** The max number of times to retry, default: 1 */
    retryCount?: TransportConfig["retryCount"];
    /** The base delay (in ms) between retries, defaukt: 150ms */
    retryDelay?: TransportConfig["retryDelay"];
    /** The polling timeout in milliseconds when no rpc becomes available, default: 10_000ms */
    pollingTimeout?: number;
    /** The polling interval (in ms) to check for next available rpc, default: 250ms */
    pollingInterval?: number;
    /** The max number of times to retry with next rpc, default: 1 */
    retryCountNext?: number;
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
        timeout = RainSolverTransportDefaults.TIMEOUT,
        retryCount = RainSolverTransportDefaults.RETRY_COUNT,
        retryDelay = RainSolverTransportDefaults.RETRY_DELAY,
        pollingTimeout = RainSolverTransportDefaults.POLLING_TIMEOUT,
        pollingInterval = RainSolverTransportDefaults.POLLING_INTERVAL,
        retryCountNext = RainSolverTransportDefaults.RETRY_COUNT_NEXT,
    } = config;
    return (({ chain }) => {
        return createTransport({
            key,
            name,
            timeout,
            retryDelay,
            retryCount,
            type: "RainSolverTransport",
            async request(args, options) {
                const req = async (tryNextCount: number): Promise<any> => {
                    try {
                        const transport = await state.nextRpc({
                            timeout: pollingTimeout,
                            pollingInterval,
                        });
                        // cancel inner transport retry when success rate is below 20% threshold
                        const resolvedRetryCount =
                            state.metrics[state.lastUsedUrl].progress.successRate > 2000
                                ? retryCount
                                : 0;
                        return await transport({
                            chain,
                            retryCount: resolvedRetryCount,
                        }).request(args, {
                            ...options,
                            retryDelay,
                            retryCount: resolvedRetryCount,
                        });
                    } catch (error: any) {
                        if (shouldThrow(error)) throw error;
                        if (tryNextCount) return req(tryNextCount - 1);
                        throw error;
                    }
                };
                return req(retryCountNext);
            },
        });
    }) as RainSolverTransport;
}
