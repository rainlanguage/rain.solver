import { RainSolverBaseError } from "../../error";

/** Enumerates the possible error types that can occur within the Balancer Router functionalities */
export enum BalancerRouterErrorType {
    UnsupportedChain,
    NoRouteFound,
    FetchFailed,
    SwapQueryFailed,
    WasmEncodedError,
}

/**
 * Represents an error type for the Balancer Router functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `BalancerRouterErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new BalancerRouterError("msg", BalancerRouterErrorType);
 *
 * // with cause
 * throw new BalancerRouterError("msg", BalancerRouterErrorType, originalError);
 * ```
 */
export class BalancerRouterError extends RainSolverBaseError {
    type: BalancerRouterErrorType;
    constructor(message: string, type: BalancerRouterErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "BalancerRouterError";
    }
}
