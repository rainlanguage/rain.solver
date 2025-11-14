import { Evaluable } from "../order";
import { Attributes } from "@opentelemetry/api";
import { Result, RawTransaction } from "../common";
import { EstimateGasCostResult } from "../signer";

/** Specifies reason that order process halted with failure */
export enum ProcessOrderHaltReason {
    FailedToQuote,
    FailedToGetEthPrice,
    FailedToGetPools,
    TxFailed,
    TxMineFailed,
    TxReverted,
    FailedToUpdatePools,
    UnexpectedError,
}

/** Specifies status of an processed order */
export enum ProcessOrderStatus {
    ZeroOutput,
    NoOpportunity,
    FoundOpportunity,
    UndefinedTradeAddresses,
}

/** Specifies types of trades */
export enum TradeType {
    RouteProcessor = "routeProcessor",
    IntraOrderbook = "intraOrderbook",
    InterOrderbook = "interOrderbook",
    Balancer = "balancer",
    Router = "router",
    Stabull = "stabull",
}

/** Base type for process order results containing shared fields */
export type ProcessOrderResultBase = {
    status: ProcessOrderStatus;
    tokenPair: string;
    buyToken: string;
    sellToken: string;
    spanAttributes: Attributes;
    spanEvents: OrderSpanEvents;
    gasCost?: bigint;
};

/** Successful process order result */
export type ProcessOrderSuccess = ProcessOrderResultBase & {
    endTime: number;
    message?: string;
    txUrl?: string;
    txSettlement?: Promise<Result<ProcessTransactionSuccess, ProcessOrderFailure>>;
};

/** Successful process transaction receipt */
export type ProcessTransactionSuccess = ProcessOrderResultBase & {
    endTime: number;
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
    endTime: number;
    reason: ProcessOrderHaltReason;
    error?: any;
    txUrl?: string;
};

export type TaskType = {
    evaluable: Evaluable;
    signedContext: any[];
};

// dryrun result types
export type DryrunResultBase = {
    spanAttributes: Attributes;
};
export type DryrunSuccess = DryrunResultBase & {
    estimatedGasCost: bigint;
    estimation: EstimateGasCostResult;
};
export type DryrunFailure = DryrunResultBase & {
    reason?: number;
    noneNodeError?: string;
};
export type DryrunResult = Result<DryrunSuccess, DryrunFailure>;

// simulation result types
export type SimulationResultBase = {
    type: TradeType;
};
export type SuccessSimulation = SimulationResultBase & {
    spanAttributes: Attributes;
    estimatedGasCost: bigint;
    estimatedProfit: bigint;
    rawtx: RawTransaction;
    oppBlockNumber: number;
};
export type FailedSimulation = SimulationResultBase & DryrunFailure;
export type SimulationResult = Result<SuccessSimulation, FailedSimulation>;

// find best trade result types
export type FindBestTradeSuccess = SuccessSimulation;
export type FindBestTradeFailure = Pick<FailedSimulation, "spanAttributes" | "noneNodeError">;
export type FindBestTradeResult = Result<FindBestTradeSuccess, FindBestTradeFailure>;

/** Represents OTEL compatible event details paired with event name that occures during order proccessing */
export type OrderSpanEvents = Record<
    string,
    {
        startTime: number;
        duration: number;
    }
>;
