import { AxiosError } from "axios";
import { RainSolverError } from "./types";
import { RawTransaction } from "../signer";
import { evaluateGasSufficiency, parseRevertError, RawRpcError } from ".";
import {
    BaseError,
    TimeoutError,
    FeeCapTooLowError,
    TransactionReceipt,
    ExecutionRevertedError,
    InsufficientFundsError,
    TransactionNotFoundError,
    UserRejectedRequestError,
    TransactionRejectedRpcError,
    TransactionReceiptNotFoundError,
    WaitForTransactionReceiptTimeoutError,
} from "viem";

/**
 * Constructs a snapshot from the given error which is mainly used for reporting
 * @param header - The header to include in the snapshot
 * @param err - The error to construct snapshot from
 * @param context - Additional context about the error
 */
export async function errorSnapshot(
    header: string,
    err: any,
    context?: {
        receipt: TransactionReceipt;
        rawtx: RawTransaction;
        signerBalance: bigint;
        frontrun?: string;
    },
): Promise<string> {
    const message = [header];
    if (err instanceof RainSolverError) {
        if (err.cause) message.push(await errorSnapshot(err.message, err.cause));
        else message.push(`Reason: ${err.message}`);
    } else if (err instanceof BaseError) {
        const org = getRpcError(err);
        if (err.shortMessage) message.push(`Reason: ${err.shortMessage}`);
        if (err.name) message.push(`Error: ${err.name}`);
        if (err.details) message.push(`Details: ${err.details}`);
        if (typeof org.code === "number") message.push(`RPC Error Code: ${org.code}`);
        if (typeof org.message === "string") message.push(`RPC Error Msg: ${org.message}`);
        if (message.some((v) => v.includes("unknown reason") || v.includes("execution reverted"))) {
            const { raw, decoded } = await parseRevertError(err);
            if (decoded) {
                message.push("Error Name: " + decoded.name);
                if (decoded.args.length) {
                    message.push("Error Args: " + JSON.stringify(decoded.args));
                }
            } else if (raw.data) {
                message.push("Error Raw Data: " + raw.data);
            } else if (context) {
                const gasErr = evaluateGasSufficiency(
                    context.receipt,
                    context.rawtx,
                    context.signerBalance,
                );
                if (gasErr) {
                    message.push("Gas Error: " + gasErr);
                }
            } else {
                message.push("Comment: Found no additional info");
            }
            if (context?.frontrun) {
                message.push("Actual Cause: " + context.frontrun);
            }
        }
    } else if (err instanceof AxiosError) {
        if (err.message) {
            message.push("Reason: " + err.message);
        }
        if (err.code) {
            message.push("Code: " + err.code);
        }
    } else if (err instanceof Error) {
        if ("reason" in err) message.push("Reason: " + err.reason);
        else message.push("Reason: " + err.message);
    } else if (typeof err === "string") {
        message.push("Reason: " + err);
    } else {
        try {
            message.push("Reason: " + err.toString());
        } catch {
            message.push("Reason: unknown error type");
        }
    }
    return message.join("\n");
}

/**
 * Extracts original rpc error from the viem error
 * @param error - The error
 */
export function getRpcError(error: Error, breaker = 0): RawRpcError {
    const result: RawRpcError = {
        data: undefined,
        code: undefined,
        message: undefined,
    } as any;
    if (breaker > 10) {
        result.message = "Found no rpc error in the given viem error";
        return result;
    }
    if ("cause" in error) {
        const org = getRpcError(error.cause as any, breaker + 1);
        if ("code" in org && typeof org.code === "number") {
            result.code = org.code;
        }
        if ("message" in org && typeof org.message === "string") {
            result.message = org.message;
        }
        if ("data" in org && (typeof org.data === "string" || typeof org.data === "number")) {
            result.data = org.data;
        }
    } else {
        if ("code" in error && typeof error.code === "number" && result.code === undefined) {
            result.code = error.code;
            // include msg only if code exists
            if (
                "message" in error &&
                typeof error.message === "string" &&
                result.message === undefined
            ) {
                result.message = error.message;
            }
        }
        if ("data" in error && (typeof error.data === "string" || typeof error.data === "number")) {
            result.data = error.data;
            // include msg only if data exists
            if (
                "message" in error &&
                typeof error.message === "string" &&
                result.message === undefined
            ) {
                result.message = error.message;
            }
        }
    }
    return result;
}

/**
 * Checks if a viem BaseError is from eth node
 * @param err - The viem error
 */
export async function containsNodeError(err: BaseError, breaker = 0): Promise<boolean> {
    if (breaker > 25) return false; // avoid infinite loops if viem error is recursive
    try {
        const snapshot = await errorSnapshot("", err);
        const parsed = await parseRevertError(err);
        return (
            !!parsed.decoded ||
            !!parsed.raw.data ||
            err instanceof FeeCapTooLowError ||
            err instanceof ExecutionRevertedError ||
            err instanceof InsufficientFundsError ||
            ("code" in err && err.code === ExecutionRevertedError.code) ||
            (snapshot.includes("exceeds allowance") && !snapshot.includes("out of gas")) ||
            ("cause" in err && (await containsNodeError(err.cause as any, ++breaker)))
        );
    } catch (error) {
        return false;
    }
}

/**
 * Checks if a viem BaseError is timeout error
 * @param err - The viem error
 */
export function isTimeout(err: BaseError, breaker = 0): boolean {
    if (breaker > 25) return false; // avoid infinite loop if viem error is recursive
    try {
        return (
            err instanceof TimeoutError ||
            err instanceof TransactionNotFoundError ||
            err instanceof TransactionReceiptNotFoundError ||
            err instanceof WaitForTransactionReceiptTimeoutError ||
            ("cause" in err && isTimeout(err.cause as any, ++breaker))
        );
    } catch (error) {
        return false;
    }
}

/**
 * Determines if this fetch reponse is a throwable node error, this
 * is mainly used for determining success and failure rates of a rpc
 * @param error - The error thrown from rpc fetch hook
 */
export function shouldThrow(error: Error) {
    const msg: string[] = [];
    const org = getRpcError(error);
    if (typeof org.message === "string") {
        msg.push(org.message.toLowerCase());
    }
    msg.push(((error as any)?.name ?? "").toLowerCase());
    msg.push(((error as any)?.details ?? "").toLowerCase());
    msg.push(((error as any)?.shortMessage ?? "").toLowerCase());
    if (msg.some((v) => v.includes("execution reverted") || v.includes("unknown reason"))) {
        return true;
    }
    if (org.data !== undefined) return true;
    if (error instanceof ExecutionRevertedError) return true;
    if ("code" in error && typeof error.code === "number") {
        if (
            error.code === UserRejectedRequestError.code ||
            error.code === TransactionRejectedRpcError.code ||
            error.code === 5000 // CAIP UserRejectedRequestError
        )
            return true;
    }
    return false;
}
