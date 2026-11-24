import { LiquidityProviders } from "sushi";
import { Result } from "../../common";
import { getChainConfig } from "../../state/chain";
import { RainSolverRouter } from "../../router/router";
import { SweepCmd, sweepFunds, SweepOptions } from "./sweep";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    createPublicClient: vi.fn().mockReturnValue({ getChainId: vi.fn().mockResolvedValue(16661) }),
}));

vi.mock("../../state/chain", async (importOriginal) => ({
    ...(await importOriginal()),
    getChainConfig: vi.fn(),
}));

describe("Test sweep cli options", () => {
    it("should get sweep cli options", async function () {
        // overwrite the action for testing
        SweepCmd.action(function () {});

        const expected: Record<string, any> = {
            mnemonic: "phrase",
            subgraph: ["http://sg1.com"],
            rpc: ["http://rpc.com"],
            length: 100,
            token: [
                { address: "0x123", symbol: "SYM", decimals: 18 },
                { address: "0x456", symbol: "SYM2", decimals: 6 },
            ],
            gasConversion: false,
            routeProcessor: 6,
        };
        const result = SweepCmd.parse([
            "",
            "",
            "--mnemonic",
            "phrase",
            "--subgraph",
            "http://sg1.com",
            "--rpc",
            "http://rpc.com",
            "--length",
            "100",
            "--token",
            "0x123,SYM,18",
            "-t",
            "0x456,SYM2,6",
            "--no-gas-conversion",
            "--route-processor",
            "6",
        ]).opts();
        expect(result).toEqual(expected);

        // the route processor version is 4 or 6
        expect(() => SweepCmd.parse(["", "", "--route-processor", "5"]).opts()).toThrow(
            "expected either of 4 or 6 for routeProcessor",
        );

        // unknown flag should throw
        expect(() => SweepCmd.parse(["", "", "-a"]).opts()).toThrow(
            'process.exit unexpectedly called with "1"',
        );
    });
});

describe("Test sweepFunds route processor", () => {
    const opts: SweepOptions = {
        mnemonic: "test test test test test test test test test test test junk",
        subgraph: [],
        rpc: ["http://rpc.com"],
        length: 1,
        token: [],
        gasConversion: true,
    };

    beforeEach(() => {
        vi.mocked(getChainConfig).mockReturnValue(
            Result.ok({ id: 16661, routeProcessors: { "4": "0xrp4", "6": "0xrp6" } } as any),
        );
    });

    it("should build the sweep router for the given route processor and its liquidity providers", async () => {
        // the router init fails on purpose, so the sweep stops right after its config is built
        const spy = vi
            .spyOn(RainSolverRouter, "create")
            .mockResolvedValue(Result.err(new Error("stop")) as any);

        // RouteProcessor6 keeps the Uniswap V4 style providers
        await expect(sweepFunds({ ...opts, routeProcessor: 6 })).rejects.toThrow("stop");
        const config6 = spy.mock.calls[0][0].sushiRouterConfig!;
        expect(config6.sushiRouteProcessorAddress).toBe("0xrp6");
        expect(config6.liquidityProviders).toEqual(
            expect.arrayContaining([LiquidityProviders.UniswapV4, LiquidityProviders.Comfy]),
        );

        // the default, RouteProcessor4, leaves them out
        spy.mockClear();
        await expect(sweepFunds(opts)).rejects.toThrow("stop");
        const config4 = spy.mock.calls[0][0].sushiRouterConfig!;
        expect(config4.sushiRouteProcessorAddress).toBe("0xrp4");
        expect(config4.liquidityProviders).not.toContain(LiquidityProviders.UniswapV4);
        expect(config4.liquidityProviders).not.toContain(LiquidityProviders.Comfy);
        spy.mockRestore();
    });

    it("should throw when the chain has no address for the given route processor", async () => {
        vi.mocked(getChainConfig).mockReturnValue(
            Result.ok({ id: 16661, routeProcessors: { "4": "0xrp4" } } as any),
        );
        const spy = vi.spyOn(RainSolverRouter, "create");

        await expect(sweepFunds({ ...opts, routeProcessor: 6 })).rejects.toThrow(
            "missing route processor 6 address for the network with chain id: 16661",
        );
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
