import { BigNumber } from "ethers";
import { LiquidityProviders, RainDataFetcher } from "sushi";
import { AttributeValue } from "@opentelemetry/api";
import { Chain, PublicClient } from "viem";
import { AppOptions } from "./config";
import { Token } from "sushi/currency";
import { Dispair } from "./state";
import { RainSolverSigner, RawTransaction } from "./signer";
import { ProcessOrderHaltReason, ProcessOrderStatus } from "./solver/types";

export type BotError = {
    snapshot: string;
    error: any;
};

/** @deprecated in favor of SharedState (WIP) */
export type BotConfig = Omit<AppOptions, "dispair"> & {
    chain: Chain;
    nativeWrappedToken: Token;
    routeProcessors: { [key: string]: `0x${string}` };
    stableTokens?: Token[];
    isSpecialL2: boolean;
    lps: LiquidityProviders[];
    viemClient: PublicClient;
    dataFetcher: RainDataFetcher;
    mainAccount: RainSolverSigner;
    accounts: RainSolverSigner[];
    dispair: Dispair;
};

export type Report = {
    status: ProcessOrderStatus;
    tokenPair: string;
    buyToken: string;
    sellToken: string;
    txUrl?: string;
    clearedAmount?: string;
    actualGasCost?: string;
    inputTokenIncome?: string;
    outputTokenIncome?: string;
    clearedOrders?: string[];
    income?: BigNumber;
    netProfit?: BigNumber;
    reason?: ProcessOrderHaltReason;
    error?: any;
};

export type RoundReport = {
    reports: Report[];
    avgGasCost?: BigNumber;
};

export type SpanAttrs = Record<string, AttributeValue>;

export type ProcessPairResult = {
    reason?: ProcessOrderHaltReason;
    error?: any;
    report: Report;
    gasCost?: BigNumber;
    spanAttributes: SpanAttrs;
};

export type DryrunValue = {
    rawtx?: RawTransaction;
    maximumInput?: BigNumber;
    price?: BigNumber;
    routeVisual?: string[];
    oppBlockNumber?: number;
    estimatedProfit: BigNumber;
    noneNodeError?: string;
};

export type DryrunResult = {
    value?: DryrunValue;
    reason?: number;
    spanAttributes: SpanAttrs;
};

export type SelfFundVault = {
    token: string;
    vaultId: string;
    orderbook: string;
    threshold: string;
    topupAmount: string;
};

export type OwnedOrder = {
    id: string;
    orderbook: string;
    vaultId: string;
    token: string;
    symbol: string;
    decimals: number;
    vaultBalance: BigNumber;
};

export type RpcRequest = {
    jsonrpc: `${number}`;
    method: string;
    params?: any | undefined;
    id: number;
};

export type RpcResponse<result = any, error = any> = {
    jsonrpc: `${number}`;
    id: number;
} & (RpcSuccessResult<result> | RpcErrorResult<error>);

export type RpcSuccessResult<result> = {
    method?: undefined;
    result: result;
    error?: undefined;
};

export type RpcErrorResult<error> = {
    method?: undefined;
    result?: undefined;
    error: error;
};

export const RpcErrorCode = [
    -32700, // Parse error
    -32600, // Invalid request
    -32601, // Method not found
    -32602, // Invalid params
    -32603, // Internal error
    -32000, // Invalid input
    -32001, // Resource not found
    -32002, // Resource unavailable
    -32003, // Transaction rejected
    -32004, // Method not supported
    -32005, // Limit exceeded
    -32006, // JSON-RPC version not supported
    -32042, // Method not found
] as const;

export const ProviderRpcErrorCode = [
    4001, // User Rejected Request
    4100, // Unauthorized
    4200, // Unsupported Method
    4900, // Disconnected
    4901, // Chain Disconnected
    4902, // Chain Not Recognized
] as const;

export function isOkRpcError(v: any): boolean {
    if ("error" in v && "code" in v.error) {
        const code = v.error.code;
        if (typeof code === "number") {
            return [...RpcErrorCode, ...ProviderRpcErrorCode].includes(code as any);
        } else if (typeof code === "string" && /^-?[0-9]+$/.test(code)) {
            return [...RpcErrorCode, ...ProviderRpcErrorCode].includes(Number(code) as any);
        } else return false;
    } else return false;
}

export function isRpcRequest(v: any): v is RpcRequest {
    if (
        typeof v === "object" &&
        v !== null &&
        "jsonrpc" in v &&
        "id" in v &&
        typeof v.id === "number"
    )
        return true;
    else return false;
}

export function isRpcResponse(v: any): v is RpcResponse {
    if (
        typeof v === "object" &&
        v !== null &&
        "jsonrpc" in v &&
        "id" in v &&
        typeof v.id === "number"
    )
        return true;
    else return false;
}
