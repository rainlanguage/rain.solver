import assert from "assert";
import { isAddress } from "viem";
import { AppOptionsContracts, SelfFundVault } from ".";
import { RpcConfig } from "../rpc";
import { isBigNumberish } from "../math";
import { SgFilter } from "../subgraph/filter";
import { AppOptionsError, AppOptionsErrorType } from "./error";

/** Integer pattern */
export const INT_PATTERN = /^[0-9]+$/;

/** Float pattern */
export const FLOAT_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

/** Solidity hash pattern */
export const HASH_PATTERN = /^(0x)?[a-fA-F0-9]{64}$/;

/** Provides methods to parse and validate yaml config fields */
export namespace Validator {
    /** Resolves config's wallet key */
    export function resolveWalletKey(input: any) {
        const key = readValue(input.key).value;
        const mnemonic = readValue(input.mnemonic).value;
        let walletCount = readValue(input.walletCount).value;
        const topupAmount = readValue(input.topupAmount).value;
        if ((!key && !mnemonic) || (key && mnemonic)) {
            throw validationError("only one of key or mnemonic should be specified");
        }
        if (mnemonic) {
            if (!walletCount || !topupAmount) {
                throw validationError(
                    "walletCount and topupAmount are required when using mnemonic key",
                );
            }
            assert(
                INT_PATTERN.test(walletCount),
                validationError(
                    "invalid walletCount, it should be an integer greater than equal to 0",
                ),
            );
            walletCount = Number(walletCount);
            assert(
                FLOAT_PATTERN.test(topupAmount),
                validationError(
                    "invalid topupAmount, it should be a number greater than equal to 0",
                ),
            );
        }
        if (key) {
            assert(HASH_PATTERN.test(key), validationError("invalid wallet private key"));
        }
        return {
            key,
            mnemonic,
            walletCount,
            topupAmount,
        };
    }

    /** Resolves config's urls */
    export function resolveUrls<isOptional extends boolean = false>(
        input: any,
        exception: string,
        isOptional = false as isOptional,
    ): isOptional extends false ? string[] : string[] | undefined {
        const urls = readValue(input);
        if (urls.isEnv) {
            urls.value = tryIntoArray(urls.value);
        }
        if (isOptional && urls.value === undefined) return undefined as any;
        assert(
            urls.value &&
                Array.isArray(urls.value) &&
                urls.value.length > 0 &&
                urls.value.every((v: any) => typeof v === "string"),
            validationError(exception),
        );
        return Array.from(new Set(urls.value)) as any;
    }

    /** Resolves config's list of liquidity providers */
    export function resolveLiquidityProviders(input: any) {
        const lps = readValue(input);
        if (lps.isEnv) {
            lps.value = tryIntoArray(lps.value);
        }
        if (!lps.value) return undefined;
        assert(
            lps.value &&
                Array.isArray(lps.value) &&
                lps.value.length > 0 &&
                lps.value.every((v: any) => typeof v === "string"),
            validationError("expected array of liquidity providers"),
        );
        return lps.value;
    }

    /** Resolves config's boolean value */
    export function resolveBool(input: any, exception: string, fallback = false) {
        const bool = readValue(input);
        if (typeof bool.value === "undefined") {
            bool.value = fallback.toString();
        }
        if (bool.isEnv) {
            assert(
                typeof bool.value === "string" && (bool.value === "true" || bool.value === "false"),
                validationError(exception),
            );
        }
        if (typeof bool.value === "string") {
            bool.value = bool.value === "true";
        }
        assert(typeof bool.value === "boolean", validationError(exception));
        return bool.value;
    }

    /** Resolves config's address */
    export function resolveAddress<isOptional extends boolean = false>(
        input: any,
        addressName: string,
        isOptional = false as isOptional,
    ): isOptional extends false ? string : string | undefined {
        const address = readValue(input).value;
        if (isOptional && address === undefined) return undefined as any;
        assert(
            typeof address === "string" && isAddress(address, { strict: false }),
            validationError(`expected valid ${addressName} contract address`),
        );
        return address.toLowerCase() as any;
    }

