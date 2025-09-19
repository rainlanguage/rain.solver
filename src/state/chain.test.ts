import { ChainId } from "sushi/chain";
import { WNATIVE } from "sushi/currency";
import { describe, it, expect, vi, assert } from "vitest";
import { ChainConfigErrorType, getChainConfig, SpecialL2Chains } from "./chain";
import {
    STABLES,
    publicClientConfig,
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_3_1_ADDRESS,
    ROUTE_PROCESSOR_3_2_ADDRESS,
} from "sushi/config";

vi.mock("sushi/config", async (importOriginal) => ({
    ...(await importOriginal()),
    ROUTE_PROCESSOR_3_ADDRESS: {
        [ChainId.ETHEREUM]: `0xrp3`,
        [ChainId.FLARE]: `0xrp3`,
        [ChainId.POLYGON]: `0xrp3`,
    },
    ROUTE_PROCESSOR_4_ADDRESS: {
        [ChainId.ETHEREUM]: `0xrp4`,
        [ChainId.FLARE]: `0xrp4`,
    },
    ROUTE_PROCESSOR_3_1_ADDRESS: {
        [ChainId.ETHEREUM]: `0xrp3.1`,
        [ChainId.POLYGON]: `0xrp3.1`,
    },
    ROUTE_PROCESSOR_3_2_ADDRESS: {
        [ChainId.ETHEREUM]: `0xrp3.2`,
        [ChainId.FLARE]: `0xrp3.2`,
        [ChainId.POLYGON]: `0xrp3.2`,
    },
}));

describe("Test getChainConfig", () => {
    it("should return correct config for a supported chain", () => {
        const chainId = ChainId.ETHEREUM;
        const configResult = getChainConfig(chainId);
        assert(configResult.isOk());
        const config = configResult.value;

        expect(config.nativeWrappedToken).toEqual(WNATIVE[chainId]);
        expect(config.routeProcessors["3"]).toBe(ROUTE_PROCESSOR_3_ADDRESS[chainId]);
        expect(config.routeProcessors["3.1"]).toBe(ROUTE_PROCESSOR_3_1_ADDRESS[chainId]);
        expect(config.routeProcessors["3.2"]).toBe(ROUTE_PROCESSOR_3_2_ADDRESS[chainId]);
        expect(config.routeProcessors["4"]).toBe(ROUTE_PROCESSOR_4_ADDRESS[chainId]);
        expect(config.stableTokens).toEqual(STABLES[chainId]);
        expect(config.isSpecialL2).toBe(SpecialL2Chains.is(config.id));
        for (const key in publicClientConfig[chainId].chain) {
            expect(config[key]).toEqual(publicClientConfig[chainId].chain[key]);
        }
    });

    it("should throw if chain is not supported", () => {
        const invalidChainId = 999999 as ChainId;
        const configResult = getChainConfig(invalidChainId);
        assert(configResult.isErr());
        expect(configResult.error.type).toBe(ChainConfigErrorType.UnsupportedChain);
    });

    it("should throw if native wrapped token is not supported", () => {
        const fakeChainId = 123456 as ChainId;
        (publicClientConfig as any)[fakeChainId] = { chain: { id: fakeChainId } };
        (WNATIVE as any)[fakeChainId] = undefined;

        const configResult = getChainConfig(fakeChainId);
        assert(configResult.isErr());
        expect(configResult.error.type).toBe(ChainConfigErrorType.MissingNativeWrappedTokenInfo);

        delete (publicClientConfig as any)[fakeChainId];
    });

    it("should throw if rp4 is missing", () => {
        const chainId = ChainId.POLYGON;
        const configResult = getChainConfig(chainId);
        assert(configResult.isErr());
        expect(configResult.error.type).toBe(
            ChainConfigErrorType.MissingSushiRouteProcessor4Address,
        );
    });

    it("should only include route processors that exist for the chain", () => {
        const chainId = ChainId.FLARE;
        const configResult = getChainConfig(chainId);
        assert(configResult.isOk());
        const config = configResult.value;
        expect(config.routeProcessors["3.1"]).toBeUndefined();
    });

    it("should correctly identify special L2 chains", () => {
        expect(SpecialL2Chains.is(SpecialL2Chains.BASE)).toBe(true);
        expect(SpecialL2Chains.is(SpecialL2Chains.OPTIMISM)).toBe(true);
        expect(SpecialL2Chains.is(ChainId.ETHEREUM)).toBe(false);
    });
});
