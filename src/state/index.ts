import { GasManager } from "../gas";
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
import { RainSolverRouterError } from "../router/error";
import { ChainConfig, ChainConfigError, getChainConfig } from "./chain";
import { RpcState, rainSolverTransport, RainSolverTransportConfig } from "../rpc";
import {
    webSocket,
    parseUnits,
    formatUnits,
    hexToBigInt,
    PublicClient,
    createPublicClient,
    ReadContractErrorType,
} from "viem";

/** Delay (in ms) before an errored ws new heads subscription is re-established */
export const WS_RESUBSCRIBE_DELAY = 15_000;

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
 * @param onBlockNumber - Called with the flashblock head block number
 * @param onError - Called when the subscription errors
 * @returns A function that unsubscribes
 */
export function subscribeToFlashblocks(
    wsClient: PublicClient,
    onBlockNumber: (blockNumber: bigint) => void,
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
                params: ["newFlashblocks"],
                onData(data: any) {
                    if (!active) return;
                    const number = data?.result?.number;
                    if (typeof number === "string" && HEX_QUANTITY_PATTERN.test(number)) {
                        onBlockNumber(hexToBigInt(number as `0x${string}`));
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
        const rpcState = new RpcState(options.rpc);
        const writeRpcState = options.writeRpc ? new RpcState(options.writeRpc) : undefined;

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
                baseGasPriceMultiplier: options.gasPriceMultiplier,
                txTimeThreshold: options.txTimeThreshold,
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
    /** Oracle endpoint health tracking for cooloff */
    oracleHealth: OracleHealthMap = new Map();
    /** The current native gas token to USD price (18 decimals fixed point number as decimal string), updated once per round */
    gasTokenUsdPrice?: string;
    /** The latest observed block number of the operating chain, kept up-to-date by the block number watcher, the block being built when subscribed to flashblocks */
    blockNumber = 0n;
    /** The latest sealed (canonical) block number of the operating chain, one below the observed block number when subscribed to flashblocks, equal to it otherwise */
    canonicalBlockNumber = 0n;
    /** Set when a pool update observed a newly created pool, cleared by the consumer once acted on */
    newPoolCreated = false;
    /** Whether a pool update is in flight, a new block does not start another one meanwhile */
    private poolUpdateInFlight = false;

    private blockNumberWatcher: ReturnType<typeof setInterval> | undefined;
    private wsBlockNumberUnwatcher: (() => void) | undefined;
    private wsResubscribeTimer: ReturnType<typeof setTimeout> | undefined;

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

    /** Current gas price of the operating chain */
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

    /** A multiplier for the gas price fetched from the rpc as percentage */
    get gasPriceMultiplier(): number {
        return this.gasManager.gasPriceMultiplier;
    }
    set gasPriceMultiplier(value: number) {
        this.gasManager.gasPriceMultiplier = value;
    }

    get isWatchingGasPrice(): boolean {
        return this.gasManager.isWatchingGasPrice;
    }

    /** Returns the average gas cost of the successful transactions */
    get avgGasCost(): bigint {
        return this.gasCosts.reduce((a, b) => a + b, 0n) / BigInt(this.gasCosts.length || 1);
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
     * Updates the block number by reading it from the rpc once,
     * keeps the previous value if the call fails
     */
    async updateBlockNumber() {
        const blockNumber = await this.client.getBlockNumber().catch(() => undefined);
        if (typeof blockNumber === "bigint") {
            // a read block number is always a sealed one
            this.setBlockNumbers(blockNumber, blockNumber);
        }
    }

    /**
     * Sets the observed and the canonical block numbers, each only ever moves up,
     * a canonical block number advance triggers a pool update up to it
     * @param blockNumber - The observed block number
     * @param canonicalBlockNumber - The sealed block number
     */
    private setBlockNumbers(blockNumber: bigint, canonicalBlockNumber: bigint) {
        if (blockNumber > this.blockNumber) {
            this.blockNumber = blockNumber;
        }
        if (canonicalBlockNumber > this.canonicalBlockNumber) {
            this.canonicalBlockNumber = canonicalBlockNumber;
            this.updatePools();
        }
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
        if (this.appOptions.wsRpc) {
            const wsClient = createPublicClient({
                chain: this.chainConfig,
                transport: webSocket(this.appOptions.wsRpc, {
                    keepAlive: true,
                    reconnect: true,
                }),
            });
            this.subscribeToBlockNumber(wsClient, interval);
        } else {
            this.startPollingBlockNumber(interval);
        }
    }

    /** Unwatches block number if the watcher has been already active */
    unwatchBlockNumber() {
        this.stopPollingBlockNumber();
        this.clearWsResubscribeTimer();
        this.wsBlockNumberUnwatcher?.();
        this.wsBlockNumberUnwatcher = undefined;
    }

    /**
     * Establishes the ws subscription for block number updates, new heads by
     * default, or flashblocks heads (newFlashblocks) when enabled by config,
     * an errored subscription degrades to polling and schedules a fresh
     * subscription after a delay, since viem reconnects the dropped socket
     * but does not replay its subscriptions, when the ws endpoint is still
     * down, the fresh subscription errors again and re-enters this path,
     * which forms a retry loop paced by the delay, with polling covering
     * the block number updates for the whole outage
     */
    private subscribeToBlockNumber(wsClient: PublicClient, interval: number) {
        const onBlockNumber = (blockNumber: bigint) => {
            // a flashblock head belongs to the block being built, so the
            // sealed block is the one below it, a new head is sealed itself
            this.setBlockNumbers(
                blockNumber,
                this.appOptions.flashblocks ? blockNumber - 1n : blockNumber,
            );
            // subscription is healthy, so stop the polling fallback
            // and cancel any pending resubscribe if active
            this.stopPollingBlockNumber();
            this.clearWsResubscribeTimer();
        };
        const onError = () => {
            this.startPollingBlockNumber(interval);
            if (this.wsResubscribeTimer === undefined) {
                this.wsResubscribeTimer = setTimeout(() => {
                    this.wsResubscribeTimer = undefined;
                    this.wsBlockNumberUnwatcher?.();
                    this.subscribeToBlockNumber(wsClient, interval);
                }, WS_RESUBSCRIBE_DELAY);
            }
        };
        if (this.appOptions.flashblocks) {
            this.wsBlockNumberUnwatcher = subscribeToFlashblocks(wsClient, onBlockNumber, onError);
        } else {
            this.wsBlockNumberUnwatcher = wsClient.watchBlockNumber({ onBlockNumber, onError });
        }
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
