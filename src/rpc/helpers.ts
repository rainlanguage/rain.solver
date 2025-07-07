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
 * @returns The index of the picked item from the array or NaN if out-of-range
 */
export function probablyPicksFrom(ranges: number[]): number {
    // pick a random int from [1, max] range
    const max = ranges.reduce((a, b) => a + Math.max(b, 10_000), 0);
    const pick = Math.floor(Math.random() * max) + 1;

    // we now match the selection rates against
    // picked random int to get picked index
    for (let i = 0; i < ranges.length; i++) {
        const offset = ranges.slice(0, i).reduce((a, b) => a + Math.max(b, 10_000), 0);
        const lowerBound = offset + 1;
        const upperBound = offset + ranges[i];
        if (lowerBound <= pick && pick <= upperBound) {
            return i;
        }
    }

    // out-of-range, picked value didnt match any of the items from the given list
    return NaN;
}
