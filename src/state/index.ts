import { GasManager, TxFees } from "../gas";
import { ChainId } from "sushi/chain";
import { AppOptions } from "../config";
import { Token } from "sushi/currency";
import { BalancerRouter, DEFAULT_PRICE_IMPACT_TOLERANCE, TradeSizeStatus } from "../router";
import { LiquidityProviders } from "sushi";
import { SolverContracts } from "./contracts";
import { DryrunGasCache } from "./dryrunGasCache";
import { SushiRouter } from "../router/sushi";
import { AddressProvider } from "@balancer/sdk";
import { WalletConfig } from "../wallet/config";
import { Result, TokenDetails } from "../common";
import { OracleHealthMap } from "../oracle/types";
import { RainSolverRouter } from "../router/router";
import { SubgraphConfig } from "../subgraph/config";
import { RainSolverBaseError } from "../error/types";
import { OrderManagerConfig } from "../order/config";
import type { Pair } from "../order/types";
import { toEthValue, toUsdValue } from "../math";
import { RainSolverRouterError } from "../router/error";
import { NonceCache } from "../signer/nonce";
import { ChainConfig, ChainConfigError, getChainConfig } from "./chain";
import {
    RpcState,
    isWebSocketUrl,
    watchWsSocket,
    WsSocketKey,
    wsOpeningsAtLimit,
    reopenClosedWsSocket,
    subscriptionWebSocket,
    rainSolverTransport,
    WS_RPC_SOCKET_OPTIONS,
    RainSolverTransportConfig,
} from "../rpc";
import {
    parseUnits,
    formatUnits,
    hexToBigInt,
    PublicClient,
    createPublicClient,
    ReadContractErrorType,
} from "viem";
import { socketClientCache } from "viem/utils";

/** Delay (in ms) before an errored ws new heads subscription is re-established */
export const WS_RESUBSCRIBE_DELAY = 15_000;

/**
 * The failed new heads subscriptions in a row on the main ws rpc url, after
 * which the subscriptions move to its fallback url. A subscription fails when
 * its socket fails to open or drops, or when its subscribe fails or times out,
 * see SharedState.onWsFailure
 */
export const WS_FAILURES_TO_FALLBACK = 2;

/** How often (in ms) the main ws rpc url is tried while its fallback is in use, see SharedState.probeWsMain */
export const WS_MAIN_PROBE_INTERVAL = 60_000;

/**
 * How far (in ms) a head of a probe of the main ws rpc url can be behind the
 * bot's block number when it comes, in blocks of blockTime and at least one
 * block, a main in sync can send each head a bit after the fallback, see
 * SharedState.probeWsMain
 */
export const WS_PROBE_MAX_LAG = 2_000;

/** The raw eth_subscribe interface of the viem ws transport */
type WsTransportSubscribe = {
    subscribe(args: {
        params: string[];
        onData: (data: any) => void;
        onError?: (error: any) => void;
    }): Promise<{ unsubscribe: () => Promise<unknown> }>;
};

/** Matches a non-empty hex quantity string */
const HEX_QUANTITY_PATTERN = /^0x[0-9a-f]+$/i;

/**
 * Subscribes to the flashblocks heads (newFlashblocks) of the given ws client,
 * every flashblock head carries the number of the block it belongs to, so the
 * block number moves as soon as the first flashblock of a new block shows up,
 * this mirrors the subscription branch of viem's watchBlockNumber with the
 * subscription params swapped, with two additions, the error callback is
 * also gated on the active flag, since viem gets that from its observe
 * wrapper that drops the listeners on unwatch, which is not in play here,
 * and the head number is checked before parsing, since a throw here lands
 * in the socket message listener uncaught and the flashblocks payload is
 * provider specific
 * @param wsClient - The ws client to subscribe through
 * @param onBlockNumber - Called with the flashblock head block number and its base fee
 * @param onError - Called when the subscription errors
 * @returns A function that unsubscribes
 */
export function subscribeToFlashblocks(
    wsClient: PublicClient,
    onBlockNumber: (blockNumber: bigint, baseFeePerGas?: bigint | null) => void,
    onError: (error: any) => void,
): () => void {
    return subscribeToHeads(wsClient, "newFlashblocks", onBlockNumber, onError);
}

/**
 * Reads the base fee of a head, null when the head says it has none (a chain
 * without eip1559). A string that is not empty (hex or decimal), a number or a
 * bigint is taken with BigInt, a value that it does not take or that comes out
 * below zero is undefined, as is a head with no such field, anything else too,
 * a boolean say, that BigInt would take for 0 or 1
 * @param head - The head as it came over the socket
 */
