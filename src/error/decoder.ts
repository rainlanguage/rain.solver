import axios from "axios";
import assert from "assert";
import { Result } from "../common";
import { DecodedErrorType } from "./types";
import { decodeErrorResult, isHex } from "viem";

import { parseAbiItem } from "viem";

/** Solidity hex string selector pattern */
export const SELECTOR_PATTERN = /^0x[a-fA-F0-9]{8}$/;

/** openchain.xyz selector registry url */
export const SELECTOR_REGISTRY = "https://api.openchain.xyz/signature-database/v1/lookup" as const;

/** Solidity panic error selector */
export const PANIC_SELECTOR = "0x4e487b71" as const;

/** Panic error signature */
export const PANIC_SIG = "error Panic(uint256)" as const;

/** Solidity panic error ABI */
export const PANIC_ABI = parseAbiItem(PANIC_SIG);

/**
 * Solidity panic error code/reasons
 * https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
 */
export const PANIC_REASONS = {
    0x00: "generic compiler inserted panics",
    0x01: "asserted with an argument that evaluates to false",
    0x11: "an arithmetic operation resulted in underflow or overflow outside of an unchecked { ... } block",
    0x12: "divide or modulo by zero (e.g. 5 / 0 or 23 % 0)",
    0x21: "converted a value that is too big or negative into an enum type",
    0x22: "accessed a storage byte array that is incorrectly encoded",
    0x31: "called .pop() on an empty array",
    0x32: "accessed an array, bytesN or an array slice at an out-of-bounds or negative index (i.e. x[i] where i >= x.length or i < 0)",
    0x41: "allocated too much memory or created an array that is too large",
    0x51: "called a zero-initialized variable of internal function type",
} as const;

/** Selector abi/sig cache at runtime */
export const SelectorCache = new Map<string, string[]>();

/**
 * Tries to decode the given error data by running through known matching signatures
 * @param data - the error data
 */
export async function tryDecodeError(data: any): Promise<Result<DecodedErrorType, any>> {
    // check for validity of the data
    if (!isHex(data, { strict: true }) || data.length < 10) {
        return Result.err(new Error("invalid data, expected hex string with at least 32 bytes"));
    }

    // decode if the error is panic
    const selector = data.slice(0, 10).toLowerCase();
    if (selector === PANIC_SELECTOR) {
        return tryDecodePanic(data);
    }

    // search for the selector and return the decoded result if a match was found
    const signatures = await tryGetSignature(selector);
    if (signatures.isErr()) {
        return Result.err(signatures.error);
    }
    for (const sig of signatures.value) {
        try {
            const result = decodeErrorResult({ abi: [sig], data });
            return Result.ok({
                name: result.errorName,
                args: result.args as any[],
            });
        } catch {}
    }

    // reaching here means none of the signatures matched the given error data
    return Result.err(
        new Error(
            "Failed to decode the error as none of the known signatures matched with the error",
        ),
    );
}

/**
 * Tries to get the signature associated withe given selector, it first searches through
 * cached signatures and if no match was found, it tries to get it from registry, cache
 * it and return it
 * @param selector - The selector to search for
 */
export async function tryGetSignature(selector: string): Promise<Result<string[], any>> {
    // check validity of the selector
    selector = selector.toLowerCase();
    assert(
        SELECTOR_PATTERN.test(selector),
        `Invalid selector ${selector}, must be 32 bytes hex string`,
    );

    // check the cache first and try getting it from registry if not already cached
    const sigabi = SelectorCache.get(selector);
    if (sigabi) {
        return Result.ok(sigabi);
    } else {
        try {
            const result = await axios.get(SELECTOR_REGISTRY, {
                headers: { accept: "application/json" },
                params: { filter: true, function: selector },
            });

            // ensure valid, non-empty response
            const responseData = result?.data?.result?.function?.[selector];
            assert(Array.isArray(responseData), "Response from registry contains no valid results");
            assert(!!responseData.length, "Response from registry contains empty results");

            // store in cache
            const sigs = responseData.map((v: { name: string }) => v.name);
            SelectorCache.set(selector, sigs);

            return Result.ok(sigs);
        } catch (error: any) {
            return Result.err(error);
        }
    }
}

/**
 * Decodes the given error data as Panic(uint256) and returns the matching reason from solidity docs:
 * https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
 * @param data - The error data
 */
export function tryDecodePanic(data: `0x${string}`): Result<DecodedErrorType, any> {
    try {
        const result = decodeErrorResult({ abi: [PANIC_ABI], data });
        const reason =
            PANIC_REASONS[Number(result.args[0]) as keyof typeof PANIC_REASONS] ??
            `unknown reason with code: 0x${result.args[0].toString(16)}`;
        return Result.ok({
            name: "Panic",
            args: [reason],
        });
    } catch (error: any) {
        return Result.err(error);
    }
}
