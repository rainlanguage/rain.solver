import { encodeAbiParameters, hexToBytes } from "viem";

export { fetchOracleContext } from "./fetch";

/**
 * Extract oracle URL from order meta bytes.
 *
 * TODO: Replace with SDK's RaindexOrder.extractOracleUrl() once the wasm
 * package includes it. Pending rain.orderbook PR #2478.
 *
 * @param metaHex - Hex string of meta bytes (e.g. "0x1234...")
 * @returns Oracle URL if found, null otherwise
 */
export function extractOracleUrl(metaHex: string): string | null {
    // TODO: Implement CBOR decoding to find RaindexSignedContextOracleV1
    // magic number 0xff7a1507ba4419ca and extract URL.
    return null;
}

/**
 * Signed context response from oracle endpoint.
 * Maps directly to SignedContextV1 in the orderbook contract.
 */
export interface SignedContextV1 {
    signer: string;
    context: string[];
    signature: string;
}

/**
 * Order details for an oracle request entry.
 */
export interface OracleOrderRequest {
    order: {
        owner: string;
        evaluable: { interpreter: string; store: string; bytecode: string };
        validInputs: { token: string; vaultId: string }[];
        validOutputs: { token: string; vaultId: string }[];
        nonce: string;
    };
    inputIOIndex: number;
    outputIOIndex: number;
    counterparty: string;
}

// ---------------------------------------------------------------------------
// Oracle health / cooloff helpers
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
 * ABI parameter definition for the batch oracle request body.
 * Encodes as: abi.encode((OrderV4, uint256, uint256, address)[])
 */
export const oracleBatchAbiParams = [
    {
        type: "tuple[]",
        components: [
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
        ],
    },
] as const;

/**
 * Fetch signed contexts from an oracle endpoint (batch format).
 *
 * POSTs abi.encode((OrderV4, uint256, uint256, address)[]) and expects
 * a JSON array of SignedContextV1 objects back, matching request length.
 *
 * Single attempt with a hard timeout — no retries, no in-loop delays.
 * Uses the provided health map for cooloff tracking.
 */
export async function fetchSignedContext(
    url: string,
    orders: OracleOrderRequest[],
    healthMap: OracleHealthMap,
): Promise<SignedContextV1[]> {
    if (isInCooloff(healthMap, url)) {
        throw new Error(`Oracle ${url} is in cooloff, skipping`);
    }

    const tuples = orders.map((req) => ({
        order: req.order,
        inputIOIndex: BigInt(req.inputIOIndex),
        outputIOIndex: BigInt(req.outputIOIndex),
        counterparty: req.counterparty as `0x${string}`,
    }));

    const encoded = encodeAbiParameters(oracleBatchAbiParams, [tuples]);
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
            throw new Error(`Oracle request failed: ${response.status} ${response.statusText}`);
        }

        json = await response.json();
    } catch (err) {
        recordOracleFailure(healthMap, url);
        throw err;
    } finally {
        clearTimeout(timeout);
    }

    if (!Array.isArray(json)) {
        recordOracleFailure(healthMap, url);
        throw new Error("Oracle response must be an array");
    }

    if (json.length !== orders.length) {
        recordOracleFailure(healthMap, url);
        throw new Error(
            `Oracle response length (${json.length}) does not match request length (${orders.length})`,
        );
    }

    const contexts: SignedContextV1[] = json.map((entry: unknown, i: number) => {
        if (
            typeof entry !== "object" ||
            entry === null ||
            typeof (entry as any).signer !== "string" ||
            !Array.isArray((entry as any).context) ||
            typeof (entry as any).signature !== "string"
        ) {
            recordOracleFailure(healthMap, url);
            throw new Error(`Oracle response[${i}] is not a valid SignedContextV1`);
        }
        return entry as SignedContextV1;
    });

    recordOracleSuccess(healthMap, url);
    return contexts;
}
