import { SgFilter } from "./filter";
import { SubgraphVersions } from "./types";

export const DEFAULT_PAGE_SIZE = 1000 as const;

/**
 * Returns the subgraph entity name that holds the orderbook address for the
 * given subgraph version, the v6 subgraph schema renamed the orderbook entity
 * to raindex (and the orderbooks collection to raindices)
 * @param version - The subgraph version
 */
export function getOrderbookEntityName(version: SubgraphVersions): "orderbook" | "raindex" {
    return version === SubgraphVersions.V6 ? "raindex" : "orderbook";
}

/**
 * Returns the query field selection for the orderbook address for the given
 * subgraph version, the v6 field is aliased back to "orderbook" so the response
 * shape is the same across all subgraph versions
 * @param version - The subgraph version
 */
function getOrderbookField(version: SubgraphVersions): string {
    const entity = getOrderbookEntityName(version);
    return entity === "orderbook" ? entity : `orderbook: ${entity}`;
}

/**
 * Method to get the subgraph query body for order details with optional filters
 * @param skip - Number of results to skip
 * @param filters - Applies the filters for query
 * @param version - The subgraph version, defaults to legacy
 * @returns the query string
 */
export function getQueryPaginated(
    skip: number,
    filters?: SgFilter,
    version: SubgraphVersions = SubgraphVersions.LEGACY,
): string {
    const getFilterVar = (header: string, f?: Set<string>) =>
        f ? `${header}: [${[...f].map((v) => `"${v.toLowerCase()}"`).join(", ")}], ` : "";

    const orderbookEntity = getOrderbookEntityName(version);
    const orderbookField = getOrderbookField(version);
    const incOwnerFilter = getFilterVar("owner_in", filters?.includeOwners);
    const exOwnerFilter = getFilterVar("owner_not_in", filters?.excludeOwners);
    const incOrderFilter = getFilterVar("orderHash_in", filters?.includeOrders);
    const exOrderFilter = getFilterVar("orderHash_not_in", filters?.excludeOrders);
    const incOrderbookFilter = getFilterVar(`${orderbookEntity}_in`, filters?.includeOrderbooks);
    const exOrderbookFilter = getFilterVar(`${orderbookEntity}_not_in`, filters?.excludeOrderbooks);

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
        ${orderbookField} {
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

/**
 * Returns the query for the list of orderbook addresses that a subgraph indexes,
 * the v6 raindices collection is aliased back to "orderbooks" so the response
 * shape is the same across all subgraph versions
 * @param version - The subgraph version, defaults to legacy
 */
export function getOrderbooksQuery(version: SubgraphVersions = SubgraphVersions.LEGACY): string {
    const collection = version === SubgraphVersions.V6 ? "orderbooks: raindices" : "orderbooks";
    return `{
    ${collection} {
        id
    }
}`;
}

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
 * @param version - The subgraph version, defaults to legacy
 */
export const getTxsQuery = (
    startTimestamp: number,
    skip: number,
    endTimestamp?: number,
    version: SubgraphVersions = SubgraphVersions.LEGACY,
) => {
    const orderbookField = getOrderbookField(version);
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
                ${orderbookField} {
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
                ${orderbookField} {
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
            ${orderbookField} {
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
            ${orderbookField} {
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
                    ${orderbookField} {
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
                    ${orderbookField} {
                        id
                    }
                }
            }
        }
    }
    timestamp
}}`;
};
