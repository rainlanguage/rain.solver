/** Specifies reason that order process halted with failure */
export enum ProcessOrderHaltReason {
    FailedToQuote = 1,
    FailedToGetEthPrice = 2,
    FailedToGetPools = 3,
    TxFailed = 4,
    TxMineFailed = 5,
    TxReverted = 6,
    FailedToUpdatePools = 7,
    UnexpectedError = 8,
}

/** Specifies status of an processed order */
export enum ProcessOrderStatus {
    ZeroOutput = 1,
    NoOpportunity = 2,
    FoundOpportunity = 3,
}
