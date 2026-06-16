import { RainSolverBaseError } from "../error";

/** Enumerates the possible error types that can occur within the Oracle functionalities */
export enum OracleErrorType {
    UnknownUrl,
    Cooloff,
    RequestFailed,
    FetchError,
    InvalidResponseType,
}

/**
 * Represents an error type for the Oracle functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `OracleErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new OracleError("msg", OracleErrorType);
 *
 * // with cause
 * throw new OracleError("msg", OracleErrorType, originalError);
 * ```
 */
export class OracleError extends RainSolverBaseError {
    type: OracleErrorType;
    constructor(message: string, type: OracleErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "OracleError";
    }
}
