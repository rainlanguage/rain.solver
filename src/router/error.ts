import { RainSolverBaseError } from "../error";
import { SushiRouterError } from "./sushi/error";
import { BalancerRouterError } from "./balancer/error";

// re-export all error types from sushi and balancer
export * from "./sushi/error";
export * from "./balancer/error";

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
