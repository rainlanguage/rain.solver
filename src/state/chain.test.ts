import { ChainId } from "sushi/chain";
import { WNATIVE } from "sushi/currency";
import { describe, it, expect, vi, assert } from "vitest";
import { ChainConfigErrorType, findUsdToken, getChainConfig, SpecialL2Chains } from "./chain";
import {
    STABLES,
    publicClientConfig,
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_3_1_ADDRESS,
    ROUTE_PROCESSOR_3_2_ADDRESS,
} from "sushi/config";

// a usd base token for a chain with no stables entry, stands in for USDG on
// Robinhood, hoisted as the mock factory below runs before this file's top level
const usdgBaseToken = vi.hoisted(() => ({
    chainId: 14, // flare
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 6,
    symbol: "USDG",
    name: "Global Dollar",
}));

vi.mock("sushi/config", async (importOriginal) => {
    const original = await importOriginal<typeof import("sushi/config")>();
    return {
        ...original,
        // flare stands in for a chain with no stables entry whose
        // dollar token is a base token, like USDG on robinhood
        STABLES: { ...original.STABLES, [ChainId.FLARE]: undefined },
        BASES_TO_CHECK_TRADES_AGAINST: {
            ...original.BASES_TO_CHECK_TRADES_AGAINST,
            [ChainId.FLARE]: [
                { symbol: "WFLR" },
                { symbol: "cUSDX" }, // not a usd token, no USDC or USDT in its symbol
                usdgBaseToken,
            ],
        },
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
    };
});

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
        expect(config.usdToken?.symbol).toBe("USDC");
        expect(config.isSpecialL2).toBe(SpecialL2Chains.is(config.id));
        for (const key in publicClientConfig[chainId].chain) {
            expect(config[key as keyof typeof config]).toEqual(
                publicClientConfig[chainId as keyof typeof publicClientConfig].chain[
                    key as keyof (typeof publicClientConfig)[ChainId]["chain"]
                ],
            );
        }
    });

    it("should fall back to a usd base token for a chain with no stables entry", () => {
        const chainId = ChainId.FLARE;
        const configResult = getChainConfig(chainId);
        assert(configResult.isOk());
        const config = configResult.value;

        expect(config.stableTokens).toBeUndefined();
        expect(config.usdToken).toBe(usdgBaseToken);
    });

    it("should keep the stables usd token when both a stable and a base usd token exist", () => {
        // ethereum has USDC in its stables, any base usd token must not override it
        const configResult = getChainConfig(ChainId.ETHEREUM);
        assert(configResult.isOk());
        expect(configResult.value.usdToken).toBe(
            STABLES[ChainId.ETHEREUM].find((t) => t.symbol === "USDC"),
        );
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

describe("Test findUsdToken", () => {
    const usdc = { symbol: "USDC" } as any;
    const usdt = { symbol: "USDT" } as any;
    const usdcVariant = { symbol: "USDC.e" } as any;
    const usdtVariant = { symbol: "USDT0" } as any;
    const dai = { symbol: "DAI" } as any;
    const usdg = { symbol: "USDG" } as any;

    it("should prefer exact USDC over all others", () => {
        expect(findUsdToken([dai, usdtVariant, usdg, usdt, usdcVariant, usdc])).toBe(usdc);
    });

    it("should pick exact USDT when there is no exact USDC", () => {
        expect(findUsdToken([dai, usdcVariant, usdg, usdt])).toBe(usdt);
    });

    it("should pick exact USDG when there is no exact USDC or USDT", () => {
        expect(findUsdToken([dai, usdcVariant, usdtVariant, usdg])).toBe(usdg);
    });

    it("should fall back to a USDC variant when there is no exact match", () => {
        expect(findUsdToken([dai, usdtVariant, usdcVariant])).toBe(usdcVariant);
    });

    it("should fall back to a USDT variant as the last option", () => {
        expect(findUsdToken([dai, usdtVariant])).toBe(usdtVariant);
    });

    it("should return undefined when no usd token exists", () => {
        expect(findUsdToken([dai])).toBeUndefined();
        expect(findUsdToken([])).toBeUndefined();
        expect(findUsdToken(undefined)).toBeUndefined();
    });
});