function readHeadBaseFee(head: any): bigint | null | undefined {
    const baseFee = head?.baseFeePerGas;
    if (baseFee === null) return null;
    const takes =
        (typeof baseFee === "string" && baseFee.trim() !== "") ||
        typeof baseFee === "number" ||
        typeof baseFee === "bigint";
    if (!takes) return undefined;
    try {
        const value = BigInt(baseFee);
        return value >= 0n ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Subscribes to the given heads of the given ws client, new heads (newHeads) or
 * flashblocks heads (newFlashblocks), and hands on each head's block number and
 * base fee, see subscribeToFlashblocks for how it mirrors viem's watchBlockNumber
 * @param wsClient - The ws client to subscribe through
 * @param kind - The heads to subscribe to
 * @param onHead - Called with the head's block number and its base fee, see readHeadBaseFee
 * @param onError - Called when the subscription errors
 * @returns A function that unsubscribes
 */
export function subscribeToHeads(
    wsClient: PublicClient,
    kind: "newHeads" | "newFlashblocks",
    onHead: (blockNumber: bigint, baseFeePerGas?: bigint | null) => void,
    onError: (error: any) => void,
): () => void {
    let active = true;
    let unsubscribe: () => unknown = () => (active = false);
    (async () => {
        try {
            // the ws transport subscribe is typed for new heads only, so go
            // through a structural type to pass the flashblocks params
            const transport = wsClient.transport as unknown as WsTransportSubscribe;
            const { unsubscribe: unsubscribe_ } = await transport.subscribe({
                params: [kind],
                onData(data: any) {
                    if (!active) return;
                    const number = data?.result?.number;
                    if (typeof number === "string" && HEX_QUANTITY_PATTERN.test(number)) {
                        onHead(hexToBigInt(number as `0x${string}`), readHeadBaseFee(data.result));
                    }
                },
                onError(error: any) {
                    if (active) onError(error);
                },
            });
            unsubscribe = unsubscribe_;
            if (!active) unsubscribe();
        } catch (err) {
            if (active) onError(err);
        }
    })();
    return () => {
        active = false;
        unsubscribe();
    };
}

/** Enumerates the possible error types that can occur within the chain config */
export enum SharedStateErrorType {
    ChainConfigError,
    FailedToGetDispairInterpreterAddress,
    FailedToGetDispairStoreAddress,
    RouterInitializationError,
}

/**
 * Represents an error type for the ChainConfig.
 * This error class extends the `RainSolverError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `SharedStateErrorType` enum.
 *
 * @example
 * ```typescript
 * throw new SharedStateError("msg", SharedStateErrorType.ChainConfigError, originalError);
 * ```
 */
export class SharedStateError extends RainSolverBaseError {
    type: SharedStateErrorType;
    override cause?: ReadContractErrorType | ChainConfigError | RainSolverRouterError;
    constructor(
        message: string,
        type: SharedStateErrorType,
        cause?: ReadContractErrorType | ChainConfigError | RainSolverRouterError,
    ) {
        super(message);
        this.type = type;
        this.cause = cause;
        this.name = "SharedStateError";
    }
}

/**
 * SharedState configuration that holds required data for instantiating SharedState
 */
export type SharedStateConfig = {
    /** Application options */
    appOptions: AppOptions;
    /** Contract addresses required for solving */
    contracts: SolverContracts;
    /** Wallet configurations */
    walletConfig: WalletConfig;
    /** List of watched tokens at runtime */
    watchedTokens?: Map<string, TokenDetails>;
    /** List of active liquidity providers */
    liquidityProviders?: LiquidityProviders[];
    /** A viem client used for general read calls */
    client: PublicClient;
    /** Chain configuration */
    chainConfig: ChainConfig;
    /** Rain solver rpc state, manages and keeps track of rpcs during runtime */
    rpcState: RpcState;
    /** A rpc state for write rpcs */
    writeRpcState?: RpcState;
    /** Subgraph configurations */
    subgraphConfig: SubgraphConfig;
    /** OrderManager configurations */
    orderManagerConfig: OrderManagerConfig;
    /** Optional transaction gas multiplier */
    transactionGas?: string;
    /** RainSolver transport configuration */
    rainSolverTransportConfig?: RainSolverTransportConfig;
    /** RainSolver router instance */
    router: RainSolverRouter;
    /** Gas manager instance */
    gasManager: GasManager;
};
export namespace SharedStateConfig {
    export async function tryFromAppOptions(
        options: AppOptions,
    ): Promise<Result<SharedStateConfig, SharedStateError>> {
        const rainSolverTransportConfig = { timeout: options.timeout };
        const rpcState = new RpcState(options.rpc, options.rpcSelection);
        const writeRpcState = options.writeRpc
            ? new RpcState(options.writeRpc, options.rpcSelection)
            : undefined;

        // the sockets of the main ws rpcs open before the first request, so the
        // requests made during the opening share them, and a socket that
        // closed opens again, see watchWsSocket, the socket of a fallback ws
        // rpc opens once it is first picked, see RpcState.watchSocket
        for (const { url, fallback } of [...options.rpc, ...(options.writeRpc ?? [])]) {
            if (isWebSocketUrl(url) && !fallback) watchWsSocket(url, WS_RPC_SOCKET_OPTIONS);
        }

        // use temp client to get chain id
        let client = createPublicClient({
            transport: rainSolverTransport(rpcState, rainSolverTransportConfig),
        }) as any;

        // get chain config
        const chainId = await client.getChainId();
        const chainConfigResult = getChainConfig(chainId as ChainId);
        if (chainConfigResult.isErr()) {
            return Result.err(
                new SharedStateError(
                    `Cannot find configuration for the network with chain id: ${chainId}`,
                    SharedStateErrorType.ChainConfigError,
                    chainConfigResult.error,
                ),
            );
        }
        const chainConfig = chainConfigResult.value;

        // re-assign the client with static chain data
        client = createPublicClient({
            chain: chainConfig,
            transport: rainSolverTransport(rpcState, rainSolverTransportConfig),
        });

        const contracts = await SolverContracts.fromAppOptions(client, options);

        const liquidityProviders = SushiRouter.processLiquidityProviders(
            options.liquidityProviders,
        );
        const balancerRouterAddress = (() => {
            try {
                return AddressProvider.BatchRouter(chainId);
            } catch {
                return undefined;
            }
        })();
        const routerResult = await RainSolverRouter.create({
            chainId,
            client,
            stabullRouter: !!(options.contracts.v4?.stabullArb || options.contracts.v5?.stabullArb),
            sushiRouterConfig: {
                liquidityProviders,
                sushiRouteProcessor4Address: chainConfig.routeProcessors["4"] as `0x${string}`,
            },
            balancerRouterConfig:
                (options.contracts.v4?.balancerArb || options.contracts.v5?.balancerArb) &&
                balancerRouterAddress
                    ? {
                          balancerRouterAddress,
                      }
                    : undefined,
        });
        if (routerResult.isErr()) {
            return Result.err(
                new SharedStateError(
                    "Failed to init RainSolverRouter",
                    SharedStateErrorType.RouterInitializationError,
                    routerResult.error,
                ),
            );
        }

        const config: SharedStateConfig = {
            appOptions: options,
            client,
            rpcState,
            writeRpcState,
            chainConfig,
            rainSolverTransportConfig,
            router: routerResult.value,
            transactionGas: options.txGas,
            walletConfig: WalletConfig.tryFromAppOptions(options),
            subgraphConfig: SubgraphConfig.tryFromAppOptions(options),
            orderManagerConfig: OrderManagerConfig.tryFromAppOptions(options),
            liquidityProviders,
            contracts,
            gasManager: await GasManager.init({
                client,
                chainConfig,
                txType: options.txType,
                gasFeeBlockInterval: options.gasFeeBlockInterval,
                priorityFeePercentiles: options.priorityFeePercentiles,
                maxFeeBaseFeeMultiplier: options.maxFeeBaseFeeMultiplier,
                priorityFeeMultiplier: options.priorityFeeMultiplier,
                feeHistoryBlockTag: options.callBlockTag,
            }),
        };

        return Result.ok(config);
    }
}

/**
 * Maintains the shared state for RainSolver runtime operations, holds chain
 * configuration, contract addresses, RPC state, wallet key, watched tokens,
 * liquidity provider information required for application execution and also
 * watches the gas price during runtime by reading it periodically
 */
export class SharedState {
    readonly appOptions: AppOptions;
    /** Dispair, deployer, store and interpreter addresses */
    readonly contracts: SolverContracts;
    /** Wallet configurations */
    readonly walletConfig: WalletConfig;
    /** Chain configurations */
    readonly chainConfig: ChainConfig;
    /** List of watched tokens at runtime */
    readonly watchedTokens: Map<string, TokenDetails> = new Map();
    /** List of supported liquidity providers */
    readonly liquidityProviders?: LiquidityProviders[];
    /** A public viem client used for general read calls (without any wallet functionalities) */
    readonly client: PublicClient;
    /** Subgraph configurations */
    readonly subgraphConfig: SubgraphConfig;
    /** OrderManager configurations */
    readonly orderManagerConfig: OrderManagerConfig;
    /** Optional transaction gas multiplier */
    readonly transactionGas?: string;
    /** RainSolver transport configuration */
    readonly rainSolverTransportConfig?: RainSolverTransportConfig;
    /** Balancer router instance */
    readonly balancerRouter?: BalancerRouter;
    /** RainSolver router instance */
    readonly router: RainSolverRouter;
    /** Gas manager instance */
    readonly gasManager: GasManager;
    /** Keeps the average dryrun gas limit per order pair, used to skip init dryruns when enabled */
    readonly dryrunGasCache: DryrunGasCache;

    /** Keeps the app's RPC state */
    rpc: RpcState;
    /** Keeps the app's write RPC state */
    writeRpc?: RpcState;
    /** List of latest successful transactions gas costs */
    gasCosts: bigint[] = [];
    /** Keeps the next nonce of each wallet, so the sends do not fetch the tx count every time */
    readonly nonceCache = new NonceCache();
    /** Oracle endpoint health tracking for cooloff */
    oracleHealth: OracleHealthMap = new Map();
    /** The current native gas token to USD price (18 decimals fixed point number as decimal string), updated once per round */
    gasTokenUsdPrice?: string;
    /** The latest observed block number of the operating chain, kept up-to-date by the block number watcher, the block being built when subscribed to flashblocks */
    blockNumber = 0n;
    /** The latest sealed (canonical) block number of the operating chain, one below the observed block number when subscribed to flashblocks, equal to it otherwise */
    canonicalBlockNumber = 0n;
    /**
     * The latest sealed block number that came over the ws subscription, never
     * from the http polling, so it stops moving the moment the socket goes
     * silent, a proof of the last block the socket was alive at, the log sync
     * poll starts from it after a drop
     */
    wsBlockNumber = 0n;
    /**
     * When (in ms) a block number was last read, over http or over the ws
     * subscription, also when it did not move, 0 before the first read. Over
     * http it moves on each poll and stops when the rpc is down, over ws it
     * moves only with a new block, see isPollingBlockNumber and
     * EventSyncManager.report
     */
    blockNumberReadAt = 0;
    /** Set when a pool update observed a newly created pool, cleared by the consumer once acted on */
    newPoolCreated = false;
    /** Whether a pool update is in flight, a new block does not start another one meanwhile */
    private poolUpdateInFlight = false;

    private blockNumberWatcher: ReturnType<typeof setInterval> | undefined;
    private wsBlockNumberUnwatcher: (() => void) | undefined;
    private wsResubscribeTimer: ReturnType<typeof setTimeout> | undefined;
    /** The ws client every subscription goes through, one socket, created on first use from the ws rpc */
    private wsClient: PublicClient | undefined;
    /** Whether the subscriptions use the fallback url of the ws rpc, see activeWsUrl */
    private wsOnFallback = false;
    /** The failed new heads subscriptions in a row on the main ws rpc url, see onWsFailure */
    private wsFailures = 0;
    /** The timer of the probes of the main ws rpc url while its fallback is in use */
    private wsProbeTimer: ReturnType<typeof setInterval> | undefined;
    /** The ws client of the probes, on the main ws rpc url only, created on the first probe, see probeWsMain */
    private wsProbeClient: PublicClient | undefined;
    /** Ends the heads subscription of the probe that runs, see probeWsMain */
    private wsProbeUnsubscribe: (() => void) | undefined;
    /** The listeners of sealed block numbers, see onBlockNumber */
    private readonly blockListeners = new Set<(blockNumber: bigint) => void>();

    constructor(config: SharedStateConfig) {
        this.appOptions = config.appOptions;
        this.client = config.client;
        this.contracts = config.contracts;
        this.walletConfig = config.walletConfig;
        this.chainConfig = config.chainConfig;
        this.subgraphConfig = config.subgraphConfig;
        this.liquidityProviders = config.liquidityProviders;
        this.orderManagerConfig = config.orderManagerConfig;
        this.rpc = config.rpcState;
        this.writeRpc = config.writeRpcState;
        this.router = config.router;
        this.gasManager = config.gasManager;
        this.dryrunGasCache = new DryrunGasCache(
            (config.appOptions?.dryrunGasCacheResetTime ?? 0) * 60_000,
        );
        if (config.watchedTokens) {
            this.watchedTokens = config.watchedTokens;
        }
        if (config.transactionGas) {
            this.transactionGas = config.transactionGas;
        }
        if (config.rainSolverTransportConfig) {
            this.rainSolverTransportConfig = config.rainSolverTransportConfig;
        }
    }

    /**
     * The fee fields of an arb transaction as things stand, the max fee and the
     * tip in eip1559 mode, the gas price otherwise, see GasManager.txFees
     */
    txFees(): TxFees {
        return this.gasManager.txFees();
    }

    /**
     * The expected gas price of a transaction, what the estimates count with, the
     * base fee plus the tip in eip1559 mode, see GasManager.gasPrice
     */
    get gasPrice(): bigint {
        return this.gasManager.gasPrice;
    }
    set gasPrice(value: bigint) {
        this.gasManager.gasPrice = value;
    }

    /** Current L1 gas price of the operating chain, if the chain is a L2 chain, otherwise it is set to 0 */
    get l1GasPrice(): bigint {
        return this.gasManager.l1GasPrice;
    }
    set l1GasPrice(value: bigint) {
        this.gasManager.l1GasPrice = value;
    }

    get isWatchingGasPrice(): boolean {
        return this.gasManager.isWatchingGasPrice;
    }

    /** Returns the average gas cost of the successful transactions */
    get avgGasCost(): bigint {
        return this.gasCosts.reduce((a, b) => a + b, 0n) / BigInt(this.gasCosts.length || 1);
    }

    /**
     * Returns the best known estimate of the gas cost (in wei) of a trade tx for the
     * given order pair, the pair's dryrun gas cache priced at the current gas price
     * when it holds enough samples, as it tracks the pair's own route at the gas
     * price of the moment, otherwise the average of the recent successful txs when
     * there is any, undefined when neither is available
     * @param pair - The order pair
     */
    getGasCostEstimate(pair: Pair): bigint | undefined {
        const cached = this.dryrunGasCache.get(DryrunGasCache.key(pair));
        if (cached) {
            const gasLimit = (cached.gas * BigInt(this.appOptions.gasLimitMultiplier)) / 100n;
            return gasLimit * this.gasPrice + cached.l1Cost;
        }
        if (this.gasCosts.length) return this.avgGasCost;
        return undefined;
    }

    /** Whether any of the dust checks is enabled by the app options */
    get isDustCheckEnabled(): boolean {
        return this.appOptions.dustGasCostMultiplier > 0 || this.appOptions.dustUsdThreshold > 0;
    }

    /**
     * Determines if a trade of the given order pair is dust by the dust checks enabled
     * in the app options, the gas cost check, where the trade value cannot cover the gas
     * cost of the trade tx scaled by the multiplier, and the usd check, where the trade
     * value is below the usd threshold, when both are enabled a trade is dust only if
     * both say so, when only one is enabled that one decides on its own, a dust trade can
     * never be profitable since the bounty of a trade is always a share of the market
     * value of the output tokens it takes, so the trade value is the trade size of the
     * pair's output token priced by the output token eth price, the gas cost comes from
     * the given one when known, otherwise from the best known estimate for the pair
     * @param pair - The order pair
     * @param outputToEthPrice - The output token eth price as decimal string, empty or undefined when unknown
     * @param gasTokenUsdPrice - The gas token usd price as decimal string, undefined when unknown
     * @param size - The trade size (18 fixed point decimals), defaults to the pair's quoted max output
     * @param gasCost - The known gas cost of the trade tx (wei), defaults to the pair's gas cost estimate
     * @returns True when the trade is dust, false when it is not, undefined when no dust check is
     * enabled or an enabled check cannot be evaluated for lack of its inputs while no other
     * enabled check has ruled the trade out as not dust
     */
    isDustTrade(
        pair: Pair,
        outputToEthPrice: string | undefined,
        gasTokenUsdPrice: string | undefined,
        size = pair.takeOrder.quote?.maxOutput,
        gasCost?: bigint,
    ): boolean | undefined {
        if (!this.isDustCheckEnabled || !outputToEthPrice || size === undefined) {
            return undefined;
        }
        const tradeValue = toEthValue(size, outputToEthPrice);
        const verdicts: (boolean | undefined)[] = [];

        // gas cost check, undecided without a known gas cost
        const { dustGasCostMultiplier, dustUsdThreshold } = this.appOptions;
        if (dustGasCostMultiplier > 0) {
            const cost = gasCost ?? this.getGasCostEstimate(pair);
            // keep 4 decimal points of the multiplier precision
            const multiplier = BigInt(Math.round(dustGasCostMultiplier * 10_000));
            verdicts.push(
                cost === undefined || cost <= 0n
                    ? undefined
                    : tradeValue < (cost * multiplier) / 10_000n,
            );
        }

        // usd value check, undecided without a known gas token usd price
        if (dustUsdThreshold > 0) {
            verdicts.push(
                gasTokenUsdPrice
                    ? toUsdValue(tradeValue, gasTokenUsdPrice) <
                          parseUnits(dustUsdThreshold.toFixed(18), 18)
                    : undefined,
            );
        }

        if (verdicts.includes(false)) return false;
        if (verdicts.includes(undefined)) return undefined;
        return true;
    }

    /**
     * Watches gas price during runtime by reading it periodically
     * @param interval - Interval to update gas price in milliseconds, default is 20 seconds
     */
    watchGasPrice(interval = 20_000) {
        this.gasManager.watchGasPrice(interval);
    }

    /** Unwatches gas price if the watcher has been already active */
    unwatchGasPrice() {
        this.gasManager.unwatchGasPrice();
    }

    /** Whether the block number watcher is active */
    get isWatchingBlockNumber(): boolean {
        return this.blockNumberWatcher !== undefined || this.wsBlockNumberUnwatcher !== undefined;
    }

    /**
     * Whether the block number is polled over http, on an interval, also while
     * it does not move. Over ws a head comes only with a new block, see
     * blockNumberReadAt
     */
    get isPollingBlockNumber(): boolean {
        return this.blockNumberWatcher !== undefined;
    }

    /**
     * Updates the block number by reading the latest block from the rpc once,
     * its base fee goes to the gas fees, see GasManager.setBaseFee, keeps the
     * previous values if the call fails
     */
    async updateBlockNumber() {
        const block = await this.client.getBlock().catch(() => undefined);
        if (typeof block?.number === "bigint") {
            this.gasManager.setBaseFee(block.baseFeePerGas);
            // a read block is always a sealed one
            this.setBlockNumbers(block.number, block.number);
        }
    }

    /**
     * Sets the observed and the canonical block numbers, each only ever moves up,
     * a canonical block number advance triggers a pool update up to it and calls
     * the block listeners, see onBlockNumber. Each call is a read, so it moves
     * blockNumberReadAt
     * @param blockNumber - The observed block number
     * @param canonicalBlockNumber - The sealed block number
     */
    private setBlockNumbers(blockNumber: bigint, canonicalBlockNumber: bigint) {
        this.blockNumberReadAt = Date.now();
        if (blockNumber > this.blockNumber) {
            this.blockNumber = blockNumber;
        }
        if (canonicalBlockNumber > this.canonicalBlockNumber) {
            this.canonicalBlockNumber = canonicalBlockNumber;
            this.updatePools();
            // the gas fees are fetched every gasFeeBlockInterval sealed blocks
            this.gasManager.onBlock(canonicalBlockNumber);
            for (const listener of this.blockListeners) {
                try {
                    listener(canonicalBlockNumber);
                } catch {
                    // a listener's failure is its own
                }
            }
        }
    }

    /**
     * Registers a listener of the sealed block number, called on each advance
     * of the sealed block number with the new number, in the order the
     * listeners registered, a jump of more than one block calls it once
     * @param listener - The listener
     * @returns A function that removes the listener
     */
    onBlockNumber(listener: (blockNumber: bigint) => void): () => void {
        this.blockListeners.add(listener);
        return () => {
            this.blockListeners.delete(listener);
        };
    }

    /**
     * Opens the socket of the ws client when there is none, or when the one in
     * viem's socket cache is closing or closed, see reopenClosedWsSocket. Call
     * it right before a subscription of the ws client. The opening is in the
     * cache at once, so the subscription takes this socket whenever it comes,
     * see openSharedWsSocket. A failed opening fails the subscription at once
     * and opens again after its own delay. The socket is the one of the
     * subscriptions, apart from the socket of the rpc requests of the same url,
     * see WsSocketKey. It has no reconnect of its own, viem's reconnect timers
     * can open sockets that nothing uses, so each subscription opens again
     * after an error instead, through this
     */
    openWsSocket() {
        const url = this.activeWsUrl;
        if (url) void reopenClosedWsSocket(url, WS_RPC_SOCKET_OPTIONS, WsSocketKey.Subscription);
    }

    /**
     * The url the subscriptions use now, the main url of the ws rpc, or its
     * fallback url while that is in use, see onWsFailure
     */
    get activeWsUrl(): string | undefined {
        return this.wsOnFallback ? this.appOptions.wsRpcFallback : this.appOptions.wsRpc;
    }

    /**
     * Counts a failed new heads subscription of the block watcher on the main
     * url of the ws rpc, see subscribeToBlockNumber, and moves the subscriptions
     * to its fallback url after WS_FAILURES_TO_FALLBACK in a row. A head that
     * comes on the main url ends the failures in a row. The main socket is
     * closed, so the subscriptions on it get an error, and they subscribe again
     * on the fallback after their own delay, its socket opens only then. The
     * main url is then tried every WS_MAIN_PROBE_INTERVAL, see probeWsMain. A
     * failure on the fallback url, or with no fallback url, changes nothing
     * @param url - The url of the subscription that failed
     */
    private onWsFailure(url: string | undefined) {
        const { wsRpc, wsRpcFallback } = this.appOptions;
        if (!wsRpc || !wsRpcFallback || this.wsOnFallback || url !== wsRpc) return;
        if (++this.wsFailures < WS_FAILURES_TO_FALLBACK) return;
        this.wsOnFallback = true;
        this.wsFailures = 0;
        this.dropWsSocket(wsRpc);
        this.startWsProbes();
    }

    /** Starts the probes of the main ws rpc url, one every WS_MAIN_PROBE_INTERVAL, see probeWsMain */
    private startWsProbes() {
        clearInterval(this.wsProbeTimer);
        this.wsProbeTimer = setInterval(() => this.probeWsMain(), WS_MAIN_PROBE_INTERVAL);
        // the probes must not keep the process alive on their own
        this.wsProbeTimer.unref?.();
    }

    /** Stops the probes of the main ws rpc url, and ends the one that runs, see probeWsMain */
    private stopWsProbes() {
        clearInterval(this.wsProbeTimer);
        this.wsProbeTimer = undefined;
        this.stopWsProbe(false);
    }

    /**
     * Tries the main url of the ws rpc while its fallback url is in use: a probe
     * subscribes to the heads on the main url, on its subscription socket, and
     * moves the subscriptions back on its first head that is not behind the
     * bot's block number at the probe start, see canonicalBlockNumber, and not
     * more than WS_PROBE_MAX_LAG behind it when it comes, a head is the same
     * sign that ends the failures in a row, see onWsFailure. An
     * open socket alone proves nothing, it can drop soon after or never answer
     * the subscribe. The fallback socket is then closed, so the subscriptions
     * on it get an error and subscribe again on the main url after their own
     * delay. A probe that fails, or that has no such head by the next probe,
     * ends and its socket is dropped, so the next probe opens a new one. A
     * failed opening opens nothing again by itself. No probe opens while
     * WS_MAX_OPENINGS openings of the main url still run, see wsOpeningsAtLimit
     */
    private probeWsMain() {
        const main = this.appOptions.wsRpc;
        if (!main || !this.wsOnFallback) return;
        this.stopWsProbe(true);
        // an opening that timed out still runs until its handshake ends
        if (wsOpeningsAtLimit(main, WsSocketKey.Subscription)) return;
        const key = `${WsSocketKey.Subscription}:${main}`;
        const opening = reopenClosedWsSocket(main, WS_RPC_SOCKET_OPTIONS, WsSocketKey.Subscription);
        opening?.catch(() => {
            if (socketClientCache.get(key) === (opening as any)) socketClientCache.delete(key);
        });
        this.wsProbeClient ??= createPublicClient({
            chain: this.chainConfig,
            transport: subscriptionWebSocket(main, WS_RPC_SOCKET_OPTIONS),
        });
        // the bot's block number at the probe start, the fallback heads raise it
        // while the probe runs, and a main in sync can send each head a bit later
        const target = this.canonicalBlockNumber;
        // the most blocks a head can be behind the bot's block number when it
        // comes, so a main that stays behind does not pass, see WS_PROBE_MAX_LAG
        const lag = Math.ceil(WS_PROBE_MAX_LAG / this.appOptions.blockTime);
        const maxLag = BigInt(lag > 1 ? lag : 1);
        this.wsProbeUnsubscribe = subscribeToHeads(
            this.wsProbeClient,
            this.appOptions.flashblocks ? "newFlashblocks" : "newHeads",
            (blockNumber) => {
                // a main behind the bot's block number, a node that still syncs,
                // waits for a head that caught up, the block number never moves down
                const sealed = this.appOptions.flashblocks ? blockNumber - 1n : blockNumber;
                if (sealed < target || this.canonicalBlockNumber - sealed > maxLag) return;
                this.stopWsProbe(false);
                if (this.wsOnFallback) this.useWsMain();
            },
            () => this.stopWsProbe(true),
        );
    }

    /**
     * Ends the probe that runs, if any, see probeWsMain, the socket of a failed
     * one is dropped, nothing else uses the main socket while it runs
     * @param failed - Whether the probe failed
     */
    private stopWsProbe(failed: boolean) {
        if (!this.wsProbeUnsubscribe) return;
        this.wsProbeUnsubscribe();
        this.wsProbeUnsubscribe = undefined;
        if (failed && this.appOptions.wsRpc) this.dropWsSocket(this.appOptions.wsRpc);
    }

    /** Moves the subscriptions back to the main url of the ws rpc, see probeWsMain */
    private useWsMain() {
        this.wsOnFallback = false;
        this.wsFailures = 0;
        this.stopWsProbes();
        if (this.appOptions.wsRpcFallback) this.dropWsSocket(this.appOptions.wsRpcFallback);
    }

    /**
     * Drops the subscription socket of a ws url, a client is closed, so the
     * subscriptions on it get an error and subscribe again, and an opening is
     * dropped from the cache, so it opens nothing again by itself. An opening
     * still runs, and a subscription that waits for it takes its socket, so its
     * client is closed once it opens, unless the url is in use again by then
     * @param url - The ws url
     */
    private dropWsSocket(url: string) {
        const key = `${WsSocketKey.Subscription}:${url}`;
        const cached: unknown = socketClientCache.get(key);
        if (cached instanceof Promise) {
            cached.then(
                (client: { close(): void }) => {
                    if (url !== this.activeWsUrl) client.close();
                },
                () => {},
            );
        } else {
            (cached as { close?: () => void } | undefined)?.close?.();
        }
        socketClientCache.delete(key);
    }

    /**
     * The ws client, one socket for every subscription, created on first use,
     * undefined when no ws rpc is configured. Its socket is apart from the one of
     * the rpc requests, a ws rpc of the same url included, see
     * subscriptionWebSocket, its socket options are the ones of the ws rpcs, see
     * WS_RPC_SOCKET_OPTIONS. A subscription takes the socket that openWsSocket
     * opens, each subscription opens again after an error
     */
    getWsClient(): PublicClient | undefined {
        if (!this.appOptions.wsRpc) return undefined;
        if (!this.wsClient) {
            this.wsClient = createPublicClient({
                chain: this.chainConfig,
                // each subscribe takes the url in use then, see activeWsUrl
                transport: subscriptionWebSocket(
                    () => this.activeWsUrl as string,
                    WS_RPC_SOCKET_OPTIONS,
                ),
            });
        }
        return this.wsClient;
    }

    /**
     * Updates the sushi router pools data up to the canonical block number,
     * that is applies the pool events since the last update, only one update
     * runs at a time, a new block during an update does not start another one,
     * the next block picks the gap up, a failed update is dropped the same way,
     * a newly created pool observed by the update raises the newPoolCreated flag
     */
    private async updatePools() {
        const sushi = this.router.sushi;
        if (!sushi || this.poolUpdateInFlight) return;
        this.poolUpdateInFlight = true;
        try {
            if (await sushi.update(this.canonicalBlockNumber)) {
                this.newPoolCreated = true;
            }
        } catch {
            // the next block picks the gap up
        } finally {
            this.poolUpdateInFlight = false;
        }
    }

    /**
     * Watches the chain's block number during runtime, an immediate update is
     * fired on start so the value becomes available asap, if a websocket rpc is
     * configured, the block number is kept up-to-date by a new heads subscription
     * for the earliest possible updates, with polling acting as a fallback while
     * the subscription errors, otherwise it is polled periodically over http
     * @param interval - Interval to poll block number in milliseconds
     */
    watchBlockNumber(interval: number) {
        if (this.isWatchingBlockNumber) return;
        this.updateBlockNumber();
        const wsClient = this.getWsClient();
        if (wsClient) {
            // an unwatch on the fallback url stopped its probes, see unwatchBlockNumber
            if (this.wsOnFallback) this.startWsProbes();
            this.subscribeToBlockNumber(wsClient, interval);
        } else {
            this.startPollingBlockNumber(interval);
        }
    }

    /**
     * Unwatches block number if the watcher has been already active, the probes
     * of the main ws rpc url stop too, they follow the failures of the watcher,
     * see onWsFailure, a new watch on the fallback url starts them again
     */
    unwatchBlockNumber() {
        this.stopPollingBlockNumber();
        this.clearWsResubscribeTimer();
        this.wsBlockNumberUnwatcher?.();
        this.wsBlockNumberUnwatcher = undefined;
        this.stopWsProbes();
    }

    /**
     * Establishes the ws subscription for block number updates, new heads by
     * default, or flashblocks heads (newFlashblocks) when enabled by config,
     * an errored subscription degrades to polling and schedules a fresh
     * subscription after a delay, on a new socket when the old one is closed,
     * see openWsSocket, when the ws endpoint is still
     * down, the fresh subscription errors again and re-enters this path,
     * which forms a retry loop paced by the delay, with polling covering
     * the block number updates for the whole outage. Its failures on the main
     * ws rpc url move the subscriptions to the fallback url, see onWsFailure
     */
    private subscribeToBlockNumber(wsClient: PublicClient, interval: number) {
        // the url of this subscription, its failure and its heads count for it,
        // see onWsFailure, it can report its error more than once, it fails once
        const url = this.activeWsUrl;
        let failed = false;
        const onBlockNumber = (blockNumber: bigint, baseFeePerGas?: bigint | null) => {
            // a head on the main url ends its failures in a row
            if (url === this.appOptions.wsRpc) this.wsFailures = 0;
            // a flashblock head belongs to the block being built, so the
            // sealed block is the one below it, a new head is sealed itself
            const sealed = this.appOptions.flashblocks ? blockNumber - 1n : blockNumber;
            if (sealed > this.wsBlockNumber) this.wsBlockNumber = sealed;
            this.gasManager.setBaseFee(baseFeePerGas);
            this.setBlockNumbers(blockNumber, sealed);
            // subscription is healthy, so stop the polling fallback
            // and cancel any pending resubscribe if active
            this.stopPollingBlockNumber();
            this.clearWsResubscribeTimer();
        };
        const onError = () => {
            if (!failed) {
                failed = true;
                this.onWsFailure(url);
            }
            this.startPollingBlockNumber(interval);
            if (this.wsResubscribeTimer === undefined) {
                this.wsResubscribeTimer = setTimeout(() => {
                    this.wsResubscribeTimer = undefined;
                    this.wsBlockNumberUnwatcher?.();
                    this.subscribeToBlockNumber(wsClient, interval);
                }, WS_RESUBSCRIBE_DELAY);
            }
        };
        // the subscription below takes the socket that is open or opening, a
        // closed one is opened again first, see openWsSocket
        this.openWsSocket();
        // both heads carry the base fee, the gas fees follow it, see GasManager.setBaseFee
        this.wsBlockNumberUnwatcher = subscribeToHeads(
            wsClient,
            this.appOptions.flashblocks ? "newFlashblocks" : "newHeads",
            onBlockNumber,
            onError,
        );
    }

    /** Cancels the pending ws resubscribe if there is one scheduled */
    private clearWsResubscribeTimer() {
        if (this.wsResubscribeTimer !== undefined) {
            clearTimeout(this.wsResubscribeTimer);
            this.wsResubscribeTimer = undefined;
        }
    }

    /** Starts polling block number periodically, no-op if already polling */
    private startPollingBlockNumber(interval: number) {
        if (this.blockNumberWatcher !== undefined) return;
        this.blockNumberWatcher = setInterval(() => this.updateBlockNumber(), interval);
    }

    /** Stops polling block number if the poller is active */
    private stopPollingBlockNumber() {
        if (this.blockNumberWatcher !== undefined) {
            clearInterval(this.blockNumberWatcher);
            this.blockNumberWatcher = undefined;
        }
    }

    /** Watches the given token by putting on the watchedToken map */
    watchToken(tokenDetails: TokenDetails) {
        if (!this.watchedTokens.has(tokenDetails.address.toLowerCase())) {
            this.watchedTokens.set(tokenDetails.address.toLowerCase(), tokenDetails);
        }
    }

    /**
     * Updates the native gas token dollar price by quoting the chain's wrapped
     * native token against the chain's dollar token (USDC or USDT), keeps the
     * previous price if the quote fails, does nothing if the operating chain
     * has no known dollar token
     * @param blockNumber - (optional) The block number to fetch the price at
     */
    async updateGasTokenUsdPrice(blockNumber?: bigint) {
        const usdToken = this.chainConfig.usdToken;
        if (!usdToken) return;
        const result = await this.getMarketPrice(
            this.chainConfig.nativeWrappedToken,
            usdToken,
            blockNumber,
            true,
        );
        if (result.isOk()) {
            this.gasTokenUsdPrice = result.value.price;
        }
    }

    /**
     * Get the market price for a token pair
     * @param fromToken - The token to sell
     * @param toToken - The token to buy
     * @param blockNumber - (optional) The block number to fetch the price at
     * @param skipFetch - (optional) Skips a fresh onchain call to fetch pools
     * @returns The market price for the token pair or undefined if no route were found
     */
    async getMarketPrice(
        fromToken: Token,
        toToken: Token,
        blockNumber?: bigint,
        skipFetch?: boolean,
    ) {
        const amountIn = parseUnits("1", fromToken.decimals);
        const result = await this.router.getMarketPrice({
            fromToken,
            toToken,
            blockNumber,
            gasPrice: this.gasPrice,
            amountIn,
            sushiRouteType: this.appOptions.route,
            skipFetch: !!skipFetch,
        });
        if (
            result.isOk() &&
            (!result.value.route ||
                typeof result.value.route.priceImpact === "undefined" ||
                result.value.route.priceImpact <= DEFAULT_PRICE_IMPACT_TOLERANCE)
        ) {
            return result;
        }
        const partialAmountIn = this.router.findLargestTradeSize(
            { takeOrder: { quote: { ratio: 0n } } } as any, // ratio unused when absolute
            toToken,
            fromToken,
            amountIn,
            this.gasPrice,
            this.appOptions.route,
            true, // absolute
        );
        if (partialAmountIn.status !== TradeSizeStatus.Found) {
            return result;
        }
        // build the partial market price directly from the size search winning
        // probe quote instead of recomputing the same route for the same size
        return Result.ok({
            price: formatUnits(partialAmountIn.quote.price, 18),
            route: partialAmountIn.quote.route.route,
        });
    }
}
