import { RainSolverBaseError } from "../error";
import { SushiRouterError } from "./sushi/error";
import { BalancerRouterError } from "./balancer/error";
import { StabullRouterError } from "./stabull/error";

// re-export all error types from sushi, balancer and stabull
export * from "./sushi/error";
export * from "./stabull/error";
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
    stabullError?: StabullRouterError;

    constructor(
        message: string,
        type: RainSolverRouterErrorType,
        sushiError?: SushiRouterError,
        balancerError?: BalancerRouterError,
        stabullError?: StabullRouterError,
    ) {
        const msgs = [message];
        if (sushiError) {
            msgs.push(`SushiRouterError: ${sushiError.message}`);
        }
        if (balancerError) {
            msgs.push(`BalancerRouterError: ${balancerError.message}`);
        }
        if (stabullError) {
            msgs.push(`StabullRouterError: ${stabullError.message}`);
        }
        super(msgs.join("\n"));
        this.typ = type;
        this.sushiError = sushiError;
        this.balancerError = balancerError;
        this.stabullError = stabullError;
        this.name = "RainSolverRouterError";
    }
}
