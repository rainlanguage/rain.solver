import { encodeAbiParameters, hexToBytes } from "viem";
import { OracleManager } from "./manager";

export { OracleManager } from "./manager";

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

/** Per-request timeout */
const ORACLE_TIMEOUT_MS = 5_000;

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

/**
 * Fetch signed contexts from an oracle endpoint (batch format).
 *
 * POSTs abi.encode((OrderV4, uint256, uint256, address)[]) and expects
 * a JSON array of SignedContextV1 objects back, matching request length.
 *
 * Single attempt with a hard timeout — no retries, no in-loop delays.
 * Uses the provided OracleManager to track failures and skip oracles
 * in cooloff.
 *
 * @param url - Oracle endpoint URL
 * @param orders - Array of order requests (usually 1 per IO pair)
 * @param oracleManager - Health tracker for cooloff management
 * @returns Array of signed contexts in the same order as the request
 */
export async function fetchSignedContext(
    url: string,
    orders: OracleOrderRequest[],
    oracleManager: OracleManager,
): Promise<SignedContextV1[]> {
    // Skip immediately if oracle is in cooloff
    if (oracleManager.isInCooloff(url)) {
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

    // Single attempt — fail fast, no retries
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
        oracleManager.recordFailure(url);
        throw err;
    } finally {
        clearTimeout(timeout);
    }

    // Validate response
    if (!Array.isArray(json)) {
        oracleManager.recordFailure(url);
        throw new Error("Oracle response must be an array");
    }

    if (json.length !== orders.length) {
        oracleManager.recordFailure(url);
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
            oracleManager.recordFailure(url);
            throw new Error(`Oracle response[${i}] is not a valid SignedContextV1`);
        }
        return entry as SignedContextV1;
    });

    oracleManager.recordSuccess(url);
    return contexts;
}
