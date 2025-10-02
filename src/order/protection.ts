import { erc20Abi, PublicClient } from "viem";
import { OrderbookOwnerTokenVaultsMap, OrderbooksOwnersProfileMap } from "./types";

/**
 * Evaluates the owners limits by checking an owner vaults avg balances of a token against
 * other owners total balances of that token to calculate a percentage, repeats the same
 * process for every other token and owner and at the end ends up with map of owners with array
 * of percentages, then calculates an avg of all those percenatges and that is applied as a divider
 * factor to the owner's limit.
 * This ensures that if an owner has many orders/vaults and has spread their balances across those
 * many vaults and orders, he/she will get limited.
 * Owners limits that are set by bot's admin in yaml config, are excluded from this evaluation process
 */
export async function downscaleProtection(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
    ownersTokenVaultMap: OrderbookOwnerTokenVaultsMap,
    client: PublicClient,
    ownerLimits?: Record<string, number>,
) {
    function* iterProfiles() {
        for (const [orderbook, ownerTokenVaultMap] of ownersTokenVaultMap) {
            const ownersProfileMap = orderbooksOwnersProfileMap.get(orderbook);
            if (!ownersProfileMap) continue;
            const ownersCuts: Map<string, number[]> = new Map();
            for (const [owner, tokenVaults] of ownerTokenVaultMap) {
                // skip if owner limit is set by bot admin
                if (typeof ownerLimits?.[owner.toLowerCase()] === "number") continue;
                for (const [token, vaultsMap] of tokenVaults) {
                    yield { orderbook, ownersProfileMap, ownersCuts, owner, token, vaultsMap };
                }
            }

            ownersProfileMap.forEach((ownerProfile, owner) => {
                const cuts = ownersCuts.get(owner);
                if (cuts?.length) {
                    const avgCut = cuts.reduce((a, b) => a + b, 0) / cuts.length;
                    // round to nearest int, if turned out 0, set it to 1 as minimum
                    ownerProfile.limit = Math.max(Math.round(ownerProfile.limit / avgCut), 1);
                }
            });
        }
    }

    const balanceCache = new Map<string, bigint>();
    for await (const {
        orderbook,
        ownersProfileMap,
        ownersCuts,
        owner,
        token,
        vaultsMap,
    } of iterProfiles()) {
        // get the token balance for the orderbook
        // if already cached, use it, otherwise fetch it
        // and cache it for future use
        const obTokenBalance =
            balanceCache.get(`${orderbook}-${token}`) ??
            (await client
                .readContract({
                    address: token as `0x${string}`,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [orderbook as `0x${string}`],
                })
                .catch(() => undefined));
        if (obTokenBalance === undefined) continue;
        balanceCache.set(`${orderbook}-${token}`, obTokenBalance);

        // calculate owner's cut of this token against rest of the owners
        const vaults = Array.from(vaultsMap.values());
        const ownerProfile = ownersProfileMap.get(owner);
        if (!ownerProfile) continue;

        const ownerTotalBalance = vaults.reduce(
            (a, b) => ({
                balance: a.balance + b.balance,
            }),
            {
                balance: 0n,
            },
        ).balance;
        const avgBalance = ownerTotalBalance / BigInt(vaults.length);
        const otherOwnersBalances = obTokenBalance - ownerTotalBalance;
        const balanceRatioPercent =
            otherOwnersBalances === 0n ? 100n : (avgBalance * 100n) / otherOwnersBalances;

        // divide into 4 segments as owner limit divide factor
        // 0-25% = 4, 25-50% = 3, 50-75% = 2, 75-100% = 1, >100% = 1
        const ownerLimitDivideFactor = Math.abs(Math.min(Number(balanceRatioPercent / 25n), 3) - 4);

        // gather owner divide factor for all of the owner's orders' tokens
        // to calculate an avg from them all later on
        const cuts = ownersCuts.get(owner.toLowerCase());
        if (cuts) {
            cuts.push(ownerLimitDivideFactor);
        } else {
            ownersCuts.set(owner.toLowerCase(), [ownerLimitDivideFactor]);
        }
    }
}
