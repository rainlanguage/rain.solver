/** List of blacklisted pools */
export const BlackList = [
    "0x2c2797Fe74A1b40E3B85b82c02C0AC327D9dF22D",
    "0xFB957DE375cc10450D7a34aB85b1F15Ef58680b4",
    "0x11E29b541AbE15984c863c10F3Ef9eCBcC078031",
    "0x59048Ff7D11ef18514163d0A860fb7A34927a452",
] as const;

/** Blacklisted pools as a set, used by router */
export const BlackListSet = new Set([...BlackList, ...BlackList.map((addr) => addr.toLowerCase())]);

/** A function that filters out blacklisted pools used by sushi router */
export function RPoolFilter(pool: any) {
    return !BlackListSet.has(pool.address.toLowerCase());
}
