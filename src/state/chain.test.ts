import { ChainId } from "sushi/chain";
import { WNATIVE } from "sushi/currency";
import { describe, it, expect, vi } from "vitest";
import { getChainConfig, SpecialL2Chains } from "./chain";
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
        const config = getChainConfig(chainId);

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
        expect(() => getChainConfig(invalidChainId)).toThrow(
            "network with id 999999 is not supported",
        );
    });

    it("should throw if native wrapped token is not supported", () => {
        const fakeChainId = 123456 as ChainId;
        (publicClientConfig as any)[fakeChainId] = { chain: { id: fakeChainId } };
        (WNATIVE as any)[fakeChainId] = undefined;

        expect(() => getChainConfig(fakeChainId)).toThrow(
            "wrapped native token info missing for chain 123456",
        );

        delete (publicClientConfig as any)[fakeChainId];
    });

    it("should throw if rp4 is missing", () => {
        const chainId = ChainId.POLYGON;
        expect(() => getChainConfig(chainId)).toThrow(
            "missing route processor 4 address for chain 137",
        );
    });

    it("should only include route processors that exist for the chain", () => {
        const chainId = ChainId.FLARE;
        const config = getChainConfig(chainId);
        expect(config.routeProcessors["3.1"]).toBeUndefined();
    });

    it("should correctly identify special L2 chains", () => {
        expect(SpecialL2Chains.is(SpecialL2Chains.BASE)).toBe(true);
        expect(SpecialL2Chains.is(SpecialL2Chains.OPTIMISM)).toBe(true);
        expect(SpecialL2Chains.is(ChainId.ETHEREUM)).toBe(false);
    });
});
