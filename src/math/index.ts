import { formatUnits, isBytes, isHex } from "viem";

/**
 * One ether which equals to 1e18
 */
export const ONE18 = 1_000_000_000_000_000_000n as const;

export const ONE_FLOAT =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

export const MAX_FLOAT =
    "0x000000007fffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const;

/**
 * Scales a given value and its decimals to 18 fixed point decimals
 * @param value - The value to scale to 18
 * @param decimals - The decimals of the value to scale to 18
 */
export function scaleTo18(value: bigint, decimals: number): bigint {
    if (decimals > 18) {
        return value / BigInt("1" + "0".repeat(decimals - 18));
    } else {
        return value * BigInt("1" + "0".repeat(18 - decimals));
    }
}

/**
 * Scales a given 18 fixed point decimals value to the given decimals point value
 * @param value - The value to scale from 18 to target decimals
 * @param targetDecimals - The target decimals to scale from 18 to
 */
export function scaleFrom18(value: bigint, targetDecimals: number): bigint {
    if (targetDecimals > 18) {
        return value * BigInt("1" + "0".repeat(targetDecimals - 18));
    } else {
        return value / BigInt("1" + "0".repeat(18 - targetDecimals));
    }
}

/**
 * Converts to a float number
 */
export function toNumber(value: bigint): number {
    return Number.parseFloat(formatUnits(value, 18));
}

/**
 * Checks if an a value is a big numberish, from ethers
 */
export function isBigNumberish(value: any): boolean {
    return (
        value != null &&
        ((typeof value === "number" && value % 1 === 0) ||
            (typeof value === "string" && !!value.match(/^-?[0-9]+$/)) ||
            isHex(value) ||
            typeof value === "bigint" ||
            isBytes(value))
    );
}
