import { BigNumber } from "ethers";
import { LiquidityProviders, RainDataFetcher } from "sushi";
import { AttributeValue } from "@opentelemetry/api";
import {
    Chain,
    Account,
    HDAccount,
    TestClient,
    WalletClient,
    PublicActions,
    WalletActions,
    FallbackTransport,
    SendTransactionParameters,
    PublicClient,
} from "viem";
import { AppOptions } from "./config";
import { Token } from "sushi/currency";
import { Dispair, TokenDetails } from "./state";

/**
 * Specifies reason that order process halted
 */
export enum ProcessPairHaltReason {
    FailedToQuote = 1,
    FailedToGetEthPrice = 2,
    FailedToGetPools = 3,
    TxFailed = 4,
    TxMineFailed = 5,
    TxReverted = 6,
    FailedToUpdatePools = 7,
    UnexpectedError = 8,
}

/**
 * Specifies status of an processed order report
 */
export enum ProcessPairReportStatus {
    ZeroOutput = 1,
    NoOpportunity = 2,
    FoundOpportunity = 3,
}

export type BotError = {
    snapshot: string;
    error: any;
};

export type BundledOrders = {
    orderbook: string;
    buyToken: string;
    buyTokenDecimals: number;
    buyTokenSymbol: string;
    sellToken: string;
    sellTokenDecimals: number;
    sellTokenSymbol: string;
    takeOrders: TakeOrderDetails[];
};

export type TakeOrderDetails = {
    id: string;
    quote?: {
        maxOutput: BigNumber;
        ratio: BigNumber;
    };
    takeOrder: TakeOrder;
};

export type TakeOrder = {
    order: Order;
    inputIOIndex: number;
    outputIOIndex: number;
    signedContext: any[];
};

export type Evaluable = {
    interpreter: string;
    store: string;
    bytecode: string | Uint8Array;
};

export type IO = {
    token: string;
    decimals: number;
    vaultId: string;
};

export type Order = {
    owner: string;
    nonce: string;
    evaluable: Evaluable;
    validInputs: IO[];
    validOutputs: IO[];
};

export type Pair = {
    buyToken: string;
    buyTokenDecimals: number;
    buyTokenSymbol: string;
    sellToken: string;
    sellTokenDecimals: number;
    sellTokenSymbol: string;
    takeOrder: TakeOrderDetails;
};
export type OrderProfile = {
    active: boolean;
    order: Order;
    takeOrders: Pair[];
};
export type OwnerProfile = {
    limit: number;
    lastIndex: number;
    orders: OrdersProfileMap;
};
export type OrdersProfileMap = Map<string, OrderProfile>;
export type OwnersProfileMap = Map<string, OwnerProfile>;
export type OrderbooksOwnersProfileMap = Map<string, OwnersProfileMap>;

export type Vault = { vaultId: string; balance: bigint };
export type OwnersVaults = Map<string, Vault[]>;
export type TokensOwnersVaults = Map<string, OwnersVaults>;
export type OTOVMap = Map<string, TokensOwnersVaults>;

export type ViemClient = WalletClient<FallbackTransport, Chain, HDAccount> &
    PublicActions & {
        BALANCE: BigNumber;
        BOUNTY: TokenDetails[];
        BUSY: boolean;
        sendTx: <chain extends Chain, account extends Account>(
            tx: SendTransactionParameters<chain, account>,
        ) => Promise<`0x${string}`>;
    };

export type TestViemClient = TestClient<"hardhat"> &
    PublicActions &
    WalletActions & {
        BALANCE: BigNumber;
        BOUNTY: TokenDetails[];
        BUSY: boolean;
        sendTx: <chain extends Chain, account extends Account>(
            tx: SendTransactionParameters<chain, account>,
        ) => Promise<`0x${string}`>;
    };

/** @deprecated in favor of SharedState (WIP) */
export type BotConfig = Omit<AppOptions, "dispair"> & {
    chain: Chain;
    nativeWrappedToken: Token;
    routeProcessors: { [key: string]: `0x${string}` };
    stableTokens?: Token[];
    isSpecialL2: boolean;
    lps: LiquidityProviders[];
    watchedTokens?: TokenDetails[];
    viemClient: PublicClient;
    dataFetcher: RainDataFetcher;
    mainAccount: ViemClient;
    accounts: ViemClient[];
    dispair: Dispair;
};

export type Report = {
    status: ProcessPairReportStatus;
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
    reason?: ProcessPairHaltReason;
    error?: any;
};

export type RoundReport = {
    reports: Report[];
    avgGasCost?: BigNumber;
};

export type SpanAttrs = Record<string, AttributeValue>;

export type ProcessPairResult = {
    reason?: ProcessPairHaltReason;
    error?: any;
    report: Report;
    gasCost?: BigNumber;
    spanAttributes: SpanAttrs;
};

export type RawTx = {
    to: `0x${string}`;
    from?: `0x${string}`;
    data: `0x${string}`;
    gasPrice?: bigint;
    gas?: bigint;
    nonce?: number;
};

export type DryrunValue = {
    rawtx?: RawTx;
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

export type SelfFundOrder = {
    token: string;
    vaultId: string;
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

/**
 * Filter criteria for subgraph queries
 */
export type SgFilter = {
    /** Order hashes to include */
    includeOrders?: Set<string>;
    /** Owner addresses to include */
    includeOwners?: Set<string>;
    /** Order hashes to exclude (takes precedence over includeOrders) */
    excludeOrders?: Set<string>;
    /** Owner addresses to exclude (takes precedence over includeOwners) */
    excludeOwners?: Set<string>;
    /** Orderbook addresses to include */
    includeOrderbooks?: Set<string>;
    /** Orderbook addresses to exclude (takes precedence over includeOrderbooks) */
    excludeOrderbooks?: Set<string>;
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
