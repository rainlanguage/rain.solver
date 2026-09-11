import { SgFilter } from "./filter";
import { SubgraphVersions } from "./types";

export const DEFAULT_PAGE_SIZE = 1000 as const;

/**
 * The orderbook entity was renamed to `raindex` in the v6 subgraph schema, so v6
 * queries select it under an `orderbook` alias. That keeps the response shape
 * identical across versions and leaves every consumer of `SgOrder`/`SgTransaction`
 * untouched.
 * @param version - The subgraph schema version being queried
 */
export function orderbookField(version: SubgraphVersions): string {
    return version === SubgraphVersions.V6 ? "orderbook: raindex" : "orderbook";
}

/**
 * Method to get the subgraph query body for order details with optional filters
 * @param skip - Number of results to skip
 * @param filters - Applies the filters for query
 * @returns the query string
 */
export function getQueryPaginated(
    skip: number,
    filters?: SgFilter,
    version: SubgraphVersions = SubgraphVersions.LEGACY,
): string {
    const orderbook = orderbookField(version);
    const getFilterVar = (header: string, f?: Set<string>) =>
        f ? `${header}: [${[...f].map((v) => `"${v.toLowerCase()}"`).join(", ")}], ` : "";

    const incOwnerFilter = getFilterVar("owner_in", filters?.includeOwners);
    const exOwnerFilter = getFilterVar("owner_not_in", filters?.excludeOwners);
    const incOrderFilter = getFilterVar("orderHash_in", filters?.includeOrders);
    const exOrderFilter = getFilterVar("orderHash_not_in", filters?.excludeOrders);
    // the orderbook entity is also named `raindex` on the filter input in v6
    const orderbookFilterKey = version === SubgraphVersions.V6 ? "raindex" : "orderbook";
    const incOrderbookFilter = getFilterVar(`${orderbookFilterKey}_in`, filters?.includeOrderbooks);
    const exOrderbookFilter = getFilterVar(
        `${orderbookFilterKey}_not_in`,
        filters?.excludeOrderbooks,
    );

    return `{
    orders(
        first: ${DEFAULT_PAGE_SIZE},
        skip: ${skip},
        orderBy: timestampAdded,
        orderDirection: desc,
        where: {
            ${incOwnerFilter}
            ${exOwnerFilter}
            ${incOrderFilter}
            ${exOrderFilter}
            ${incOrderbookFilter}
            ${exOrderbookFilter}
            active: true
        }
    ) {
        id
        owner
        orderHash
        orderBytes
        meta
        active
        nonce
        ${orderbook} {
            id
        }
        inputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
        outputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
    }
}`;
}

export const getOrderbooksQuery = (version: SubgraphVersions = SubgraphVersions.LEGACY) => `{
    ${version === SubgraphVersions.V6 ? "orderbooks: raindices" : "orderbooks"} {
        id
    }
}`;

export const statusCheckQuery = `{
    _meta {
        hasIndexingErrors
        block {
            number
        }
    }
}`;

/**
 * Get query for transactions
 * @param startTimestamp - The timestamp to start query from
 * @param skip - Skips the first number of results
 * @param endTimestamp - (optional) The timestamp to end query at
 */
export const getTxsQuery = (
    startTimestamp: number,
    skip: number,
    endTimestamp?: number,
    version: SubgraphVersions = SubgraphVersions.LEGACY,
) => {
    const orderbook = orderbookField(version);
    const endTimestampClause =
        typeof endTimestamp === "number" ? `timestamp_lte: "${endTimestamp}"` : "";
    return `{transactions(
    orderBy: timestamp
    orderDirection: asc
    first: ${DEFAULT_PAGE_SIZE}
    skip: ${skip}
    where: { timestamp_gt: "${startTimestamp}" ${endTimestampClause} }
  ) {
    events {
        __typename
        ... on AddOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                meta
                active
                nonce
                ${orderbook} {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
        ... on RemoveOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                meta
                active
                nonce
                ${orderbook} {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
        ... on Deposit {
            newVaultBalance
            oldVaultBalance
            vault {
                owner
                vaultId
                balance
                token {
                    address
                    decimals
                    symbol
                }
            }
            ${orderbook} {
                id
            }
        }
        ... on Withdrawal {
            newVaultBalance
            oldVaultBalance
            vault {
                owner
                vaultId
                balance
                token {
                    address
                    decimals
                    symbol
                }
            }
            ${orderbook} {
                id
            }
        }
        ... on TradeEvent {
            trades {
                inputVaultBalanceChange {
                    newVaultBalance
                    oldVaultBalance
                    vault {
                        owner
                        balance
                        vaultId
                        token {
                            address
                            decimals
                            symbol
                        }
                    }
                    ${orderbook} {
                        id
                    }
                }
                outputVaultBalanceChange {
                    newVaultBalance
                    oldVaultBalance
                    vault {
                        owner
                        balance
                        vaultId
                        token {
                            address
                            decimals
                            symbol
                        }
                    }
                    ${orderbook} {
                        id
                    }
                }
            }
        }
    }
    timestamp
}}`;
};
