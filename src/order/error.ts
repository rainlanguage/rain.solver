import { RainSolverBaseError } from "../error";

/** Enumerates the possible error types that can occur within the OrderManager functionalities */
export enum OrderManagerErrorType {
    UndefinedTokenDecimals,
    DecodeAbiParametersError,
    WasmEncodedError,
}

/**
 * Represents an error type for the OrderManager functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `OrderManagerErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new OrderManagerError("msg", OrderManagerErrorType);
 *
 * // with cause
 * throw new OrderManagerError("msg", OrderManagerErrorType, originalError);
 * ```
 */
export class OrderManagerError extends RainSolverBaseError {
    type: OrderManagerErrorType;
    constructor(message: string, type: OrderManagerErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "OrderManagerError";
    }
}
