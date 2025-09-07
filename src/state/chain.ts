import { Chain } from "viem";
import { Result } from "../common";
import { ChainId } from "sushi/chain";
import { Token, WNATIVE } from "sushi/currency";
import { RainSolverBaseError } from "../error/types";
import {
    STABLES,
    publicClientConfig,
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_3_1_ADDRESS,
    ROUTE_PROCESSOR_3_2_ADDRESS,
} from "sushi/config";

/** Enumerates the possible error types that can occur within the chain config */
export enum ChainConfigErrorType {
    UnsupportedChain,
    MissingNativeWrappedTokenInfo,
    MissingSushiRouteProcessor4Address,
}

/**
 * Represents an error type for the ChainConfig.
 * This error class extends the `RainSolverError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `ChainConfigErrorType` enum.
 *
 * @example
 * ```typescript
 * throw new ChainConfigError("msg", ChainConfigErrorType);
 * ```
 */
export class ChainConfigError extends RainSolverBaseError {
    type: ChainConfigErrorType;
    constructor(message: string, type: ChainConfigErrorType) {
        super(message);
        this.type = type;
        this.name = "ChainConfigError";
    }
}

export type ChainConfig = Chain & {
    nativeWrappedToken: Token;
    routeProcessors: { [key: string]: `0x${string}` };
    stableTokens?: Token[];
    isSpecialL2: boolean;
};

/**
 * Get the chain config for a given chain id
 * @param chainId - The chain id
 */
export function getChainConfig(chainId: ChainId): Result<ChainConfig, ChainConfigError> {
    // get chain config
    const chain = publicClientConfig[chainId]?.chain;
    if (!chain)
        return Result.err(
            new ChainConfigError(
                `network with id ${chainId} is not supported`,
                ChainConfigErrorType.UnsupportedChain,
            ),
        );

    // get native wrapped token details
    const nativeWrappedToken = WNATIVE[chainId];
    if (!nativeWrappedToken)
        return Result.err(
            new ChainConfigError(
                `wrapped native token info missing for chain ${chainId}`,
                ChainConfigErrorType.MissingNativeWrappedTokenInfo,
            ),
        );

    // get route processor addresses
    const routeProcessors: Record<string, `0x${string}`> = {};
    [
        ["3", ROUTE_PROCESSOR_3_ADDRESS],
        ["3.1", ROUTE_PROCESSOR_3_1_ADDRESS],
        ["3.2", ROUTE_PROCESSOR_3_2_ADDRESS],
        ["4", ROUTE_PROCESSOR_4_ADDRESS],
    ].forEach(([key, addresses]: any[]) => {
        const address = addresses[chainId];
        if (address) {
            routeProcessors[key] = address;
        }
    });
    if (!routeProcessors["4"])
        return Result.err(
            new ChainConfigError(
                `missing route processor 4 address for chain ${chainId}`,
                ChainConfigErrorType.MissingSushiRouteProcessor4Address,
            ),
        );

    // get known stable coins of the chain
    const stableTokens = (STABLES as any)[chainId];

    return Result.ok({
        ...chain,
        nativeWrappedToken,
        routeProcessors,
        stableTokens,
        isSpecialL2: SpecialL2Chains.is(chain.id),
    });
}

/**
 * List of L2 chains that require SEPARATE L1 gas actions.
 * other L2 chains that dont require separate L1 gas actions
 * such as Arbitrum and Polygon zkEvm are excluded, these chains'
 * gas actions are performed the same as usual L1 chains.
 */
export enum SpecialL2Chains {
    BASE = ChainId.BASE,
    OPTIMISM = ChainId.OPTIMISM,
}
export namespace SpecialL2Chains {
    export function is(chainId: number): boolean {
        return Object.values(SpecialL2Chains).includes(chainId as any);
    }
}
