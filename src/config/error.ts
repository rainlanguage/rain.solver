import { RainSolverBaseError } from "../error/types";

/** Enumerates the possible error types that can occur within the Rain Solver app options */
export enum AppOptionsErrorType {
    AppOptionsValidationError,
    YamlParseError,
    ReadFileError,
}

/**
 * Represents an error type for the Rain Solver app options.
 * This error class extends the `RainSolverError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `AppOptionsErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new AppOptionsError("msg", AppOptionsErrorType);
 *
 * // with cause
 * throw new AppOptionsError("msg", AppOptionsErrorType, originalError);
 * ```
 */
export class AppOptionsError extends RainSolverBaseError {
    type: AppOptionsErrorType;
    constructor(message: string, type: AppOptionsErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "AppOptionsError";
    }
}
