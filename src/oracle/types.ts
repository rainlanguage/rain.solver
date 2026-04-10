import { Order } from "../order";

/** Provides constants and functionalities for interacting with oracles */
export namespace OracleConstants {
    /** RaindexSignedContextOracleV1 magic number */
    export const RaindexSignedContextOracleV1 = "ff7a1507ba4419ca" as const;

    /** Consecutive failures before entering cooloff */
    export const COOLOFF_THRESHOLD = 3 as const;
    /** Per-request timeout */
    export const ORACLE_TIMEOUT_MS = 5_000 as const;
    /** How long to skip a failing oracle (ms) */
    export const COOLOFF_DURATION_MS = 5 * 60 * 1_000;

    /** List of known oracle URLs */
    export const KnownUrls = ["https://st0x-oracle-server.fly.dev/context"] as const;

    export function isKnown(url: string): boolean {
        return KnownUrls.some((v) => v.startsWith(url));
    }
}

export type OracleHealthMap = Map<string, { consecutiveFailures: number; cooloffUntil: number }>;

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

/**
 * ABI parameter definition for a single oracle request body.
 * Encodes as: abi.encode((OrderV4, uint256, uint256, address)[])
 *
 * Uses the same struct shape as ABI.Orderbook.V5.OrderV4 / IOV2 / EvaluableV4.
 */
export const OracleSingleAbiParams = [
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
