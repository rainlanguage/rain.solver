import { Attributes } from "@opentelemetry/api";

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

/** Base type for process order results containing shared fields */
export type ProcessOrderResultBase = {
    status: ProcessOrderStatus;
    tokenPair: string;
    buyToken: string;
    sellToken: string;
    spanAttributes: Attributes;
    txUrl?: string;
    gasCost?: bigint;
};

/** Successful process order result */
export type ProcessOrderSuccess = ProcessOrderResultBase & {
    txUrl?: string;
    clearedAmount?: string;
    inputTokenIncome?: string;
    outputTokenIncome?: string;
    income?: bigint;
    netProfit?: bigint;
    estimatedProfit?: bigint;
    message?: string;
};

/** Failed process order result */
export type ProcessOrderFailure = ProcessOrderResultBase & {
    reason: ProcessOrderHaltReason;
    error?: any;
    txUrl?: string;
};