    /** Resolves the given input to an address set */
    export function resolveAddressSet(input: any, exception: string): Set<`0x${string}`> {
        const urls = readValue(input);
        if (urls.isEnv) {
            urls.value = tryIntoArray(urls.value);
        }
        if (urls.value === undefined) return new Set();
        assert(
            urls.value &&
                Array.isArray(urls.value) &&
                urls.value.length > 0 &&
                urls.value.every(
                    (v: any) => typeof v === "string" && isAddress(v, { strict: false }),
                ),
            validationError(exception),
        );
        return new Set(urls.value.map((v) => v.toLowerCase() as `0x${string}`));
    }

    /** Resolves config's numeric value */
    export function resolveNumericValue<
        fallback extends string | undefined = undefined,
        returnAsString extends boolean | undefined = false,
    >(
        input: any,
        pattern: RegExp,
        exception: string,
        fallback?: fallback,
        returnAsString = false as returnAsString,
        callback?: (value: any) => void,
    ): fallback extends string
        ? returnAsString extends true
            ? string
            : number
        : (returnAsString extends true ? string : number) | undefined {
        const value = readValue(input).value || fallback;
        if (typeof value === "undefined") {
            callback?.(value);
            return undefined as any;
        } else {
            assert(typeof value === "string", validationError(exception));
            assert(pattern.test(value), validationError(exception));
            if (returnAsString) {
                callback?.(value);
                return value as any;
            } else {
                const _value = Number(value);
                callback?.(_value);
                return _value as any;
            }
        }
    }

    /** Resolves config's route type */
    export function resolveRouteType(input: any) {
        const route = (readValue(input).value || "single")?.toLowerCase();
        assert(
            typeof route === "string" &&
                (route === "full" || route === "single" || route === "multi"),
            validationError("expected either of full, single or multi"),
        );
        if (route === "full") return undefined;
        else return route;
    }

    /** Resolves config's rpcs */
    export function resolveRpc<isOptional extends boolean = false>(
        input: any,
        isOptional = false as isOptional,
    ): isOptional extends false ? RpcConfig[] : RpcConfig[] | undefined {
        const rpcs = readValue(input);
        const validate = (rpcConfig: any, key: string, value: any) => {
            assert(
                key === "url" || key === "weight" || key === "trackSize",
                validationError(`unknown key: ${key}`),
            );
            if (key === "url") {
                assert(!("url" in rpcConfig), validationError("duplicate url"));
                rpcConfig.url = value;
            }
            if (key === "weight") {
                assert(
                    !("selectionWeight" in rpcConfig),
                    validationError("duplicate weight option"),
                );
                const parsedValue = parseFloat(value);
                assert(
                    !isNaN(parsedValue) && parsedValue >= 0,
                    validationError(
                        `invalid rpc weight: "${value}", expected a number greater than equal to 0`,
                    ),
                );
                rpcConfig.selectionWeight = parsedValue;
            }
            if (key === "trackSize") {
                assert(!("trackSize" in rpcConfig), validationError("duplicate trackSize option"));
                const parsedValue = parseInt(value);
                assert(
                    !isNaN(parsedValue) && parsedValue >= 0,
                    validationError(
                        `invalid rpc track size: "${value}", expected an integer greater than equal to 0`,
                    ),
                );
                rpcConfig.trackSize = parsedValue;
            }
        };

        const result: RpcConfig[] = [];
        if (rpcs.isEnv) {
            if (isOptional && typeof rpcs.value === "undefined") return undefined as any;
            rpcs.value = tryIntoArray(rpcs.value);
            for (let i = 0; i < rpcs.value.length; i++) {
                // eslint-disable-next-line prefer-const
                let [key, value, ...rest] = rpcs.value[i].split("=");
                assert(value, validationError(`expected value after ${key}=`));
                if (key === "url" && rest.length) {
                    value = value.concat("=", rest.join("="));
                } else {
                    assert(rest.length === 0, validationError(`unexpected arguments: ${rest}`));
                }

                // insert the first one as empty to be filled
                if (!result.length || (key === "url" && "url" in result[result.length - 1])) {
                    result.push({} as any);
                }
                validate(result[result.length - 1], key, value);
            }
            assert(result?.[0]?.url, validationError("expected at least one rpc url"));
        } else if (input) {
            assert(Array.isArray(input), validationError("expected array of RpcConfig"));
            input.forEach((rpcConfig: any) => {
                const res = {} as any;
                for (const key in rpcConfig) {
                    validate(res, key, rpcConfig[key]);
                }
                result.push(res);
            });
        }
        if (isOptional) {
            if (!result.length) return undefined as any;
        } else {
            assert(
                result.length && result.some((v) => v.url),
                validationError("expected at least one rpc url"),
            );
        }
        return result as any;
    }

