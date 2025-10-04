import { ChainId } from "sushi/chain";
import { AppOptions } from "../config";
import { Token } from "sushi/currency";
import { BalancerRouter } from "../router";
import { LiquidityProviders } from "sushi";
import { SolverContracts } from "./contracts";
import { SushiRouter } from "../router/sushi";
import { AddressProvider } from "@balancer/sdk";
import { WalletConfig } from "../wallet/config";
import { Result, TokenDetails } from "../common";
import { RainSolverRouter } from "../router/router";
import { SubgraphConfig } from "../subgraph/config";
import { RainSolverBaseError } from "../error/types";
import { OrderManagerConfig } from "../order/config";
import { RainSolverRouterError } from "../router/error";
import { ChainConfig, ChainConfigError, getChainConfig } from "./chain";
import { RpcState, rainSolverTransport, RainSolverTransportConfig } from "../rpc";
import { createPublicClient, parseUnits, PublicClient, ReadContractErrorType } from "viem";
import { GasManager } from "../gas";

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

    /** Keeps the app's RPC state */
    rpc: RpcState;
    /** Keeps the app's write RPC state */
    writeRpc?: RpcState;
    /** List of latest successful transactions gas costs */
    gasCosts: bigint[] = [];

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

    /** Watches the given token by putting on the watchedToken map */
    watchToken(tokenDetails: TokenDetails) {
        if (!this.watchedTokens.has(tokenDetails.address.toLowerCase())) {
            this.watchedTokens.set(tokenDetails.address.toLowerCase(), tokenDetails);
        }
    }

    /**
     * Get the market price for a token pair
     * @param fromToken - The token to sell
     * @param toToken - The token to buy
     * @param blockNumber - (optional) The block number to fetch the price at
     * @returns The market price for the token pair or undefined if no route were found
     */
    getMarketPrice(fromToken: Token, toToken: Token, blockNumber?: bigint) {
        return this.router.getMarketPrice({
            fromToken,
            toToken,
            blockNumber,
            gasPrice: this.gasPrice,
            amountIn: parseUnits("1", fromToken.decimals),
            sushiRouteType: this.appOptions.route,
            skipFetch: false,
        });
    }
}
