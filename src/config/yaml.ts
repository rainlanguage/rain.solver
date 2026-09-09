import assert from "assert";
import { parse } from "yaml";
import { readFileSync } from "fs";
import { RpcConfig } from "../rpc";
import { parseUnits } from "viem";
import { Result } from "../common";
import { SgFilter } from "../subgraph/filter";
import { AppOptionsError, AppOptionsErrorType } from "./error";
import { FLOAT_PATTERN, INT_PATTERN, Validator } from "./validators";

/** Represents a type for self-funding vaults from config */
export type SelfFundVault = {
    token: string;
    vaultId: string;
    orderbook: string;
    threshold: string;
    topupAmount: string;
};

/**
 * Specifies the enabled trade types for each orderbook address.
 * If an orderbook address is not present in any of the sets, it
 * means that all trade types are enabled for that orderbook.
 */
export type OrderbookTradeTypes = {
    router: Set<string>;
    interOrderbook: Set<string>;
    intraOrderbook: Set<string>;
    raindexRouter: Set<string>;
};

/** Represents a type for app options contracts addresses */
export type AppOptionsContracts = {
    v4?: {
        sushiArb?: `0x${string}`;
        dispair?: `0x${string}`;
        genericArb?: `0x${string}`;
        balancerArb?: `0x${string}`;
        stabullArb?: `0x${string}`;
    };
    v5?: {
        sushiArb?: `0x${string}`;
        dispair?: `0x${string}`;
        genericArb?: `0x${string}`;
        balancerArb?: `0x${string}`;
        stabullArb?: `0x${string}`;
    };
    v6?: {
        sushiArb?: `0x${string}`;
        dispair?: `0x${string}`;
        genericArb?: `0x${string}`;
        balancerArb?: `0x${string}`;
        stabullArb?: `0x${string}`;
        raindexArb?: `0x${string}`;
    };
};

