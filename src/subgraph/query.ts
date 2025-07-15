import { SgFilter } from "./filter";

export const DEFAULT_PAGE_SIZE = 1000 as const;

/**
 * Method to get the subgraph query body for order details with optional filters
 * @param skip - Number of results to skip
 * @param filters - Applies the filters for query
 * @returns the query string
 */
export function getQueryPaginated(skip: number, filters?: SgFilter): string {
    const getFilterVar = (header: string, f?: Set<string>) =>
        f ? `${header}: [${[...f].map((v) => `"${v.toLowerCase()}"`).join(", ")}], ` : "";

    const incOwnerFilter = getFilterVar("owner_in", filters?.includeOwners);
    const exOwnerFilter = getFilterVar("owner_not_in", filters?.excludeOwners);
    const incOrderFilter = getFilterVar("orderHash_in", filters?.includeOrders);
    const exOrderFilter = getFilterVar("orderHash_not_in", filters?.excludeOrders);
    const incOrderbookFilter = getFilterVar("orderbook_in", filters?.includeOrderbooks);
    const exOrderbookFilter = getFilterVar("orderbook_not_in", filters?.excludeOrderbooks);

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
        active
        nonce
        orderbook {
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

export const orderbooksQuery = `{
    orderbooks {
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
 */
export const getTxsQuery = (startTimestamp: number, skip: number) => {
    return `{transactions(
    orderBy: timestamp
    orderDirection: asc
    first: ${DEFAULT_PAGE_SIZE}
    skip: ${skip}
    where: { timestamp_gt: "${startTimestamp}" }
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
                active
                nonce
                orderbook {
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
                active
                nonce
                orderbook {
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
            orderbook {
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
            orderbook {
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
                    orderbook {
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
                    orderbook {
                        id
                    }
                }
            }
        }
    }
    timestamp
}}`;
};
