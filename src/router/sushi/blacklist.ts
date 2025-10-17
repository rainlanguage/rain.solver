import { RPool } from "sushi/tines";

/** List of blacklisted pools */
export const BlackList = [
    "0x2c2797Fe74A1b40E3B85b82c02C0AC327D9dF22D",
    "0xFB957DE375cc10450D7a34aB85b1F15Ef58680b4",
    "0x11E29b541AbE15984c863c10F3Ef9eCBcC078031",
    "0x59048Ff7D11ef18514163d0A860fb7A34927a452",
    "0x461053a473248054807241adE4F988A35899A312", // polygon quickswap nht/wpol
    "0xB259dD2307E7626d925efb6D523b986b670e5631", // polygon sushiswap nht/wpol
    "0x2344cD834d03bA94886ca5665F847BbDD7484f32", // polygon sushiswap nht/weth
    "0xe427B62B495C1dFe1Fe9F78bEbFcEB877ad05DCE", // polygon sushiswap nht/usdt
] as const;

/** Blacklisted pools as a set, used by router */
export const BlackListSet = new Set([...BlackList, ...BlackList.map((addr) => addr.toLowerCase())]);

/** A function that filters out blacklisted pools used by sushi router */
export function RPoolFilter(pool: RPool) {
    return !BlackListSet.has(pool.address.toLowerCase());
}
