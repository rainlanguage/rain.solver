/**
 * Enumerates the possible error types that can occur within the Rain Solver application.
 * This enum is used to categorize and identify specific error scenarios,
 * enabling more precise error handling and reporting throughout the application.
 */
export enum RainSolverErrorType {
    AppOptionsValidationError = "AppOptionsValidationError",
    YamlParseError = "YamlParseError",
    ReadFileError = "ReadFileError",
}

/**
 * Represents a custom error type for the Rain Solver system.
 *
 * This error class extends the native `Error` object, providing additional context
 * through a specific error type and an optional cause. It is intended to be used
 * for all error handling within the Rain Solver domain, allowing for more granular
 * error categorization and debugging.
 *
 * @remarks
 * The `type` property indicates the specific category of the error, as defined by
 * the `RainSolverErrorType` enum. The optional `cause` property can be used
 * to attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * throw new RainSolverError("Invalid input", RainSolverErrorType, originalError);
 * ```
 */
export class RainSolverError extends Error {
    type: RainSolverErrorType;
    cause?: any;
    constructor(message: string, type: RainSolverErrorType, cause?: any) {
        super(message);
        this.type = type;
        this.cause = cause;
        this.name = "RainSolverError";
    }
}

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