    /** Resolves config's owner profiles */
    export function resolveOwnerProfile(input: any) {
        const ownerProfile = readValue(input);
        const profiles: Record<string, number> = {};
        const validate = (owner: string, limit: string) => {
            assert(
                isAddress(owner, { strict: false }),
                validationError(`Invalid owner address: ${owner}`),
            );
            assert(
                (INT_PATTERN.test(limit) && Number(limit) > 0) || limit === "max",
                validationError(
                    "Invalid owner profile limit, must be an integer gte 0 or 'max' for no limit",
                ),
            );
            if (limit === "max") {
                profiles[owner.toLowerCase()] = Number.MAX_SAFE_INTEGER;
            } else {
                profiles[owner.toLowerCase()] = Math.min(Number(limit), Number.MAX_SAFE_INTEGER);
            }
        };
        if (ownerProfile.isEnv) {
            if (typeof ownerProfile.value === "undefined") return;
            ownerProfile.value = tryIntoArray(ownerProfile.value);
            assert(
                Array.isArray(ownerProfile.value) &&
                    ownerProfile.value.every((v: any) => typeof v === "string"),
                validationError(
                    "expected array of owner limits in k/v format, example: OWNER=LIMIT",
                ),
            );
            ownerProfile.value.forEach((kv: string) => {
                const [owner = undefined, limit = undefined, ...rest] = kv.split("=");
                assert(
                    typeof owner === "string" && typeof limit === "string" && rest.length === 0,
                    validationError(
                        "Invalid owner profile, must be in form of 'ownerAddress=limitValue'",
                    ),
                );
                validate(owner, limit);
            });
        } else if (input) {
            assert(
                Array.isArray(input),
                validationError(
                    "expected array of owner limits in k/v format, example: - OWNER: LIMIT",
                ),
            );
            input.forEach((ownerProfile) => {
                const kv = Object.entries(ownerProfile);
                assert(
                    kv.length === 1,
                    validationError("Invalid owner profile, must be in form of 'OWNER: LIMIT'"),
                );
                kv.forEach(([owner, limit]: [string, any]) => {
                    validate(owner, limit);
                });
            });
        }
        return Object.keys(profiles).length ? profiles : undefined;
    }

    /** Resolves config's bot self funding vaults */
    export function resolveSelfFundVaults(input: any) {
        const selfFundVaults = readValue(input);
        const validate = (details: any) => {
            const {
                token = undefined,
                vaultId = undefined,
                orderbook = undefined,
                threshold = undefined,
                topupAmount = undefined,
            } = details;
            assert(
                token && isAddress(token, { strict: false }),
                validationError("invalid token address"),
            );
            assert(
                orderbook && isAddress(orderbook, { strict: false }),
                validationError("invalid orderbook address"),
            );
            assert(vaultId && isBigNumberish(vaultId), validationError("invalid vault id"));
            assert(
                threshold && FLOAT_PATTERN.test(threshold),
                validationError("expected a number greater than equal to 0 for threshold"),
            );
            assert(
                topupAmount && FLOAT_PATTERN.test(topupAmount),
                validationError("expected a number greater than equal to 0 for topupAmount"),
            );
            return true;
        };
        if (selfFundVaults.isEnv) {
            if (typeof selfFundVaults.value === "undefined") return;
            selfFundVaults.value = tryIntoArray(selfFundVaults.value);
            assert(
                Array.isArray(selfFundVaults.value) &&
                    selfFundVaults.value.every((v: any) => typeof v === "string"),
                validationError(
                    "expected array of vault funding details in key=value, example: token=0xabc...123,orderbook=0x123...,vaultId=0x123...456,threshold=0.5,topupAmount=10",
                ),
            );

            // build  array of SelfFundVault from the inputs
            const result: Record<string, any>[] = [];
            for (const item of selfFundVaults.value) {
                // should contain known keys
                assert(
                    item.startsWith("token=") ||
                        item.startsWith("vaultId=") ||
                        item.startsWith("threshold=") ||
                        item.startsWith("orderbook=") ||
                        item.startsWith("topupAmount="),
                    validationError(`unknown key/value: ${item}`),
                );

                // insert empty next
                if (!result.length || Object.keys(result[result.length - 1]).length === 5) {
                    result.push({});
                }

                const [key, value, ...rest]: string[] = item.split("=");
                assert(value, validationError(`expected value after ${key}=`));
                assert(rest.length === 0, validationError(`unexpected arguments: ${rest}`));
                assert(!(key in result[result.length - 1]), validationError(`duplicate ${key}`));

                result[result.length - 1][key as keyof SelfFundVault] = value;
            }

            // validate built array values and return
            result.every(validate);
            return result as SelfFundVault[];
        } else if (input) {
            assert(
                Array.isArray(input) && input.every(validate),
                validationError("expected array of SelfFundVault"),
            );
            return input as SelfFundVault[];
        }
    }

