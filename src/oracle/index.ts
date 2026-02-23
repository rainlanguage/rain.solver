import { encodeAbiParameters, hexToBytes } from "viem";

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
// Retry & cooloff configuration
// ---------------------------------------------------------------------------

/** Per-request timeout */
const ORACLE_TIMEOUT_MS = 5_000;
/** Max retries per request (total attempts = MAX_RETRIES + 1) */
const MAX_RETRIES = 2;
/** Base delay between retries (doubled each attempt) */
const RETRY_BASE_DELAY_MS = 500;
/** How long to skip a failing oracle after repeated failures */
const COOLOFF_DURATION_MS = 5 * 60 * 1_000; // 5 minutes
/** Number of consecutive failures before entering cooloff */
const COOLOFF_THRESHOLD = 3;

/** Tracks per-URL failure counts and cooloff deadlines */
interface OracleHealthState {
    consecutiveFailures: number;
    cooloffUntil: number; // unix ms, 0 = not cooling off
}

const oracleHealth: Map<string, OracleHealthState> = new Map();

function getHealth(url: string): OracleHealthState {
    let state = oracleHealth.get(url);
    if (!state) {
        state = { consecutiveFailures: 0, cooloffUntil: 0 };
        oracleHealth.set(url, state);
    }
    return state;
}

function recordSuccess(url: string) {
    const state = getHealth(url);
    state.consecutiveFailures = 0;
    state.cooloffUntil = 0;
}

function recordFailure(url: string) {
    const state = getHealth(url);
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= COOLOFF_THRESHOLD) {
        state.cooloffUntil = Date.now() + COOLOFF_DURATION_MS;
        console.warn(
            `Oracle ${url} entered cooloff for ${COOLOFF_DURATION_MS / 1000}s after ${state.consecutiveFailures} consecutive failures`,
        );
    }
}

function isInCooloff(url: string): boolean {
    const state = getHealth(url);
    if (state.cooloffUntil === 0) return false;
    if (Date.now() >= state.cooloffUntil) {
        // Cooloff expired — reset but keep failure count so next failure
        // re-enters cooloff immediately
        state.cooloffUntil = 0;
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// ABI encoding
// ---------------------------------------------------------------------------

/**
 * ABI parameter definition for the batch oracle request body.
 * Encodes as: abi.encode((OrderV4, uint256, uint256, address)[])
 */
const oracleBatchAbiParams = [
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

// ---------------------------------------------------------------------------
// Core fetch with retry
// ---------------------------------------------------------------------------

/** Sleep helper */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single attempt to fetch signed contexts from an oracle endpoint.
 */
async function fetchOnce(url: string, body: Uint8Array): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ORACLE_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Oracle request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

/**
 * Fetch with exponential backoff retry.
 */
async function fetchWithRetry(url: string, body: Uint8Array): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fetchOnce(url, body);
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < MAX_RETRIES) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch signed contexts from an oracle endpoint (batch format).
 *
 * POSTs abi.encode((OrderV4, uint256, uint256, address)[]) and expects
 * a JSON array of SignedContextV1 objects back, matching request length.
 *
 * Includes:
 * - Exponential backoff retry (up to MAX_RETRIES)
 * - Per-URL cooloff: after COOLOFF_THRESHOLD consecutive failures, the URL
 *   is skipped for COOLOFF_DURATION_MS before being retried
 *
 * @param url - Oracle endpoint URL
 * @param orders - Array of order requests (usually 1 per IO pair)
 * @returns Array of signed contexts in the same order as the request
 */
export async function fetchSignedContext(
    url: string,
    orders: OracleOrderRequest[],
): Promise<SignedContextV1[]> {
    // Skip if oracle is in cooloff
    if (isInCooloff(url)) {
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

    let json: unknown;
    try {
        json = await fetchWithRetry(url, body);
    } catch (err) {
        recordFailure(url);
        throw err;
    }

    // Validate response
    if (!Array.isArray(json)) {
        recordFailure(url);
        throw new Error("Oracle response must be an array");
    }

    if (json.length !== orders.length) {
        recordFailure(url);
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
            throw new Error(`Oracle response[${i}] is not a valid SignedContextV1`);
        }
        return entry as SignedContextV1;
    });

    // Success — clear failure state
    recordSuccess(url);

    return contexts;
}
