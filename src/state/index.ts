import { RpcState } from "../rpc";
import { ChainId } from "sushi/chain";
import { DeployerAbi } from "../abis";
import { AppOptions } from "../config";
import { errorSnapshot } from "../error";
import { getGasPrice } from "./gasPrice";
import { LiquidityProviders } from "sushi";
import { processLiquidityProviders } from "./lps";
import { rainSolverTransport } from "../transport";
import { ChainConfig, getChainConfig } from "./chain";
import { createPublicClient, PublicClient } from "viem";

/**
 * Rain dispair contracts, deployer, store and interpreter
 */
export type Dispair = {
    deployer: string;
    interpreter: string;
    store: string;
};

export type TokenDetails = {
    address: string;
    decimals: number;
    symbol: string;
};

/**
 * SharedState configuration that holds required data for instantiating SharedState
 */
export type SharedStateConfig = {
    /** Dispair, deployer, store and interpreter addresses */
    dispair: Dispair;
    /** Wallet private key or mnemonic key */
    walletKey: string;
    /** List of watched tokens at runtime */
    watchedTokens?: Map<string, TokenDetails>;
    /** List of active liquidity providers */
    liquidityProviders?: LiquidityProviders[];
    /** A viem client used for general read calls */
    client: PublicClient;
    /** Chain configuration */
    chainConfig: ChainConfig;
    /** Initial gas price */
    initGasPrice?: bigint;
    /** Initial L1 gas price, if the chain is L2, otherwise, this is ignored */
    initL1GasPrice?: bigint;
    /** Rain solver rpc state, manages and keeps track of rpcs during runtime */
    rpcState: RpcState;
    /** A rpc state for write rpcs */
    writeRpcState?: RpcState;
    /** Optional multiplier for gas price */
    gasPriceMultiplier?: number;
};
export namespace SharedStateConfig {
    export async function tryFromAppOptions(options: AppOptions): Promise<SharedStateConfig> {
        const rpcState = new RpcState(options.rpc);
        const writeRpcState = options.writeRpc ? new RpcState(options.writeRpc) : undefined;

        // use temp client to get chain id
        let client = createPublicClient({
            transport: rainSolverTransport(rpcState, { timeout: options.timeout }),
        }) as any;

        // get chain config
        const chainId = await client.getChainId();
        const chainConfig = getChainConfig(chainId as ChainId);
        if (!chainConfig) {
            throw `Cannot find configuration for the network with chain id: ${chainId}`;
        }

        // re-assign the client with static chain data
        client = createPublicClient({
            chain: chainConfig,
            transport: rainSolverTransport(rpcState, { timeout: options.timeout }),
        });

        const getDispairAddress = async (functionName: "iInterpreter" | "iStore") => {
            try {
                return await client.readContract({
                    address: options.dispair as `0x${string}`,
                    abi: DeployerAbi,
                    functionName,
                });
            } catch (error) {
                throw errorSnapshot(`failed to get dispair ${functionName} address`, error);
            }
        };
        const interpreter = await getDispairAddress("iInterpreter");
        const store = await getDispairAddress("iStore");

        const config: SharedStateConfig = {
            client,
            rpcState,
            writeRpcState,
            chainConfig,
            walletKey: (options.key ?? options.mnemonic)!,
            gasPriceMultiplier: options.gasPriceMultiplier,
            liquidityProviders: processLiquidityProviders(options.liquidityProviders),
            dispair: {
                interpreter,
                store,
                deployer: options.dispair,
            },
        };

        // try to get init gas price
        // ignores any error, since gas prices will be fetched periodically during runtime
        const result = await getGasPrice(client, chainConfig, options.gasPriceMultiplier).catch(
            () => undefined,
        );
        if (!result) return config;
        const { gasPrice, l1GasPrice } = result;
        if (!gasPrice.error) {
            config.initGasPrice = gasPrice.value;
        }
        if (!l1GasPrice.error) {
            config.initL1GasPrice = l1GasPrice.value;
        }

        return config;
    }
}

/**
 * Maintains the shared state for RainSolver runtime operations, holds chain
 * configuration, dispair addresses, RPC state, wallet key, watched tokens,
 * liquidity provider information required for application execution and also
 * watches the gas price during runtime by reading it periodically
 */
export class SharedState {
    /** Dispair, deployer, store and interpreter addresses */
    readonly dispair: Dispair;
    /** Wallet private key or mnemonic key */
    readonly walletKey: string;
    /** Chain configurations */
    readonly chainConfig: ChainConfig;
    /** List of watched tokens at runtime */
    readonly watchedTokens: Map<string, TokenDetails> = new Map();
    /** List of supported liquidity providers */
    readonly liquidityProviders?: LiquidityProviders[];
    /** A public viem client used for general read calls (without any wallet functionalities) */
    readonly client: PublicClient;
    /** Option to multiply the gas price fetched from the rpc as percentage, default is 100, ie no change */
    readonly gasPriceMultiplier: number = 100;

    /** Current gas price of the operating chain */
    gasPrice = 0n;
    /** Current L1 gas price of the operating chain, if the chain is a L2 chain, otherwise it is set to 0 */
    l1GasPrice = 0n;
    /** Keeps the app's RPC state */
    rpc: RpcState;
    /** Keeps the app's write RPC state */
    writeRpc?: RpcState;

    private gasPriceWatcher: NodeJS.Timeout | undefined;

    constructor(config: SharedStateConfig) {
        this.client = config.client;
        this.dispair = config.dispair;
        this.walletKey = config.walletKey;
        this.chainConfig = config.chainConfig;
        this.liquidityProviders = config.liquidityProviders;
        this.rpc = config.rpcState;
        this.writeRpc = config.writeRpcState;
        if (typeof config.gasPriceMultiplier === "number") {
            this.gasPriceMultiplier = config.gasPriceMultiplier;
        }
        if (typeof config.initGasPrice === "bigint") {
            this.gasPrice = config.initGasPrice;
        }
        if (typeof config.initL1GasPrice === "bigint") {
            this.l1GasPrice = config.initL1GasPrice;
        }
        if (config.watchedTokens) {
            this.watchedTokens = config.watchedTokens;
        }
        this.watchGasPrice();
    }

    get isWatchingGasPrice(): boolean {
        if (this.gasPriceWatcher) return true;
        else return false;
    }

    /**
     * Watches gas price during runtime by reading it periodically
     * @param interval - Interval to update gas price in milliseconds, default is 20 seconds
     */
    watchGasPrice(interval = 20_000) {
        if (this.isWatchingGasPrice) return;
        this.gasPriceWatcher = setInterval(async () => {
            const result = await getGasPrice(
                this.client,
                this.chainConfig,
                this.gasPriceMultiplier,
            ).catch(() => undefined);
            if (!result) return;

            // update gas prices that resolved successfully
            const { gasPrice, l1GasPrice } = result;
            if (!gasPrice.error) {
                this.gasPrice = gasPrice.value;
            }
            if (!l1GasPrice.error) {
                this.l1GasPrice = l1GasPrice.value;
            }
        }, interval);
    }

    /** Unwatches gas price if the watcher has been already active */
    unwatchGasPrice() {
        if (this.isWatchingGasPrice) {
            clearInterval(this.gasPriceWatcher);
            this.gasPriceWatcher = undefined;
        }
    }

    /** Watches the given token by putting on the watchedToken map */
    watchToken(tokenDetails: TokenDetails) {
        if (!this.watchedTokens.has(tokenDetails.address.toLowerCase())) {
            this.watchedTokens.set(tokenDetails.address.toLowerCase(), tokenDetails);
        }
    }
}
