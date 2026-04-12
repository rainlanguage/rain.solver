import { encodeAbiParameters, hexToBytes } from "viem";
import { Result } from "../common";
import { Order } from "../order/types";

export { fetchOracleContext } from "./fetch";

/**
 * Extract oracle URL from order meta bytes.
 *
 * Searches for the RaindexSignedContextOracleV1 CBOR item identified by
 * magic number 0xff7a1507ba4419ca and extracts the URL payload.
 *
 * @param metaHex - Hex string of meta bytes (e.g. "0x1234...")
 * @returns Oracle URL if found, null otherwise
 */
export function extractOracleUrl(metaHex: string): string | null {
    if (!metaHex) return null;
    const hex = metaHex.startsWith("0x") ? metaHex.slice(2) : metaHex;

    // RaindexSignedContextOracleV1 magic number
    const magicHex = "ff7a1507ba4419ca";
    const magicIdx = hex.indexOf(magicHex);
    if (magicIdx === -1) return null;

    // The URL is encoded as a CBOR byte string before the magic in the same
    // CBOR map: a2 00 58<len> <url_bytes> 01 1b<magic>
    // Find "https://" or "http://" in hex before the magic
    const httpsHex = Buffer.from("https://").toString("hex");
    const httpHex = Buffer.from("http://").toString("hex");

    const searchRegion = hex.substring(0, magicIdx);
    let urlStartIdx = searchRegion.lastIndexOf(httpsHex);
    if (urlStartIdx === -1) urlStartIdx = searchRegion.lastIndexOf(httpHex);
    if (urlStartIdx === -1) return null;

    // URL ends before the "01 1b" marker (CBOR key 1, uint64 prefix) that precedes the magic
    const endMarker = "011b";
    const endIdx = searchRegion.lastIndexOf(endMarker);
    if (endIdx === -1 || endIdx < urlStartIdx) return null;

    const urlHex = hex.substring(urlStartIdx, endIdx);
    try {
        return Buffer.from(urlHex, "hex").toString("utf8");
    } catch {
        return null;
    }
}

/**
 * Oracle request entry — mirrors the spec's (OrderV4, uint256, uint256, address) tuple.
 * Only V4 orders support oracle signed context.
 */
export interface OracleOrderRequest {
    order: Order.V4;
    inputIOIndex: number;
    outputIOIndex: number;
    counterparty: `0x${string}`;
}

// ---------------------------------------------------------------------------
// Oracle health / cooloff
// ---------------------------------------------------------------------------

/** Per-request timeout */
export const ORACLE_TIMEOUT_MS = 5_000;
/** How long to skip a failing oracle (ms) */
export const COOLOFF_DURATION_MS = 5 * 60 * 1_000;
/** Consecutive failures before entering cooloff */
export const COOLOFF_THRESHOLD = 3;

export type OracleHealthMap = Map<string, { consecutiveFailures: number; cooloffUntil: number }>;

export function isInCooloff(healthMap: OracleHealthMap, url: string): boolean {
    const state = healthMap.get(url);
    if (!state || state.cooloffUntil === 0) return false;
    if (Date.now() >= state.cooloffUntil) {
        state.cooloffUntil = 0;
        return false;
    }
    return true;
}

export function recordOracleSuccess(healthMap: OracleHealthMap, url: string) {
    healthMap.set(url, { consecutiveFailures: 0, cooloffUntil: 0 });
}

export function recordOracleFailure(healthMap: OracleHealthMap, url: string) {
    const state = healthMap.get(url) ?? { consecutiveFailures: 0, cooloffUntil: 0 };
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= COOLOFF_THRESHOLD) {
        state.cooloffUntil = Date.now() + COOLOFF_DURATION_MS;
        console.warn(
            `Oracle ${url} entered cooloff for ${COOLOFF_DURATION_MS / 1000}s ` +
                `after ${state.consecutiveFailures} consecutive failures`,
        );
    }
    healthMap.set(url, state);
}

// ---------------------------------------------------------------------------
// ABI encoding
// ---------------------------------------------------------------------------

