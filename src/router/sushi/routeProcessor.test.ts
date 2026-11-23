import { Router } from "sushi";
import { RouteLeg } from "sushi/tines";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLegPool, getRouteProcessor, getRouteProcessorParams } from "./routeProcessor";

const rp4 = "0x4444444444444444444444444444444444444444";
const rp6 = "0x6666666666666666666666666666666666666666";
const routeProcessors = { "4": rp4, "6": rp6 } as Record<string, `0x${string}`>;

describe("Test getRouteProcessor", () => {
    it("should take the configured version and its address, 4 when unset", () => {
        expect(getRouteProcessor({ chainConfig: { routeProcessors } })).toEqual({
            version: 4,
            address: rp4,
        });
        expect(getRouteProcessor({ appOptions: {}, chainConfig: { routeProcessors } })).toEqual({
            version: 4,
            address: rp4,
        });
        expect(
            getRouteProcessor({
                appOptions: { routeProcessor: 6 },
                chainConfig: { routeProcessors },
            }),
        ).toEqual({ version: 6, address: rp6 });
    });

    it("should give no address for a chain with no route processor of the version", () => {
        const onlyRp4 = { routeProcessors: { "4": rp4 } as Record<string, `0x${string}`> };
        const result = getRouteProcessor({
            appOptions: { routeProcessor: 6 },
            chainConfig: onlyRp4,
        });
        expect(result.version).toBe(6);
        expect(result.address).toBeUndefined();
    });
});

describe("Test getRouteProcessorParams", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should build the route for the route processor of the bot, at its address", () => {
        const params4 = vi.spyOn(Router, "routeProcessor4Params").mockReturnValue({ v: 4 } as any);
        const params6 = vi.spyOn(Router, "routeProcessor6Params").mockReturnValue({ v: 6 } as any);
        const pcMap = new Map();
        const route = {} as any;
        const fromToken = {} as any;
        const toToken = {} as any;
        const to = "0x1234567890123456789012345678901234567890";

        // RouteProcessor4, the default
        const state4 = { chainConfig: { routeProcessors } };
        expect(getRouteProcessorParams(state4, pcMap, route, fromToken, toToken, to)).toEqual({
            v: 4,
        });
        expect(params4).toHaveBeenCalledWith(pcMap, route, fromToken, toToken, to, rp4);
        expect(params6).not.toHaveBeenCalled();

        // RouteProcessor6
        const state6 = {
            appOptions: { routeProcessor: 6 as const },
            chainConfig: { routeProcessors },
        };
        expect(getRouteProcessorParams(state6, pcMap, route, fromToken, toToken, to)).toEqual({
            v: 6,
        });
        expect(params6).toHaveBeenCalledWith(pcMap, route, fromToken, toToken, to, rp6);
        expect(params4).toHaveBeenCalledTimes(1);
    });
});

describe("Test getLegPool", () => {
    it("should get the pool id of a Uniswap V4 style leg, else the pool address", () => {
        const manager = "0x" + "a".repeat(40);
        const id = "0x" + "1".repeat(64);
        const leg = (poolAddress: string, uniqueId: string) =>
            ({ poolAddress, uniqueId }) as any as RouteLeg;
        expect(getLegPool(leg(manager, id + manager))).toBe(id);
        expect(getLegPool(leg(manager, manager))).toBe(manager);
        // the other unique id formats, a bento bridge and a curve multitoken pool
        expect(getLegPool(leg(manager, `${manager}_USDC_bento_bridge`))).toBe(manager);
        expect(getLegPool(leg(manager, `${manager}_0_1`))).toBe(manager);
    });
});
