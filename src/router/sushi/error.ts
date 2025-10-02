import { RainSolverBaseError } from "../../error";

/** Enumerates the possible error types that can occur within the Sushi Router functionalities */
export enum SushiRouterErrorType {
    InitializationError,
    NoRouteFound,
    FetchFailed,
    WasmEncodedError,
    UndefinedTradeDestinationAddress,
}

/**
 * Represents an error type for the Sushi Router functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `SushiRouterErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new SushiRouterError("msg", SushiRouterErrorType);
 *
 * // with cause
 * throw new SushiRouterError("msg", SushiRouterErrorType, originalError);
 * ```
 */
export class SushiRouterError extends RainSolverBaseError {
    type: SushiRouterErrorType;
    constructor(message: string, type: SushiRouterErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "SushiRouterError";
    }
}
