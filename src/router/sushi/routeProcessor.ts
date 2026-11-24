import { Type } from "sushi/currency";
import { MultiRoute, RouteLeg } from "sushi/tines";
import type { RouteProcessorVersion } from "../../config";
import type { ChainConfig } from "../../state/chain";
import { PoolCode, Router, RPParams } from "sushi";

/** The state fields that the route processor of the bot is read from, see getRouteProcessor */
export type RouteProcessorSource = {
    appOptions?: { routeProcessor?: RouteProcessorVersion };
    chainConfig: Pick<ChainConfig, "routeProcessors">;
};

/**
 * Gets the sushi route processor the bot routes through: its version, see
 * AppOptions.routeProcessor, 4 when unset, and its address on the chain, see
 * ChainConfig.routeProcessors, the address is undefined when the chain has none
 * @param state - The state that the version and the address are read from
 */
export function getRouteProcessor(state: RouteProcessorSource): {
    version: RouteProcessorVersion;
    address: `0x${string}`;
} {
    const version = state.appOptions?.routeProcessor ?? 4;
    return { version, address: state.chainConfig.routeProcessors[String(version)] };
}

/**
 * Builds the processRoute call of a route through the route processor of the
 * bot, see getRouteProcessor. RouteProcessor6 also takes the Uniswap V4 style
 * pools, its processRoute has the signature of the RouteProcessor4 one
 * @param state - The state that the route processor is read from
 * @param pcMap - The pool codes of the route, by their unique id
 * @param route - The route
 * @param fromToken - The token that the route sells
 * @param toToken - The token that the route buys
 * @param to - The receiver of the output of the route
 */
export function getRouteProcessorParams(
    state: RouteProcessorSource,
    pcMap: Map<string, PoolCode>,
    route: MultiRoute,
    fromToken: Type,
    toToken: Type,
    to: `0x${string}`,
): RPParams {
    const { version, address } = getRouteProcessor(state);
    return version === 6
        ? Router.routeProcessor6Params(pcMap, route, fromToken, toToken, to, address)
        : Router.routeProcessor4Params(pcMap, route, fromToken, toToken, to, address);
}

/**
 * Gets the pool of a route leg, the 32 bytes pool id of a Uniswap V4 style pool, as
 * all of its pools have the PoolManager address, see UniV4Pool.uniqueID, else the
 * pool address
 * @param leg - The route leg
 */
export function getLegPool(leg: RouteLeg): string {
    const id = leg.uniqueId?.slice(0, -leg.poolAddress.length);
    return id && /^0x[0-9a-f]{64}$/i.test(id) && leg.uniqueId.endsWith(leg.poolAddress)
        ? id
        : leg.poolAddress;
}