    /** Resolves config's order filters */
    export function resolveSgFilters(input: any) {
        const sgFilter: any = {
            includeOrders: readValue(input?.includeOrders),
            excludeOrders: readValue(input?.excludeOrders),
            includeOwners: readValue(input?.includeOwners),
            excludeOwners: readValue(input?.excludeOwners),
            includeOrderbooks: readValue(input?.includeOrderbooks),
            excludeOrderbooks: readValue(input?.excludeOrderbooks),
        };
        const validate = (
            field: string,
            exceptionMsg: string,
            validator: (value?: unknown) => string,
        ) => {
            if (sgFilter[field].isEnv) {
                const list = tryIntoArray(sgFilter[field].value);
                if (list) {
                    sgFilter[field] = new Set(list.map(validator));
                } else {
                    sgFilter[field] = undefined;
                }
            } else if (sgFilter[field].value) {
                assert(Array.isArray(sgFilter[field].value), validationError(exceptionMsg));
                sgFilter[field] = new Set(sgFilter[field].value.map(validator));
            } else {
                sgFilter[field] = undefined;
            }
        };

        // validate inc/exc orders
        validate("includeOrders", "expected an array of orderhashes", validateHash);
        validate("excludeOrders", "expected an array of orderhashes", validateHash);

        // validate inc/exc owners
        validate("includeOwners", "expected an array of owner addresses", validateAddress);
        validate("excludeOwners", "expected an array of owner addresses", validateAddress);

        // validate inc/exc orderbooks
        validate("includeOrderbooks", "expected an array of orderbook addresses", validateAddress);
        validate("excludeOrderbooks", "expected an array of orderbook addresses", validateAddress);

        // include if any of the fields are set
        if (Object.values(sgFilter).some((v) => typeof v !== "undefined")) {
            return sgFilter as SgFilter;
        } else {
            return undefined;
        }
    }

