import { VaultBalanceAbi } from "../common";
import { erc20Abi, PublicClient } from "viem";
import { OrderbooksOwnersProfileMap } from "./types";

export type Vault = { vaultId: bigint; balance: bigint };
export type OwnerVaults = Map<string, Vault[]>;
export type TokenOwnerVaults = Map<string, OwnerVaults>;
export type OrderbookTokenOwnerVaultsMap = Map<string, TokenOwnerVaults>;

/**
 * Builds a map with following form from an `OrderbooksOwnersProfileMap` instance:
 * `orderbook -> token -> owner -> vaults`
 * This is later on used to evaluate the owners limits
 */
export function buildOrderbookTokenOwnerVaultsMap(
    orderbooksOwnersProfileMap: OrderbooksOwnersProfileMap,
): OrderbookTokenOwnerVaultsMap {
    const result: OrderbookTokenOwnerVaultsMap = new Map();
    orderbooksOwnersProfileMap.forEach((ownersProfileMap, orderbook) => {
        const tokensOwnersVaults: TokenOwnerVaults = new Map();
        ownersProfileMap.forEach((ownerProfile, owner) => {
            ownerProfile.orders.forEach((orderProfile) => {
                orderProfile.takeOrders.forEach((pair) => {
                    const token = pair.sellToken.toLowerCase();
                    const vaultId =
                        pair.takeOrder.takeOrder.order.validOutputs[
                            pair.takeOrder.takeOrder.outputIOIndex
                        ].vaultId;
                    const ownersVaults = tokensOwnersVaults.get(token);
                    if (ownersVaults) {
                        const vaults = ownersVaults.get(owner.toLowerCase());
                        if (vaults) {
                            if (!vaults.find((v) => v.vaultId === vaultId))
                                vaults.push({ vaultId, balance: 0n });
                        } else {
                            ownersVaults.set(owner.toLowerCase(), [{ vaultId, balance: 0n }]);
                        }
                    } else {
                        const newOwnersVaults: OwnerVaults = new Map();
                        newOwnersVaults.set(owner.toLowerCase(), [{ vaultId, balance: 0n }]);
                        tokensOwnersVaults.set(token, newOwnersVaults);
                    }
                });
            });
        });
        result.set(orderbook, tokensOwnersVaults);
    });
    return result;
}

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
    otovMap: OrderbookTokenOwnerVaultsMap,
    client: PublicClient,
    ownerLimits?: Record<string, number>,
    multicallAddressOverride?: string,
) {
    for (const [orderbook, tokensOwnersVaults] of otovMap) {
        const ownersProfileMap = orderbooksOwnersProfileMap.get(orderbook);
        if (ownersProfileMap) {
            const ownersCuts: Map<string, number[]> = new Map();
            for (const [token, ownersVaults] of tokensOwnersVaults) {
                const obTokenBalance = await client.readContract({
                    address: token as `0x${string}`,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [orderbook as `0x${string}`],
                });
                for (const [owner, vaults] of ownersVaults) {
                    // skip if owner limit is set by bot admin
                    if (typeof ownerLimits?.[owner.toLowerCase()] === "number") continue;

                    const ownerProfile = ownersProfileMap.get(owner);
                    if (ownerProfile) {
                        await fetchVaultBalances(
                            orderbook,
                            token,
                            owner,
                            vaults,
                            client,
                            multicallAddressOverride,
                        );
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
                            otherOwnersBalances === 0n
                                ? 100n
                                : (avgBalance * 100n) / otherOwnersBalances;

                        // divide into 4 segments
                        let ownerEvalDivideFactor = 1;
                        if (balanceRatioPercent >= 75n) {
                            ownerEvalDivideFactor = 1;
                        } else if (balanceRatioPercent >= 50n && balanceRatioPercent < 75n) {
                            ownerEvalDivideFactor = 2;
                        } else if (balanceRatioPercent >= 25n && balanceRatioPercent < 50n) {
                            ownerEvalDivideFactor = 3;
                        } else if (balanceRatioPercent > 0n && balanceRatioPercent < 25n) {
                            ownerEvalDivideFactor = 4;
                        }

                        // gather owner divide factor for all of the owner's orders' tokens
                        // to calculate an avg from them all later on
                        const cuts = ownersCuts.get(owner.toLowerCase());
                        if (cuts) {
                            cuts.push(ownerEvalDivideFactor);
                        } else {
                            ownersCuts.set(owner.toLowerCase(), [ownerEvalDivideFactor]);
                        }
                    }
                }
            }

            ownersProfileMap.forEach((ownerProfile, owner) => {
                const cuts = ownersCuts.get(owner);
                if (cuts?.length) {
                    const avgCut = cuts.reduce((a, b) => a + b, 0) / cuts.length;
                    // round to nearest int, if turned out 0, set it to 1 as minimum
                    ownerProfile.limit = Math.round(ownerProfile.limit / avgCut);
                    if (ownerProfile.limit === 0) ownerProfile.limit = 1;
                }
            });
        }
    }
}

/**
 * Gets vault balances of an owner's vaults of a given token
 */
export async function fetchVaultBalances(
    orderbook: string,
    token: string,
    owner: string,
    vaults: Vault[],
    client: PublicClient,
    multicallAddressOverride?: string,
) {
    const multicallResult = await client.multicall({
        multicallAddress:
            (multicallAddressOverride as `0x${string}` | undefined) ??
            client.chain?.contracts?.multicall3?.address,
        allowFailure: false,
        contracts: vaults.map((v) => ({
            address: orderbook as `0x${string}`,
            allowFailure: false,
            chainId: client.chain!.id,
            abi: VaultBalanceAbi,
            functionName: "vaultBalance",
            args: [owner, token, v.vaultId],
        })),
    });

    for (let i = 0; i < multicallResult.length; i++) {
        vaults[i].balance = multicallResult[i];
    }
}