/** Rain Solver app yaml configurations */
export type AppOptions = {
    /** Private key of the bot's wallet, only one of this or mnemonic must be set */
    key?: string;
    /** Mnemonic phrase, only one of this or key must be set */
    mnemonic?: string;
    /** Number of excess wallets for submitting txs, required only when mnemonic option is used */
    walletCount?: number;
    /** Topup amount for excess accounts, required only when mnemonic option is used */
    topupAmount?: string;
    /** List of rpc config */
    rpc: RpcConfig[];
    /** List of write rpc configs used explicitly for write transactions */
    writeRpc?: RpcConfig[];
    /** Optional websocket rpc url used explicitly for the block number watcher new heads subscription */
    wsRpc?: string;
    /** List of subgraph urls */
    subgraph: string[];
    /** Option to maximize maxIORatio, default is true */
    maxRatio: boolean;
    /** list of liquidity providers names, default includes all liquidity providers */
    liquidityProviders?: string[];
    /** Seconds to wait between each arb round, default is 10 */
    sleep: number;
    /** Gas coverage percentage for each transaction to be considered profitable to be submitted, default is 100 */
    gasCoveragePercentage: string;
    /** Optional seconds to wait for the transaction to mine before disregarding it, default is 15 */
    timeout: number;
    /** Option to specify time (in minutes) between pools data resets, default is 0 minutes */
    poolUpdateInterval: number;
    /** Minimum bot's wallet gas token balance required for operating, required */
    botMinBalance: string;
    /** Specifies the routing mode 'multi' or 'single' or 'full', default is 'single' */
    route: "single" | "multi" | undefined;
    /** Option to multiply the gas price fetched from the rpc as percentage, default is 107, ie +7% */
    gasPriceMultiplier: number;
    /** Option to multiply the gas limit estimation from the rpc as percentage, default is 100, ie no change */
    gasLimitMultiplier: number;
    /** Option to set a gas limit for all submitting txs optionally with appended percentage sign to apply as percentage to original gas */
    txGas?: string;
    /** Option to set a static gas limit for quote read calls, default is 1 million */
    quoteGas: bigint;
    /** Optional list owned vaults to fund when their balance falls below specified threshold */
    selfFundVaults?: SelfFundVault[];
    /** Option that specifies the owner limit in form of key/value */
    ownerProfile?: Record<string, number>;
    /** The default limit for owners that have no configured owner profile, default is 5 */
    defaultOwnerLimit: number;
    /** Optional filters for inc/exc orders, owner and orderbooks */
    sgFilter?: SgFilter;
    /** List of contract addresses required for solving */
    contracts: AppOptionsContracts;
    /** Specifies enabled trade types for each orderbook address */
    orderbookTradeTypes: OrderbookTradeTypes;
    /** The number of orders that will be processed concurrently, default is 1, i.e. no concurrency */
    maxConcurrency: number;
    /** List of tokens to skip when sweeping bounty tokens */
    skipSweep: Set<string>;
    /** Trade simulation profitablity headroom, default: 2.5 */
    headroom: number;
    /** Time (in days) to sweep multi wallet holdings back into main wallet, default is 0 meaning no sweep */
    sweepWalletTime: number;
    /** Time (in days) to convert main wallet holdings into gas token, default is 0 meaning no conversion */
    convertToGasTime: number;
    /** Determines if multi wallets should be rotated at runtime, meaning new ones to replace older ones once they runs out of gas, default is false */
    rotateMultiWallet: boolean;
    /** Time threshold (in ms) for a transaction mine time before it counts as a trigger to increase gas price multiplier for future transactions, default is 15 seconds */
    txTimeThreshold: number;
    /** The average block time (in ms) of the operating chain, used as the polling interval of the block number watcher and the transaction receipt wait, required */
    blockTime: number;
    /** Subscribes the block number watcher to flashblocks heads instead of new heads over the ws rpc, only supported on Base chain, requires wsRpc, default is false */
    flashblocks: boolean;
    /** Broadcasts each signed transaction through all the configured write rpcs (or all rpcs when no write rpc is set) at the same time, taking the first accepted one, default is false */
    multiBroadcast: boolean;
    /** Adds the backoff sizes of the found trade size, three quarters of it and its halved sizes, to the router mode trade size batch that gets validated against the onchain dryrun concurrently, for every order, default is true */
    routerPartialFallback: boolean;
    /** The number of halved sizes in a router mode trade size batch, the three quarters size comes on top, default is 4 */
    routerPartialFallbackSteps: number;
    /** Sets which orders get a secondary router mode try with the failing route dexes excluded after an onchain rejection, "all" for every order, "max" for orders of max profile owners only, "off" for none, default is "max" */
    routerSecondaryRouteTry: "all" | "max" | "off";
    /** Enables the dryrun gas cache that keeps an average gas limit per order pair for sushi route processor trades and skips the init dryrun once enough samples are in, default is false */
    dryrunGasCache: boolean;
    /** Time (in minutes) between dryrun gas cache resets, default is 60 */
    dryrunGasCacheResetTime: number;
    /** Multiplier of the trade tx gas cost below which a trade size counts as dust and gets skipped, 0 disables the gas cost dust check, default is 1 */
    dustGasCostMultiplier: number;
    /** USD value below which a trade size counts as dust and gets skipped, when both dust checks are set a trade must fail both to count as dust, 0 disables the usd dust check, default is 0 */
    dustUsdThreshold: number;
    /** Runs the dust check on each order's whole max output before any simulation and skips the dust ones for the round, the router mode partial trade size dust check is not affected, default is true */
    dustOrderCheck: boolean;
    /** When true, zero output balance pairs of max profile owners go to round processing, when false, all zero output balance pairs are skipped, default is false */
    strictMaxOwnerProfileCheck: boolean;
    /** When true, orders of max profile owners get the backoff sizes in their router mode trade size batch even with routerPartialFallback disabled, and a dust found trade size backs off from the full size for them instead of bailing out, default is false */
    strictMaxOwnerProfilePartialTradeSizeCheck: boolean;
    /** Time (in minutes) to to check the operating wallet balances, 0 means dont ever check wallet balance, default is 15 mins */
    checkWalletBalanceTime: number;
    /** Optional multiplier applied to the tx gas price when the gas boost usd threshold is exceeded, no boost applies if unset */
    gasBoostMultiplier?: number;
    /** Optional threshold for the estimated profit USD value that if exceeded boosts the tx gas price, kept as 18 point decimals, no boost applies if unset */
    gasBoostUsdThreshold?: bigint;
};