    export function resolveContracts(input: any): AppOptionsContracts {
        const dispairV4 = resolveAddress(input?.contracts?.v4?.dispair, "dispair v4", true);
        const sushiArbAddressV4 = resolveAddress(
            input?.contracts?.v4?.sushiArbAddress,
            "sushiArbAddress v4",
            true,
        );
        const genericArbAddressV4 = resolveAddress(
            input?.contracts?.v4?.genericArbAddress,
            "genericArbAddress v4",
            true,
        );
        const balancerArbAddressV4 = resolveAddress(
            input?.contracts?.v4?.balancerArbAddress,
            "balancerArbAddress v4",
            true,
        );
        const stabullArbAddressV4 = resolveAddress(
            input?.contracts?.v4?.stabullArbAddress,
            "stabullArbAddress v4",
            true,
        );
        const dispairV5 = resolveAddress(input?.contracts?.v5?.dispair, "dispair v5", true);
        const sushiArbAddressV5 = resolveAddress(
            input?.contracts?.v5?.sushiArbAddress,
            "sushiArbAddress v5",
            true,
        );
        const genericArbAddressV5 = resolveAddress(
            input?.contracts?.v5?.genericArbAddress,
            "genericArbAddress v5",
            true,
        );
        const balancerArbAddressV5 = resolveAddress(
            input?.contracts?.v5?.balancerArbAddress,
            "balancerArbAddress v5",
            true,
        );
        const stabullArbAddressV5 = resolveAddress(
            input?.contracts?.v5?.stabullArbAddress,
            "stabullArbAddress v5",
            true,
        );
        const dispairV6 = resolveAddress(input?.contracts?.v6?.dispair, "dispair v6", true);
        const sushiArbAddressV6 = resolveAddress(
            input?.contracts?.v6?.sushiArbAddress,
            "sushiArbAddress v6",
            true,
        );
        const genericArbAddressV6 = resolveAddress(
            input?.contracts?.v6?.genericArbAddress,
            "genericArbAddress v6",
            true,
        );
        const balancerArbAddressV6 = resolveAddress(
            input?.contracts?.v6?.balancerArbAddress,
            "balancerArbAddress v6",
            true,
        );
        const stabullArbAddressV6 = resolveAddress(
            input?.contracts?.v6?.stabullArbAddress,
            "stabullArbAddress v6",
            true,
        );
        const raindexArbAddressV6 = resolveAddress(
            input?.contracts?.v6?.raindexArbAddress,
            "raindexArbAddress v6",
            true,
        );
        const contracts: AppOptionsContracts = {};
        if (
            dispairV4 ||
            sushiArbAddressV4 ||
            genericArbAddressV4 ||
            balancerArbAddressV4 ||
            stabullArbAddressV4
        ) {
            contracts.v4 = {
                sushiArb: sushiArbAddressV4 as `0x${string}` | undefined,
                dispair: dispairV4 as `0x${string}` | undefined,
                genericArb: genericArbAddressV4 as `0x${string}` | undefined,
                balancerArb: balancerArbAddressV4 as `0x${string}` | undefined,
                stabullArb: stabullArbAddressV4 as `0x${string}` | undefined,
            };
        }
        if (
            dispairV5 ||
            sushiArbAddressV5 ||
            genericArbAddressV5 ||
            balancerArbAddressV5 ||
            stabullArbAddressV5
        ) {
            contracts.v5 = {
                sushiArb: sushiArbAddressV5 as `0x${string}` | undefined,
                dispair: dispairV5 as `0x${string}` | undefined,
                genericArb: genericArbAddressV5 as `0x${string}` | undefined,
                balancerArb: balancerArbAddressV5 as `0x${string}` | undefined,
                stabullArb: stabullArbAddressV5 as `0x${string}` | undefined,
            };
        }
        if (
            dispairV6 ||
            sushiArbAddressV6 ||
            genericArbAddressV6 ||
            balancerArbAddressV6 ||
            stabullArbAddressV6 ||
            raindexArbAddressV6
        ) {
            contracts.v6 = {
                sushiArb: sushiArbAddressV6 as `0x${string}` | undefined,
                dispair: dispairV6 as `0x${string}` | undefined,
                genericArb: genericArbAddressV6 as `0x${string}` | undefined,
                balancerArb: balancerArbAddressV6 as `0x${string}` | undefined,
                stabullArb: stabullArbAddressV6 as `0x${string}` | undefined,
                raindexArb: raindexArbAddressV6 as `0x${string}` | undefined,
            };
        }
        return contracts;
    }
}

/**
 * Reads the env value if the given input points to
 * an envvariable, else returns the value unchanged
 */
export function readValue(value: any) {
    const result = { isEnv: false, value };
    if (typeof value === "string" && value.startsWith("$")) {
        result.isEnv = true;
        const env = process.env[value.slice(1)];
        if (
            env !== undefined &&
            env !== null &&
            typeof env === "string" &&
            env !== "" &&
            !/^\s*$/.test(env)
        ) {
            result.value = env;
        } else {
            result.value = undefined;
        }
        return result;
    }
    return { isEnv: false, value };
}

/**
 * Tries to parse the given string into an array of strings where items are separated by a comma
 */
export function tryIntoArray(value?: string): string[] | undefined {
    return value ? Array.from(value.matchAll(/[^,\s]+/g)).map((v) => v[0]) : undefined;
}

/**
 * Validates if the given input is an address
 */
export function validateAddress(value?: unknown): string {
    if (typeof value !== "string") throw validationError("expected string");
    if (!isAddress(value, { strict: false })) {
        throw validationError(`${value} is not a valid address`);
    }
    return value.toLowerCase();
}

/**
 * Validates if the given input is a solidity hash (32 bytes length hex string)
 */
export function validateHash(value?: unknown): string {
    if (typeof value !== "string") throw validationError("expected string");
    if (!HASH_PATTERN.test(value)) {
        throw validationError(`${value} is not a valid hash`);
    }
    return value.toLowerCase();
}

function validationError(msg: string): AppOptionsError {
    return new AppOptionsError(msg, AppOptionsErrorType.AppOptionsValidationError);
}
