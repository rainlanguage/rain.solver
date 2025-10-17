import { RainSolverBaseError } from "../../error";

/** Enumerates the possible error types that can occur within the Stabull Router functionalities */
export enum StabullRouterErrorType {
    InitializationError,
    UnsupportedChain,
    NoRouteFound,
    FetchFailed,
    WasmEncodedError,
    UndefinedTradeDestinationAddress,
}

/**
 * Represents an error type for the Stabull Router functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `StabullRouterErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new StabullRouterError("msg", StabullRouterErrorType);
 *
 * // with cause
 * throw new StabullRouterError("msg", StabullRouterErrorType, originalError);
 * ```
 */
export class StabullRouterError extends RainSolverBaseError {
    type: StabullRouterErrorType;
    constructor(message: string, type: StabullRouterErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "StabullRouterError";
    }
}