/** Provides methods to instantiate and validate AppOptions */
export namespace AppOptions {
    /**
     * Instantiates and validates configurations details from the given yaml file path
     * @param path - The path to the yaml config file
     */
    export function tryFromYamlPath(path: string): Result<AppOptions, AppOptionsError> {
        try {
            const content = readFileSync(path, { encoding: "utf8" });
            return AppOptions.tryFromYamlString(content);
        } catch (error) {
            return Result.err(
                new AppOptionsError(
                    "Failed to read the given yaml file",
                    AppOptionsErrorType.ReadFileError,
                    error,
                ),
            );
        }
    }

    /**
     * Instantiates and validates configurations details from the given yaml string
     * @param yaml - The yaml config string
     */
    export function tryFromYamlString(yaml: string): Result<AppOptions, AppOptionsError> {
        try {
            const obj = parse(yaml, {
                // parse any number as string for unified validations
                reviver: (_k, v) =>
                    typeof v === "number" || typeof v === "bigint" ? v.toString() : v,
            });
            return AppOptions.tryFrom(obj);
        } catch (error: any) {
            return Result.err(
                new AppOptionsError(
                    "Failed to parse the given yaml string",
                    AppOptionsErrorType.YamlParseError,
                    error,
                ),
            );
        }
    }

