import {
    ExecutionRevertedError,
    UserRejectedRequestError,
    TransactionRejectedRpcError,
} from "viem";

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

/**
 * Probably picks an item from the given array of success rates as probablity ranges
 * which are in 2 fixed point decimalss
 * @param ranges - The array of success rates as ranges to randomly select from
 * @param weights - The array of weights to adjust the probability of each item being picked, should be in [0, 1] range
 * @returns The index of the picked item from the array or NaN if out-of-range
 */
export function probablyPicksFrom(ranges: number[], weights: number[]): number {
    // pick a random int from [1, max] range
    const max = ranges.reduce((a, b, i) => a + Math.max(b, Math.ceil(10_000 * weights[i])), 0);
    const pick = Math.floor(Math.random() * max) + 1;

    // we now match the selection rates against
    // picked random int to get picked index
    for (let i = 0; i < ranges.length; i++) {
        const weightsSlice = weights.slice(0, i);
        const offset = ranges
            .slice(0, i)
            .reduce((a, b, j) => a + Math.max(b, Math.ceil(10_000 * weightsSlice[j])), 0);
        const lowerBound = offset + 1;
        const upperBound = offset + ranges[i];
        if (lowerBound <= pick && pick <= upperBound) {
            return i;
        }
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
