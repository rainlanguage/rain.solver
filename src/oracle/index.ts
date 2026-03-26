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
 * Encodes as: abi.encode(OrderV4, uint256, uint256, address)
 *
 * Uses the same struct shape as ABI.Orderbook.V5.OrderV4 / IOV2 / EvaluableV4.
 */
const oracleSingleAbiParams = [
    {
        name: "order",
        type: "tuple",
        components: [
            { name: "owner", type: "address" },
            {
                name: "evaluable",
                type: "tuple",
                components: [
                    { name: "interpreter", type: "address" },
                    { name: "store", type: "address" },
                    { name: "bytecode", type: "bytes" },
                ],
            },
            {
                name: "validInputs",
                type: "tuple[]",
                components: [
                    { name: "token", type: "address" },
                    { name: "vaultId", type: "bytes32" },
                ],
            },
            {
                name: "validOutputs",
                type: "tuple[]",
                components: [
                    { name: "token", type: "address" },
                    { name: "vaultId", type: "bytes32" },
                ],
            },
            { name: "nonce", type: "bytes32" },
        ],
    },
    { name: "inputIOIndex", type: "uint256" },
    { name: "outputIOIndex", type: "uint256" },
    { name: "counterparty", type: "address" },
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
        orderStruct,
        BigInt(request.inputIOIndex),
        BigInt(request.outputIOIndex),
        request.counterparty,
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

    // Validate shape of response
    if (
        typeof json !== "object" ||
        json === null ||
        typeof (json as any).signer !== "string" ||
        !Array.isArray((json as any).context) ||
        typeof (json as any).signature !== "string"
    ) {
        recordOracleFailure(healthMap, url);
        return Result.err("Oracle response is not a valid SignedContextV1");
    }

    recordOracleSuccess(healthMap, url);
    return Result.ok(json);
}
