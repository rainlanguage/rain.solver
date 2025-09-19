import assert from "assert";
import { ABI, Result } from "../common";
import axios, { AxiosError } from "axios";
import { balancerBatchRouterAbiExtended } from "@balancer/sdk";
import {
    isHex,
    parseAbiItem,
    decodeErrorResult,
    toFunctionSelector,
    toFunctionSignature,
    DecodeErrorResultErrorType,
} from "viem";
import {
    PANIC_ABI,
    PANIC_SELECTOR,
    SELECTOR_PATTERN,
    DecodedErrorType,
    SELECTOR_REGISTRY,
    PANIC_REASONS,
} from "./types";

/** Selector abi/sig cache at runtime */
export const SelectorCache = new Map<string, string[]>();

// set balancer error signatures in the cache as they are not available in the registry
balancerBatchRouterAbiExtended.forEach((abi: any) => {
    if (abi.type !== "error") return;
    const minimalSig = toFunctionSignature(abi).replace("error ", "");
    SelectorCache.set(toFunctionSelector(minimalSig), [minimalSig]);
});
// set route processor error signatures in the cache as they are not available in the registry
ABI.RouteProcessor.Primary.RouteProcessor4.forEach((abi: any) => {
    if (abi.type !== "error") return;
    const minimalSig = toFunctionSignature(abi).replace("error ", "");
    SelectorCache.set(toFunctionSelector(minimalSig), [minimalSig]);
});

/**
 * Tries to decode the given error data by running through known matching signatures
 * @param data - the error data
 */
export async function tryDecodeError(
    data: any,
): Promise<Result<DecodedErrorType, AxiosError | DecodeErrorResultErrorType | Error>> {
    // check for validity of the data
    if (!data.startsWith("0x")) data = `0x${data}`;
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
            const result = decodeErrorResult({ abi: [parseAbiItem("error " + sig)], data });
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
export async function tryGetSignature(
    selector: string,
): Promise<Result<string[], AxiosError | Error>> {
    try {
        // check validity of the selector
        if (!selector.startsWith("0x")) selector = `0x${selector}`;
        selector = selector.toLowerCase();
        assert(
            SELECTOR_PATTERN.test(selector),
            `Invalid selector ${selector}, must be 32 bytes hex string`,
        );

        // check the cache first and try getting it from registry if not already cached
        const cachedSigs = SelectorCache.get(selector);
        if (cachedSigs) {
            return Result.ok(cachedSigs);
        }
        const registryQueryResult = await axios.get(SELECTOR_REGISTRY, {
            headers: { accept: "application/json" },
            params: { filter: true, function: selector },
        });

        // ensure valid, non-empty response
        const responseData = registryQueryResult?.data?.result?.function?.[selector];
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

/**
 * Decodes the given error data as Panic(uint256) and returns the matching reason from solidity docs:
 * https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
 * @param data - The error data
 */
export function tryDecodePanic(
    data: `0x${string}`,
): Result<DecodedErrorType, DecodeErrorResultErrorType> {
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
