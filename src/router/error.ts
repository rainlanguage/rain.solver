import { RainSolverBaseError } from "../error";

/** Enumerates the possible error types that can occur within the RainSolverRouter functionalities */
export enum RainSolverRouterErrorType {
    InitializationError,
    NoRouteFound,
    FetchFailed,
}

/**
 * Represents an error type for the RainSolverRouter functionalities.
 * This error class extends the `RainSolverBaseError` error class, with
 * the addition of optional properties to hold underlying errors from
 * the SushiRouter and BalancerRouter.
 *
 * @example
 * ```typescript
 * throw new RainSolverRouterError("msg", RainSolverRouterErrorType, SushiRouterError, BalancerRouterError);
 * ```
 */
export class RainSolverRouterError extends RainSolverBaseError {
    typ?: RainSolverRouterErrorType;
    sushiError?: SushiRouterError;
    balancerError?: BalancerRouterError;
    constructor(
        message: string,
        type: RainSolverRouterErrorType,
        sushiError?: SushiRouterError,
        balancerError?: BalancerRouterError,
    ) {
        const msgs = [message];
        if (sushiError) {
            msgs.push(`SushiRouterError: ${sushiError.message}`);
        }
        if (balancerError) {
            msgs.push(`BalancerRouterError: ${balancerError.message}`);
        }
        super(msgs.join("\n"));
        this.typ = type;
        this.sushiError = sushiError;
        this.balancerError = balancerError;
        this.name = "RainSolverRouterError";
    }
}

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
