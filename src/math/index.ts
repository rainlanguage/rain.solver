import { formatUnits, isBytes, isHex } from "viem";

/**
 * One ether which equals to 1e18
 */
export const ONE18 = 1_000_000_000_000_000_000n as const;

/**
 * Scales a given value and its decimals to 18 fixed point decimals
 */
export function scale18(value: bigint, decimals: number): bigint {
    if (decimals > 18) {
        return value / BigInt("1" + "0".repeat(decimals - 18));
    } else {
        return value * BigInt("1" + "0".repeat(18 - decimals));
    }
}

/**
 * Scales a given 18 fixed point decimals value to the given decimals point value
 */
export function scale18To(value: bigint, targetDecimals: number): bigint {
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
