import { maxUint256 } from "viem";
import { Result } from "./result";
import { Float, WasmEncodedError } from "@rainlanguage/float";

export const MAX_FLOAT = (() => {
    const result = Float.maxPositiveValue();
    if (result.error) {
        throw new Error(`Failed to get max float value: ${result.error.readableMsg}`);
    }
    return result.value;
})();

export const MIN_FLOAT = (() => {
    const result = Float.minPositiveValue();
    if (result.error) {
        throw new Error(`Failed to get min float value: ${result.error.readableMsg}`);
    }
    return result.value;
})();

export function minFloat(decimals: number): `0x${string}` {
    return Float.fromFixedDecimal(1n, decimals).value!.asHex();
}

export function maxFloat(decimals: number): `0x${string}` {
    return Float.fromFixedDecimalLossy(maxUint256, decimals).value!.asHex();
}

/**
 * Waits for provided miliseconds
 * @param ms - Miliseconds to wait
 */
export async function sleep(ms: number, msg = "") {
    let _timeoutReference: string | number | NodeJS.Timeout | undefined;
    return new Promise(
        (resolve) => (_timeoutReference = setTimeout(() => resolve(msg), ms)),
    ).finally(() => clearTimeout(_timeoutReference));
}

/**
 * Method to put a timeout on a promise, throws the exception if promise is not settled within the time
 * @param promise - The Promise to put timeout on
 * @param time - The time in milliseconds
 * @param exception - The exception value to reject with if the promise is not settled within time
 * @returns A new promise that gets settled with initial promise settlement or rejected with exception value
 * if the time runs out before the main promise settlement
 */
export async function promiseTimeout(
    promise: Promise<any>,
    time: number,
    exception: Error | string | number | bigint | symbol | boolean,
) {
    let timer: string | number | NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise((_res, _rej) => (timer = setTimeout(_rej, time, exception))),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Json serializer function for handling bigint type
 */
export function withBigintSerializer(_k: string, v: any) {
    if (typeof v == "bigint") {
        return v.toString();
    } else if (v instanceof Set) {
        return Array.from(v);
    } else {
        return v;
    }
}

/**
 * Shuffles an array in place
 * @param array - The array
 */
export function shuffleArray(array: any[]) {
    let currentIndex = array.length;
    let randomIndex = 0;

    // While there remain elements to shuffle.
    while (currentIndex > 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
}

/**
 * Iterates over an array elements in random order with O(1) time complexity of randomness
 * @param array - Array to iterate over
 * @returns A generator that yields each order
 */
export function* iterRandom(array: Array<any>) {
    while (array.length) {
        // pick randomly for processing until all are processed
        // swap picked element with last element to avoid doing splice operation to achieve O(1) time complexity
        const pick = Math.floor(Math.random() * array.length);
        [array[pick], array[array.length - 1]] = [array[array.length - 1], array[pick]];
        yield array.pop()!; // array pop is also O(1)
    }
}

/**
 * Adds the given k/v pairs to the target object by prepending the key with given header
 */
export function extendObjectWithHeader(
    targetObj: Record<string, any>,
    sourceObj: Record<string, any>,
    header: string,
    excludeHeaderForKeys: string[] = [],
) {
    for (const attrKey in sourceObj) {
        if (!excludeHeaderForKeys.includes(attrKey)) {
            Object.assign(targetObj, { [header + "." + attrKey]: sourceObj[attrKey] });
        } else {
            Object.assign(targetObj, { [attrKey]: sourceObj[attrKey] });
        }
    }
}

/**
 * Normalizes a float value to a fixed number of decimal places
 * @param rawFloat - The float value in hex format
 * @param decimals - The number of decimal places to normalize to
 */
export function normalizeFloat(
    rawFloat: string,
    decimals: number,
): Result<bigint, WasmEncodedError> {
    const result = Float.fromHex(rawFloat as `0x${string}`);
    if (result.error) {
        return Result.err(result.error);
    }
    const fixedResult = result.value.toFixedDecimalLossy(decimals);
    if (fixedResult.error) {
        return Result.err(fixedResult.error);
    }
    return Result.ok(fixedResult.value);
}

/**
 * Converts a bigint value to a float representation with the specified decimal places
 * @param value - The bigint value to convert
 * @param decimals - The number of decimal places for the float representation
 * @returns The float representation in raw hex string format
 */
export function toFloat(value: bigint, decimals: number): Result<`0x${string}`, WasmEncodedError> {
    const result = Float.fromFixedDecimalLossy(value, decimals);
    if (result.error) {
        return Result.err(result.error);
    }
    return Result.ok(result.value.asHex());
}
