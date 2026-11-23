import { ChainId } from "sushi/chain";
import { WNATIVE } from "sushi/currency";
import { describe, it, expect, vi, assert } from "vitest";
import { ChainConfigErrorType, findUsdTokens, getChainConfig, SpecialL2Chains } from "./chain";
import {
    STABLES,
    publicClientConfig,
    ROUTE_PROCESSOR_3_ADDRESS,
    ROUTE_PROCESSOR_4_ADDRESS,
    ROUTE_PROCESSOR_6_ADDRESS,
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
        ROUTE_PROCESSOR_6_ADDRESS: {
            [ChainId.ETHEREUM]: `0xrp6`,
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
        expect(config.routeProcessors["6"]).toBe((ROUTE_PROCESSOR_6_ADDRESS as any)[chainId]);
        expect(config.stableTokens).toEqual(STABLES[chainId]);
        expect(config.usdTokens.map((v) => v.symbol).slice(0, 2)).toEqual(["USDC", "USDT"]);
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
        expect(config.usdTokens).toHaveLength(1);
        expect(config.usdTokens[0]).toBe(usdgBaseToken);
    });

    it("should keep the stables usd tokens when both stable and base usd tokens exist", () => {
        // ethereum has USDC in its stables, the base usd tokens are not added to them
        const configResult = getChainConfig(ChainId.ETHEREUM);
        assert(configResult.isOk());
        const usdTokens = configResult.value.usdTokens;
        expect(usdTokens[0]).toBe(STABLES[ChainId.ETHEREUM].find((t) => t.symbol === "USDC"));
        expect(usdTokens.every((t) => STABLES[ChainId.ETHEREUM].includes(t))).toBe(true);
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

    it("should build the config of a chain with no rp4 address", () => {
        // the route processor the bot routes through is checked at startup
        const configResult = getChainConfig(ChainId.POLYGON);
        assert(configResult.isOk());
        expect(configResult.value.routeProcessors["4"]).toBeUndefined();
        expect(configResult.value.routeProcessors["3"]).toBe("0xrp3");
    });

    it("should only include route processors that exist for the chain", () => {
        const chainId = ChainId.FLARE;
        const configResult = getChainConfig(chainId);
        assert(configResult.isOk());
        const config = configResult.value;
        expect(config.routeProcessors["3.1"]).toBeUndefined();
        expect(config.routeProcessors["6"]).toBeUndefined();
    });

    it("should build the 0G config with USDC.e as its first usd token, before its USDZ", () => {
        const configResult = getChainConfig(ChainId.ZEROG);
        assert(configResult.isOk());
        const config = configResult.value;
        expect(config.id).toBe(16661);
        expect(config.nativeWrappedToken).toEqual(WNATIVE[ChainId.ZEROG]);
        expect(config.stableTokens?.map((v) => v.symbol)).toEqual(["USDC.e", "USDZ"]);
        expect(config.usdTokens.map((v) => v.symbol)).toEqual(["USDC.e", "USDZ"]);
        expect(config.isSpecialL2).toBe(false);
    });

    it("should correctly identify special L2 chains", () => {
        expect(SpecialL2Chains.is(SpecialL2Chains.BASE)).toBe(true);
        expect(SpecialL2Chains.is(SpecialL2Chains.OPTIMISM)).toBe(true);
        expect(SpecialL2Chains.is(ChainId.ETHEREUM)).toBe(false);
    });
});

describe("Test findUsdTokens", () => {
    const usdc = { symbol: "USDC" } as any;
    const usdt = { symbol: "USDT" } as any;
    const usdcVariant = { symbol: "USDC.e" } as any;
    const usdtVariant = { symbol: "USDT0" } as any;
    const dai = { symbol: "DAI" } as any;
    const usdg = { symbol: "USDG" } as any;
    const usdz = { symbol: "USDZ" } as any;

    it("should order the usd tokens USDC, USDT, the USDC and USDT variants, then USDG and USDZ", () => {
        expect(findUsdTokens([dai, usdtVariant, usdz, usdg, usdt, usdcVariant, usdc])).toEqual([
            usdc,
            usdt,
            usdcVariant,
            usdtVariant,
            usdg,
            usdz,
        ]);
    });

    it("should put the exact USDC and USDT before their variants, and the variants before USDG and USDZ", () => {
        expect(findUsdTokens([usdz, usdcVariant])).toEqual([usdcVariant, usdz]);
        expect(findUsdTokens([usdg, usdtVariant, usdcVariant, usdt])).toEqual([
            usdt,
            usdcVariant,
            usdtVariant,
            usdg,
        ]);
    });

    it("should list each token once and leave out the tokens with no usd symbol", () => {
        expect(findUsdTokens([dai, usdc, { symbol: undefined } as any])).toEqual([usdc]);
    });

    it("should return an empty list when no usd token exists", () => {
        expect(findUsdTokens([dai])).toEqual([]);
        expect(findUsdTokens([])).toEqual([]);
        expect(findUsdTokens(undefined)).toEqual([]);
    });
});
