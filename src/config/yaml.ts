import assert from "assert";
import { parse } from "yaml";
import { readFileSync } from "fs";
import { RpcConfig } from "../rpc";
import { Result } from "../common";
import { SgFilter } from "../subgraph/filter";
import { RainSolverError, RainSolverErrorType } from "../error";
import { FLOAT_PATTERN, INT_PATTERN, Validator } from "./validators";

/** Represents a type for self-funding vaults from config */
export type SelfFundVault = {
    token: string;
    vaultId: string;
    orderbook: string;
    threshold: string;
    topupAmount: string;
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
    /** Arb contract address */
    arbAddress: string;
    /** Dispair contract address */
    dispair: string;
    /** Generic arb contract address */
    genericArbAddress?: string;
    /** List of subgraph urls */
    subgraph: string[];
    /** Option to maximize maxIORatio, default is true */
    maxRatio: boolean;
    /** Only clear orders through RP4, excludes intra and inter orderbook clears, default is true */
    rpOnly: boolean;
    /** list of liquidity providers names, default includes all liquidity providers */
    liquidityProviders?: string[];
    /** Seconds to wait between each arb round, default is 10 */
    sleep: number;
    /** Gas coverage percentage for each transaction to be considered profitable to be submitted, default is 100 */
    gasCoveragePercentage: string;
    /** Optional seconds to wait for the transaction to mine before disregarding it, default is 15 */
    timeout: number;
    /** Number of hops of binary search, if left unspecified will be 1 by default */
    hops: number;
    /** The amount of retries for the same order, maximum allowed 3, minimum allowed 1, default is 1 */
    retries: number;
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
};

/** Provides methods to instantiate and validate AppOptions */
export namespace AppOptions {
    /**
     * Instantiates and validates configurations details from the given yaml file path
     * @param path - The path to the yaml config file
     */
    export function tryFromYamlPath(path: string): Result<AppOptions, RainSolverError> {
        try {
            const content = readFileSync(path, { encoding: "utf8" });
            return AppOptions.tryFromYamlString(content);
        } catch (error) {
            return Result.err(
                new RainSolverError(
                    "Failed to read the given yaml file",
                    RainSolverErrorType.ReadFileError,
                    error,
                ),
            );
        }
    }

    /**
     * Instantiates and validates configurations details from the given yaml string
     * @param yaml - The yaml config string
     */
    export function tryFromYamlString(yaml: string): Result<AppOptions, RainSolverError> {
        try {
            const obj = parse(yaml, {
                // parse any number as string for unified validations
                reviver: (_k, v) =>
                    typeof v === "number" || typeof v === "bigint" ? v.toString() : v,
            });
            return AppOptions.tryFrom(obj);
        } catch (error: any) {
            return Result.err(
                new RainSolverError(
                    "Failed to parse the given yaml string",
                    RainSolverErrorType.YamlParseError,
                    error,
                ),
            );
        }
    }

    /**
     * Instantiates and validates configurations details from the given input
     * @param input - The configuration object
     */
    export function tryFrom(input: any): Result<AppOptions, RainSolverError> {
        try {
            return Result.ok({
                ...Validator.resolveWalletKey(input),
                rpc: Validator.resolveRpc(input.rpc),
                writeRpc: Validator.resolveRpc(input.writeRpc, true),
                subgraph: Validator.resolveUrls(
                    input.subgraph,
                    "expected array of subgraph urls with at least 1 url",
                ),
                dispair: Validator.resolveAddress(input.dispair, "dispair"),
                arbAddress: Validator.resolveAddress(input.arbAddress, "arbAddress"),
                genericArbAddress: Validator.resolveAddress(
                    input.genericArbAddress,
                    "genericArbAddress",
                    true,
                ),
                liquidityProviders: Validator.resolveLiquidityProviders(input.liquidityProviders),
                route: Validator.resolveRouteType(input.route),
                ownerProfile: Validator.resolveOwnerProfile(input.ownerProfile),
                selfFundVaults: Validator.resolveSelfFundVaults(input.selfFundVaults),
                sgFilter: Validator.resolveSgFilters(input.sgFilter),
                rpOnly: Validator.resolveBool(
                    input.rpOnly,
                    "expected a boolean value for rpOnly",
                    true,
                ),
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
                hops: Validator.resolveNumericValue(
                    input.hops,
                    INT_PATTERN,
                    "invalid hops value, must be an integer greater than 0",
                    "1",
                    undefined,
                    (hops) =>
                        assert(hops > 0, "invalid hops value, must be an integer greater than 0"),
                ),
                retries: Validator.resolveNumericValue(
                    input.retries,
                    INT_PATTERN,
                    "invalid retries value, must be an integer between 1 - 3",
                    "1",
                    undefined,
                    (retries) =>
                        assert(
                            retries >= 1 && retries <= 3,
                            "invalid retries value, must be an integer between 1 - 3",
                        ),
                ),
            } as AppOptions);
        } catch (error: any) {
            if (error instanceof RainSolverError) {
                return Result.err(error);
            } else {
                return Result.err(
                    new RainSolverError(
                        "Failed to create AppOptions from the given input",
                        RainSolverErrorType.AppOptionsValidationError,
                        error,
                    ),
                );
            }
        }
    }
}