    /**
     * Instantiates and validates configurations details from the given input
     * @param input - The configuration object
     */
    export function tryFrom(input: any): Result<AppOptions, AppOptionsError> {
        try {
            const wsRpc = Validator.resolveWsRpc(input.wsRpc);
            const flashblocks = Validator.resolveBool(
                input.flashblocks,
                "expected a boolean value for flashblocks",
                false,
            );
            assert(!flashblocks || wsRpc, "flashblocks requires a wsRpc to subscribe through");
            return Result.ok({
                ...Validator.resolveWalletKey(input),
                contracts: Validator.resolveContracts(input),
                rpc: Validator.resolveRpc(input.rpc),
                writeRpc: Validator.resolveRpc(input.writeRpc, true),
                wsRpc,
                flashblocks,
                multiBroadcast: Validator.resolveBool(
                    input.multiBroadcast,
                    "expected a boolean value for multiBroadcast",
                    false,
                ),
                subgraph: Validator.resolveUrls(
                    input.subgraph,
                    "expected array of subgraph urls with at least 1 url",
                ),
                liquidityProviders: Validator.resolveLiquidityProviders(input.liquidityProviders),
                route: Validator.resolveRouteType(input.route),
                ownerProfile: Validator.resolveOwnerProfile(input.ownerProfile),
                defaultOwnerLimit: Validator.resolveNumericValue(
                    input.defaultOwnerLimit,
                    INT_PATTERN,
                    "invalid defaultOwnerLimit value, must be an integer greater than 0",
                    "5",
                    undefined,
                    (defaultOwnerLimit) =>
                        assert(
                            defaultOwnerLimit > 0,
                            "invalid defaultOwnerLimit value, must be an integer greater than 0",
                        ),
                ),
                routerPartialFallbackSteps: Validator.resolveNumericValue(
                    input.routerPartialFallbackSteps,
                    INT_PATTERN,
                    "invalid routerPartialFallbackSteps value, must be an integer greater than 0",
                    "4",
                    undefined,
                    (routerPartialFallbackSteps) =>
                        assert(
                            routerPartialFallbackSteps > 0,
                            "invalid routerPartialFallbackSteps value, must be an integer greater than 0",
                        ),
                ),
                selfFundVaults: Validator.resolveSelfFundVaults(input.selfFundVaults),
                sgFilter: Validator.resolveSgFilters(input.sgFilter),
                maxRatio: Validator.resolveBool(
                    input.maxRatio,
                    "expected a boolean value for maxRatio",
                    true,
                ),
                sleep: Math.floor(
                    Validator.resolveNumericValue(
                        input.sleep,
                        FLOAT_PATTERN,
                        "invalid sleep value, must be an float greater than equal to 0",
                        "10",
                    ) * 1000,
                ),
                poolUpdateInterval: Validator.resolveNumericValue(
                    input.poolUpdateInterval,
                    INT_PATTERN,
                    "invalid poolUpdateInterval value, must be an integer greater than equal to 0",
                    "0",
                ),
                gasCoveragePercentage: Validator.resolveNumericValue(
                    input.gasCoveragePercentage,
                    INT_PATTERN,
                    "invalid gas coverage percentage, must be an integer greater than equal to 0", //
                    "100",
                    true,
                ),
                txGas: Validator.resolveNumericValue(
                    input.txGas,
                    /^[0-9]+%?$/,
                    "invalid txGas value, must be an integer greater than zero optionally with appended percentage sign to apply as percentage to original gas", //
                    undefined,
                    true,
                ),
                quoteGas: BigInt(
                    Validator.resolveNumericValue(
                        input.quoteGas,
                        INT_PATTERN,
                        "invalid quoteGas value, must be an integer greater than equal to 0",
                        "1000000",
                        true,
                    ),
                ),
                botMinBalance: Validator.resolveNumericValue(
                    input.botMinBalance,
                    FLOAT_PATTERN,
                    "invalid bot min balance, it should be an number greater than equal to 0",
                    undefined,
                    true,
                    (botMinBalance) =>
                        assert(
                            typeof botMinBalance !== "undefined",
                            "invalid bot min balance, it should be an number greater than equal to 0",
                        ),
                ),
                gasPriceMultiplier: Validator.resolveNumericValue(
                    input.gasPriceMultiplier,
                    INT_PATTERN,
                    "invalid gasPriceMultiplier value, must be an integer greater than 0",
                    "107",
                    undefined,
                    (gasPriceMultiplier) =>
                        assert(
                            gasPriceMultiplier > 0,
                            "invalid gasPriceMultiplier value, must be an integer greater than 0",
                        ),
                ),
                gasLimitMultiplier: Validator.resolveNumericValue(
                    input.gasLimitMultiplier,
                    INT_PATTERN,
                    "invalid gasLimitMultiplier value, must be an integer greater than 0",
                    "100",
                    undefined,
                    (gasLimitMultiplier) =>
                        assert(
                            gasLimitMultiplier > 0,
                            "invalid gasLimitMultiplier value, must be an integer greater than 0",
                        ),
                ),
                timeout: Validator.resolveNumericValue(
                    input.timeout,
                    INT_PATTERN,
                    "invalid timeout, must be an integer greater than 0",
                    "15000",
                    undefined,
                    (timeout) =>
                        assert(timeout > 0, "invalid timeout, must be an integer greater than 0"),
                ),
                maxConcurrency: Validator.resolveNumericValue(
                    input.maxConcurrency,
                    INT_PATTERN,
                    "failed to resolve max concurrency value, must be an integer greater than 0",
                    "1",
                    false,
                    (resolvedValue) =>
                        assert(
                            !isNaN(resolvedValue) && resolvedValue > 0,
                            "invalid max concurrency, must be an integer greater than 0",
                        ),
                ),
                orderbookTradeTypes: {
                    router: Validator.resolveAddressSet(
                        input.orderbookTradeTypes?.router,
                        "invalid orderbookTradeTypes.router, expected an array of orderbook addresses",
                    ),
                    interOrderbook: Validator.resolveAddressSet(
                        input.orderbookTradeTypes?.interOrderbook,
                        "invalid orderbookTradeTypes.interOrderbook, expected an array of orderbook addresses",
                    ),
                    intraOrderbook: Validator.resolveAddressSet(
                        input.orderbookTradeTypes?.intraOrderbook,
                        "invalid orderbookTradeTypes.intraOrderbook, expected an array of orderbook addresses",
                    ),
                    raindexRouter: Validator.resolveAddressSet(
                        input.orderbookTradeTypes?.raindexRouter,
                        "invalid orderbookTradeTypes.raindexRouter, expected an array of orderbook addresses",
                    ),
                },
                skipSweep: Validator.resolveAddressSet(
                    input.skipSweep,
                    "invalid skip sweep list, expected an array of token addresses",
                ),
                headroom:
                    Validator.resolveNumericValue(
                        input.headroom,
                        FLOAT_PATTERN,
                        "invalid headroom value, must be a number greater than equal to 0",
                        "2.5",
                    ) + 100,
                sweepWalletTime: Validator.resolveNumericValue(
                    input.sweepWalletTime,
                    INT_PATTERN,
                    "invalid sweepWalletTime, must be an integer greater than equal to 0",
                    "0",
                    undefined,
                    (sweepWalletTime) =>
                        assert(
                            sweepWalletTime >= 0,
                            "invalid sweepWalletTime, must be an integer greater than equal to 0",
                        ),
                ),
                convertToGasTime: Validator.resolveNumericValue(
                    input.convertToGasTime,
                    INT_PATTERN,
                    "invalid convertToGasTime, must be an integer greater than equal to 0",
                    "0",
                    undefined,
                    (convertToGasTime) =>
                        assert(
                            convertToGasTime >= 0,
                            "invalid convertToGasTime, must be an integer greater than equal to 0",
                        ),
                ),
                rotateMultiWallet: Validator.resolveBool(
                    input.rotateMultiWallet,
                    "expected a boolean value for rotateMultiWallet",
                    false,
                ),
                txTimeThreshold: Validator.resolveNumericValue(
                    input.txTimeThreshold,
                    INT_PATTERN,
                    "invalid txTimeThreshold value, must be an integer greater than 0",
                    "15000",
                    undefined,
                    (txTimeThreshold) =>
                        assert(
                            txTimeThreshold > 0,
                            "invalid txTimeThreshold value, must be an integer greater than 0",
                        ),
                ),
                blockTime: Validator.resolveNumericValue(
                    input.blockTime,
                    INT_PATTERN,
                    "invalid blockTime value, must be an integer greater than 0",
                    undefined,
                    undefined,
                    (blockTime) =>
                        assert(
                            typeof blockTime !== "undefined" && blockTime > 0,
                            "blockTime is required, must be an integer greater than 0",
                        ),
                ),
                routerPartialFallback: Validator.resolveBool(
                    input.routerPartialFallback,
                    "expected a boolean value for routerPartialFallback",
                    true,
                ),
                routerSecondaryRouteTry: Validator.resolveRouterSecondaryRouteTry(
                    input.routerSecondaryRouteTry,
                ),
                dryrunGasCache: Validator.resolveBool(
                    input.dryrunGasCache,
                    "expected a boolean value for dryrunGasCache",
                    false,
                ),
                dryrunGasCacheResetTime: Validator.resolveNumericValue(
                    input.dryrunGasCacheResetTime,
                    INT_PATTERN,
                    "invalid dryrunGasCacheResetTime value, must be an integer greater than 0",
                    "60",
                    undefined,
                    (dryrunGasCacheResetTime) =>
                        assert(
                            dryrunGasCacheResetTime > 0,
                            "invalid dryrunGasCacheResetTime value, must be an integer greater than 0",
                        ),
                ),
                dustGasCostMultiplier: Validator.resolveNumericValue(
                    input.dustGasCostMultiplier,
                    FLOAT_PATTERN,
                    "invalid dustGasCostMultiplier value, must be a number greater than or equal to 0",
                    "1",
                    undefined,
                    (dustGasCostMultiplier) =>
                        assert(
                            dustGasCostMultiplier >= 0,
                            "invalid dustGasCostMultiplier value, must be a number greater than or equal to 0",
                        ),
                ),
                dustUsdThreshold: Validator.resolveNumericValue(
                    input.dustUsdThreshold,
                    FLOAT_PATTERN,
                    "invalid dustUsdThreshold value, must be a number greater than or equal to 0",
                    "0",
                    undefined,
                    (dustUsdThreshold) =>
                        assert(
                            dustUsdThreshold >= 0,
                            "invalid dustUsdThreshold value, must be a number greater than or equal to 0",
                        ),
                ),
                dustOrderCheck: Validator.resolveBool(
                    input.dustOrderCheck,
                    "expected a boolean value for dustOrderCheck",
                    true,
                ),
                strictMaxOwnerProfileCheck: Validator.resolveBool(
                    input.strictMaxOwnerProfileCheck,
                    "expected a boolean value for strictMaxOwnerProfileCheck",
                    false,
                ),
                strictMaxOwnerProfilePartialTradeSizeCheck: Validator.resolveBool(
                    input.strictMaxOwnerProfilePartialTradeSizeCheck,
                    "expected a boolean value for strictMaxOwnerProfilePartialTradeSizeCheck",
                    false,
                ),
                checkWalletBalanceTime: Validator.resolveNumericValue(
                    input.checkWalletBalanceTime,
                    INT_PATTERN,
                    "invalid checkWalletBalanceTime, must be an integer greater than equal to  0",
                    "15",
                    undefined,
                    (checkWalletBalanceTime) =>
                        assert(
                            checkWalletBalanceTime >= 0,
                            "invalid checkWalletBalanceTime, must be an integer greater than equal to  0",
                        ),
                ),
                gasBoostMultiplier: Validator.resolveNumericValue(
                    input.gasBoostMultiplier,
                    FLOAT_PATTERN,
                    "invalid gasBoostMultiplier value, must be an number greater than 1",
                    undefined,
                    undefined,
                    (gasBoostMultiplier) =>
                        assert(
                            gasBoostMultiplier === undefined || gasBoostMultiplier > 1,
                            "invalid gasBoostMultiplier value, must be an number greater than 1",
                        ),
                ),
                gasBoostUsdThreshold: (() => {
                    const gasBoostUsdThreshold = Validator.resolveNumericValue(
                        input.gasBoostUsdThreshold,
                        FLOAT_PATTERN,
                        "invalid gasBoostUsdThreshold value, must be a number greater than 0",
                        undefined,
                        true,
                        (value) =>
                            assert(
                                value === undefined || Number(value) > 0,
                                "invalid gasBoostUsdThreshold value, must be a number greater than 0",
                            ),
                    );
                    // convert to 18 point decimals
                    return gasBoostUsdThreshold === undefined
                        ? undefined
                        : parseUnits(gasBoostUsdThreshold, 18);
                })(),
            } as AppOptions);
        } catch (error: any) {
            if (error instanceof AppOptionsError) {
                return Result.err(error);
            } else {
                return Result.err(
                    new AppOptionsError(
                        "Failed to create AppOptions from the given input",
                        AppOptionsErrorType.AppOptionsValidationError,
                        error,
                    ),
                );
            }
        }
    }

    export function isMaxOwnerProfile(
        owner: string,
        ownerProfile?: Record<string, number>,
    ): boolean {
        const o = owner.toLowerCase();
        return !!ownerProfile && !!ownerProfile[o] && ownerProfile[o] === Number.MAX_SAFE_INTEGER;
    }
}
