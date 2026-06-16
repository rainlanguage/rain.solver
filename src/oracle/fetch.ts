import axios from "axios";
import { Result } from "../common";
import { SignedContextV2 } from "../order/types/v4";
import { OracleError, OracleErrorType } from "./error";
import { encodeAbiParameters, hexToBytes } from "viem";
import {
    OracleConstants,
    OracleHealthMap,
    OracleOrderRequest,
    OracleSingleAbiParams,
} from "./types";

/**
 * Fetch signed context from an oracle endpoint (single request format).
 *
 * POSTs abi.encode(OrderV4, uint256, uint256, address) and expects
 * a JSON SignedContextV2 object back.
 *
 * Single attempt with a hard timeout — no retries, no in-loop delays.
 * Uses the provided health map for cooloff tracking.
 *
 * @param url - Oracle URL
 * @param request - Order to request orcale for
 * @param healthMap - Oracle endpoint health tracking for cooloff
 */
export async function fetchSignedContext(
    url: string,
    request: OracleOrderRequest,
    healthMap: OracleHealthMap,
): Promise<Result<SignedContextV2, OracleError>> {
    if (!OracleConstants.isKnown(url)) {
        return Result.err(
            new OracleError(`Oracle ${url} is unknown, skipping`, OracleErrorType.Cooloff),
        );
    }

    if (isInCooloff(healthMap, url)) {
        return Result.err(
            new OracleError(`Oracle ${url} is in cooloff, skipping`, OracleErrorType.Cooloff),
        );
    }

    const encoded = encodeAbiParameters(OracleSingleAbiParams, [
        [
            {
                order: request.order,
                inputIOIndex: BigInt(request.inputIOIndex),
                outputIOIndex: BigInt(request.outputIOIndex),
                counterparty: request.counterparty,
            },
        ],
    ]);
    const body = hexToBytes(encoded);

    try {
        const response = await axios.post(url, body, {
            headers: {
                "Content-Type": "application/octet-stream",
            },
            timeout: OracleConstants.ORACLE_TIMEOUT_MS,
            responseType: "json",
        });

        // Validate shape of response
        if (SignedContextV2.isValidList(response.data)) {
            recordOracleSuccess(healthMap, url);
            return Result.ok(response.data[0]);
        } else {
            recordOracleFailure(healthMap, url);
            return Result.err(
                new OracleError(
                    "Oracle response is not a valid SignedContextV2 list",
                    OracleErrorType.InvalidResponseType,
                    response.data,
                ),
            );
        }
    } catch (err) {
        recordOracleFailure(healthMap, url);

        // default error if not AxiosError type
        let error = new OracleError(
            `Oracle fetch error: ${err instanceof Error ? err.message : String(err)}`,
            OracleErrorType.FetchError,
            err,
        );

        if (axios.isAxiosError(err)) {
            if (err.response) {
                error = new OracleError(
                    `Oracle request failed with: ${err.response.status} ${err.response.statusText}`,
                    OracleErrorType.RequestFailed,
                    err,
                );
            }
        }
        return Result.err(error);
    }
}

/**
 * Extract oracle URL from order meta bytes.
 *
 * Searches for the RaindexSignedContextOracleV1 CBOR item identified by
 * magic number 0xff7a1507ba4419ca and extracts the URL payload.
 *
 * @param metaHex - Hex string of meta bytes (e.g. "0x1234...")
 * @returns Oracle URL if found, null otherwise
 */
export function extractOracleUrl(metaHex: string): string | undefined {
    if (!metaHex) return undefined;
    metaHex = metaHex.toLowerCase();
    const hex = metaHex.startsWith("0x") ? metaHex.slice(2) : metaHex;

    const magicIdx = hex.indexOf(OracleConstants.RaindexSignedContextOracleV1);
    if (magicIdx === -1) return undefined;

    // The URL is encoded as a CBOR byte string before the magic in the same
    // CBOR map: a2 00 58<len> <url_bytes> 01 1b<magic>
    // Find "https://" or "http://" in hex before the magic
    const httpsHex = Buffer.from("https://").toString("hex");
    const httpHex = Buffer.from("http://").toString("hex");

    const searchRegion = hex.substring(0, magicIdx);
    let urlStartIdx = searchRegion.lastIndexOf(httpsHex);
    if (urlStartIdx === -1) urlStartIdx = searchRegion.lastIndexOf(httpHex);
    if (urlStartIdx === -1) return undefined;

    // URL ends before the "01 1b" marker (CBOR key 1, uint64 prefix) that precedes the magic
    const endMarker = "011b";
    const endIdx = searchRegion.lastIndexOf(endMarker);
    if (endIdx === -1 || endIdx < urlStartIdx) return undefined;

    const urlHex = hex.substring(urlStartIdx, endIdx);
    try {
        return Buffer.from(urlHex, "hex").toString("utf8");
    } catch {
        return undefined;
    }
}

/** Checks if the given oracle URL is in cooloff period or not */
export function isInCooloff(healthMap: OracleHealthMap, url: string): boolean {
    const state = healthMap.get(url);
    if (!state || state.cooloffUntil === 0) return false;
    if (Date.now() >= state.cooloffUntil) {
        state.cooloffUntil = 0;
        return false;
    }
    return true;
}

/** Records the sucess in orcale health map */
export function recordOracleSuccess(healthMap: OracleHealthMap, url: string) {
    healthMap.set(url, { consecutiveFailures: 0, cooloffUntil: 0 });
}

/** Records the failure in orcale health map */
export function recordOracleFailure(healthMap: OracleHealthMap, url: string) {
    const state = healthMap.get(url) ?? { consecutiveFailures: 0, cooloffUntil: 0 };
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= OracleConstants.COOLOFF_THRESHOLD) {
        state.cooloffUntil = Date.now() + OracleConstants.COOLOFF_DURATION_MS;
        // console.warn(
        //     `Oracle ${url} entered cooloff for ${COOLOFF_DURATION_MS / 1000}s ` +
        //         `after ${state.consecutiveFailures} consecutive failures`,
        // );
    }
    healthMap.set(url, state);
}
