import assert from "assert";
import { parse } from "yaml";
import { readFileSync } from "fs";
import { RpcConfig } from "../rpc";
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
    /** Optional filters for inc/exc orders, owner and orderbooks */
    sgFilter?: SgFilter;
    /** List of contract addresses required for solving */
    contracts: AppOptionsContracts;
    /** Specifies enabled trade types for each orderbook address */
    orderbookTradeTypes: OrderbookTradeTypes;
    /** List of tokens to skip when sweeping bounty tokens */
    skipSweep: Set<string>;
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
            return Result.ok({
                ...Validator.resolveWalletKey(input),
                contracts: Validator.resolveContracts(input),
                rpc: Validator.resolveRpc(input.rpc),
                writeRpc: Validator.resolveRpc(input.writeRpc, true),
                subgraph: Validator.resolveUrls(
                    input.subgraph,
                    "expected array of subgraph urls with at least 1 url",
                ),
                liquidityProviders: Validator.resolveLiquidityProviders(input.liquidityProviders),
                route: Validator.resolveRouteType(input.route),
                ownerProfile: Validator.resolveOwnerProfile(input.ownerProfile),
                selfFundVaults: Validator.resolveSelfFundVaults(input.selfFundVaults),
                sgFilter: Validator.resolveSgFilters(input.sgFilter),
                maxRatio: Validator.resolveBool(
                    input.maxRatio,
                    "expected a boolean value for maxRatio",
                    true,
                ),
                sleep:
                    Validator.resolveNumericValue(
                        input.sleep,
                        INT_PATTERN,
                        "invalid sleep value, must be an integer greater than equal to 0",
                        "10",
                    ) * 1000,
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
                },
                skipSweep: Validator.resolveAddressSet(
                    input.skipSweep,
                    "invalid skip sweep list, expected an array of token addresses",
                ),
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
}
