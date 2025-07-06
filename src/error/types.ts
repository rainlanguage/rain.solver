import { parseAbiItem } from "viem";

/** Solidity hex string selector pattern */
export const SELECTOR_PATTERN = /^0x[a-fA-F0-9]{8}$/;

/** openchain.xyz selector registry url */
export const SELECTOR_REGISTRY = "https://api.openchain.xyz/signature-database/v1/lookup" as const;

/** Solidity panic error selector */
export const PANIC_SELECTOR = "0x4e487b71" as const;

/** Panic error signature */
export const PANIC_SIG = "error Panic(uint256)" as const;

/** Solidity panic error ABI */
export const PANIC_ABI = parseAbiItem(PANIC_SIG);

/**
 * Solidity panic error code/reasons
 * https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
 */
export const PANIC_REASONS = {
    0x00: "generic compiler inserted panics",
    0x01: "asserted with an argument that evaluates to false",
    0x11: "an arithmetic operation resulted in underflow or overflow outside of an unchecked { ... } block",
    0x12: "divide or modulo by zero (e.g. 5 / 0 or 23 % 0)",
    0x21: "converted a value that is too big or negative into an enum type",
    0x22: "accessed a storage byte array that is incorrectly encoded",
    0x31: "called .pop() on an empty array",
    0x32: "accessed an array, bytesN or an array slice at an out-of-bounds or negative index (i.e. x[i] where i >= x.length or i < 0)",
    0x41: "allocated too much memory or created an array that is too large",
    0x51: "called a zero-initialized variable of internal function type",
} as const;

/** Specifies error severity for otel reports */
export enum ErrorSeverity {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
}

/** Known error msgs from trade execution */
export const KnownErrors = [
    "unknown sender",
    "minimumSenderOutput",
    "minimum sender output",
    "MinimalOutputBalanceViolation",
] as const;

/** Represents a decoded solidity error type */
export type DecodedErrorType = {
    name: string;
    args: any[];
};

/** Raw error type returned from rpc call */
export type RawRpcError = {
    code: number;
    message: string;
    data?: string | number;
};

/** Represents a revert error that happened for a transaction */
export type TxRevertError = {
    raw: RawRpcError;
    decoded?: DecodedErrorType;
};
