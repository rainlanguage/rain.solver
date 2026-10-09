import type { Order } from "../order";

/** Provides constants and functionalities for interacting with oracles */
export namespace OracleConstants {
    /** RaindexSignedContextOracleV1 magic number */
    export const RaindexSignedContextOracleV1 = "ff7a1507ba4419ca" as const;

    /** Consecutive failures before entering cooloff */
    export const COOLOFF_THRESHOLD = 3 as const;
    /** Per-request timeout */
    export const ORACLE_TIMEOUT_MS = 5_000 as const;
    /** How long to skip a failing oracle (ms) */
    export const COOLOFF_DURATION_MS = 3 * 60 * 1_000;
    /** How long to skip a failing oracle (ms) for an owner with max profile */
    export const COOLOFF_MAX_PROFILE_OWNER = 0;

    /** List of known oracle URLs */
    export const KnownUrls = [
        "https://st0x-oracle-server.fly.dev/context",
        "https://oracle.t0trade.com/context",
        "https://oracle-robinhood.t0trade.com/context",
    ] as const;

    /** Domains that any of their subdomains is a known oracle host, over https only */
    export const KnownDomains = ["t0trade.com"] as const;

    /**
     * Determines if the given oracle url is known, that is either one of the known
     * urls or an https url on a known domain or any subdomain of it, the host is
     * checked as parsed so a lookalike host like t0trade.com.evil.com is rejected
     * @param url - The oracle url
     */
    export function isKnown(url: string): boolean {
        if (KnownUrls.some((v) => url.startsWith(v))) {
            return true;
        }
        try {
            const { protocol, hostname } = new URL(url);
            return (
                protocol === "https:" &&
                KnownDomains.some((v) => hostname === v || hostname.endsWith(`.${v}`))
            );
        } catch {
            return false;
        }
    }
}

/**
 * Daily market hours (UTC) of the known oracles, as minutes from 00:00 UTC, the known
 * oracles serve signed context only inside these hours on weekdays (monday to friday),
 * weekends are always closed, from saturday 00:00 UTC until sunday 23:59 UTC
 */
export type OracleMarketHours = {
    /** Minute of the day (UTC) the market opens at, inclusive */
    open: number;
    /** Minute of the day (UTC) the market closes at, inclusive, so the market is open until the end of this minute */
    close: number;
};
export namespace OracleMarketHours {
    /** Default daily market hours, from 08:00 UTC until 23:59 UTC */
    export const DEFAULT: Readonly<OracleMarketHours> = { open: 8 * 60, close: 23 * 60 + 59 };

    /**
     * Determines if the known oracles market is open at the given time, that is a
     * weekday inside the daily market hours, weekends are always closed
     * @param hours - The daily market hours
     * @param time - The time (ms) to check at, defaults to now
     */
    export function isOpen(hours: OracleMarketHours, time = Date.now()): boolean {
        const date = new Date(time);
        const day = date.getUTCDay();
        if (day === 0 || day === 6) return false; // sunday or saturday

        // convert the open and close times to the current day times (UTC),
        // the close time is inclusive so the market is open for its whole minute
        const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
        const open = dayStart + hours.open * 60_000;
        const close = dayStart + (hours.close + 1) * 60_000;
        return time >= open && time < close;
    }
}

/** Represents the health state of an oracle for an owner */
export type OracleHealthState = {
    /** Number of consecutive failed fetches */
    consecutiveFailures: number;
    /** Timestamp (ms) until which the oracle is in cooloff, 0 means no cooloff */
    cooloffUntil: number;
};

/** Keeps oracles health state per oracle url and owner */
export type OracleHealthMap = Map<string, OracleHealthState>;
export namespace OracleHealthMap {
    /** Builds the health map key for the given oracle url and owner */
    export function key(url: string, owner: string): string {
        return `${url}-${owner.toLowerCase()}`;
    }

    /**
     * Gets the health state for the given oracle url and owner,
     * creates and stores a fresh state if none exists yet
     */
    export function getOrCreate(
        healthMap: OracleHealthMap,
        url: string,
        owner: string,
    ): OracleHealthState {
        const k = key(url, owner);
        let state = healthMap.get(k);
        if (!state) {
            state = { consecutiveFailures: 0, cooloffUntil: 0 };
            healthMap.set(k, state);
        }
        return state;
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