/**
 * ABI parameter definition for a single oracle request body.
 *
 * The oracle server (rain.orderbook and st0x-oracle-server) decodes
 * with alloy's `abi_decode()` which expects the body to be
 * `abi.encode((OrderV4, uint256, uint256, address))` — a SINGLE
 * wrapping tuple. viem's `encodeAbiParameters` with 4 top-level
 * params produces `abi.encode(OrderV4, uint256, uint256, address)`
 * (separate params, different byte layout). We fix the mismatch by
 * wrapping all fields in a single tuple parameter.
 */
const oracleSingleAbiParams = [
    {
        type: "tuple" as const,
        components: [
            {
                name: "order",
                type: "tuple" as const,
                components: [
                    { name: "owner", type: "address" as const },
                    {
                        name: "evaluable",
                        type: "tuple" as const,
                        components: [
                            { name: "interpreter", type: "address" as const },
                            { name: "store", type: "address" as const },
                            { name: "bytecode", type: "bytes" as const },
                        ],
                    },
                    {
                        name: "validInputs",
                        type: "tuple[]" as const,
                        components: [
                            { name: "token", type: "address" as const },
                            { name: "vaultId", type: "bytes32" as const },
                        ],
                    },
                    {
                        name: "validOutputs",
                        type: "tuple[]" as const,
                        components: [
                            { name: "token", type: "address" as const },
                            { name: "vaultId", type: "bytes32" as const },
                        ],
                    },
                    { name: "nonce", type: "bytes32" as const },
                ],
            },
            { name: "inputIOIndex", type: "uint256" as const },
            { name: "outputIOIndex", type: "uint256" as const },
            { name: "counterparty", type: "address" as const },
        ],
    },
] as const;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch signed context from an oracle endpoint (single request format).
 *
 * POSTs abi.encode(OrderV4, uint256, uint256, address) and expects
 * a JSON SignedContextV1 object back.
 *
 * Single attempt with a hard timeout — no retries, no in-loop delays.
 * Uses the provided health map for cooloff tracking.
 */
export async function fetchSignedContext(
    url: string,
    request: OracleOrderRequest,
    healthMap: OracleHealthMap,
): Promise<Result<any, string>> {
    if (isInCooloff(healthMap, url)) {
        return Result.err(`Oracle ${url} is in cooloff, skipping`);
    }

    // Strip the internal `type` discriminant before ABI encoding
    const { type: _type, ...orderStruct } = request.order;
    const encoded = encodeAbiParameters(oracleSingleAbiParams, [
        {
            order: orderStruct,
            inputIOIndex: BigInt(request.inputIOIndex),
            outputIOIndex: BigInt(request.outputIOIndex),
            counterparty: request.counterparty,
        },
    ]);
    const body = hexToBytes(encoded);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ORACLE_TIMEOUT_MS);

    let json: unknown;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
            signal: controller.signal,
        });

        if (!response.ok) {
            recordOracleFailure(healthMap, url);
            return Result.err(`Oracle request failed: ${response.status} ${response.statusText}`);
        }

        json = await response.json();
    } catch (err) {
        recordOracleFailure(healthMap, url);
        return Result.err(
            `Oracle fetch error: ${err instanceof Error ? err.message : String(err)}`,
        );
    } finally {
        clearTimeout(timeout);
    }

    // The oracle server returns a JSON **array** of SignedContextV1 objects
    // whose length matches the number of requests (we always send one).
    // Extract the first element so callers get a single SignedContextV1.
    let item: unknown = json;
    if (Array.isArray(json)) {
        if (json.length === 0) {
            recordOracleFailure(healthMap, url);
            return Result.err("Oracle returned empty array");
        }
        item = json[0];
    }

    // Validate shape of single SignedContextV1
    if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as any).signer !== "string" ||
        !Array.isArray((item as any).context) ||
        typeof (item as any).signature !== "string"
    ) {
        recordOracleFailure(healthMap, url);
        return Result.err("Oracle response is not a valid SignedContextV1");
    }

    recordOracleSuccess(healthMap, url);
    return Result.ok(item);
}
