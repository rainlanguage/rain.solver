import { sleep } from "../utils";
import { getGasPrice } from "./gasPrice";
import { getChainConfig } from "./chain";
import { createPublicClient } from "viem";
import { LiquidityProviders } from "sushi";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { SharedState, SharedStateConfig, TokenDetails } from "./index";

vi.mock("./gasPrice", () => ({
    getGasPrice: vi.fn().mockResolvedValue({
        gasPrice: { value: 1000n },
        l1GasPrice: { value: 0n },
    }),
}));

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    createPublicClient: vi.fn().mockImplementation(() => ({
        getChainId: vi.fn().mockResolvedValue(1),
        readContract: vi.fn(),
    })),
}));

vi.mock("./chain", () => ({
    getChainConfig: vi.fn().mockReturnValue({
        id: 1,
        isSpecialL2: false,
        nativeWrappedToken: "0xwrapped",
        routeProcessors: {},
        stableTokens: [],
    }),
}));

describe("Test SharedStateConfig tryFromAppOptions", () => {
    let options: any;
    let mockClient: any;

    beforeEach(() => {
        options = {
            key: "0xkey",
            rpc: [{ url: "http://example.com" }],
            writeRpc: undefined,
            dispair: "0xdispair",
            gasPriceMultiplier: 123,
            liquidityProviders: ["UniswapV2"],
            timeout: 1000,
            txGas: "120%",
            botMinBalance: "0.0000000001",
        };
        mockClient = {
            getChainId: vi.fn().mockResolvedValue(1),
            readContract: vi
                .fn()
                .mockImplementationOnce(() => Promise.resolve("0xinterpreter"))
                .mockImplementationOnce(() => Promise.resolve("0xstore")),
        };
        (createPublicClient as Mock).mockReturnValue(mockClient);
    });

    it("should build SharedStateConfig from AppOptions (happy path)", async () => {
        const config = await SharedStateConfig.tryFromAppOptions(options);
        expect(config.walletConfig).toEqual({ key: "0xkey", minBalance: 100_000_000n, type: 1 });
        expect(config.gasPriceMultiplier).toBe(123);
        expect(config.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
        expect(config.client).toBeDefined();
        expect(config.chainConfig.id).toBe(1);
        expect(config.dispair).toEqual({
            interpreter: "0xinterpreter",
            store: "0xstore",
            deployer: "0xdispair",
        });
        expect(config.initGasPrice).toBe(1000n);
        expect(config.initL1GasPrice).toBe(0n);
        expect(config.transactionGas).toBe("120%");
        expect(config.rainSolverTransportConfig).toMatchObject({ timeout: 1000 });
    });

    it("should throw if iInterpreter contract call fails", async () => {
        mockClient.readContract = vi
            .fn()
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValueOnce("0xstore");
        await expect(SharedStateConfig.tryFromAppOptions(options)).rejects.toMatch(
            /failed to get dispair iInterpreter address/,
        );
    });

    it("should throw if iStore contract call fails", async () => {
        mockClient.readContract = vi
            .fn()
            .mockResolvedValueOnce("0xinterpreter")
            .mockRejectedValueOnce(new Error("fail"));
        await expect(SharedStateConfig.tryFromAppOptions(options)).rejects.toMatch(
            /failed to get dispair iStore address/,
        );
    });

    it("should throw if getChainConfig returns undefined", async () => {
        (getChainConfig as Mock).mockReturnValue(undefined);
        await expect(SharedStateConfig.tryFromAppOptions(options)).rejects.toMatch(
            /Cannot find configuration for the network/,
        );
    });
});

describe("Test SharedState", () => {
    let config: any;
    let sharedState: SharedState;

    beforeEach(() => {
        config = {
            dispair: {
                interpreter: "0xinterpreter",
                store: "0xstore",
                deployer: "0xdispair",
            },
            walletConfig: {
                key: "0xkey",
            },
            liquidityProviders: [LiquidityProviders.UniswapV2],
            client: { dummy: true },
            chainConfig: { id: 1, isSpecialL2: false },
            rpcState: {},
            writeRpcState: {},
            gasPriceMultiplier: 123,
            initGasPrice: 1000n,
            initL1GasPrice: 0n,
        };
        sharedState = new SharedState(config);
    });

    it("should initialize properties from config", () => {
        expect(sharedState.dispair).toEqual(config.dispair);
        expect(sharedState.walletConfig).toEqual({ key: "0xkey" });
        expect(sharedState.chainConfig).toEqual(config.chainConfig);
        expect(sharedState.liquidityProviders).toEqual([LiquidityProviders.UniswapV2]);
        expect(sharedState.gasPriceMultiplier).toBe(123);
        expect(sharedState.gasPrice).toBe(1000n);
        expect(sharedState.l1GasPrice).toBe(0n);
        expect(sharedState.rpc).toBe(config.rpcState);
        expect(sharedState.writeRpc).toBe(config.writeRpcState);
    });

    it("should start watching gas price", () => {
        expect(sharedState.isWatchingGasPrice).toBe(true);
        sharedState.unwatchGasPrice();
        expect(sharedState.isWatchingGasPrice).toBe(false);
    });

    it("should update gas prices on interval if getGasPrices resolve", async () => {
        // patch getGasPrice to return new values
        (getGasPrice as any).mockResolvedValue({
            gasPrice: { value: 5555n },
            l1GasPrice: { value: 8888n },
        });
        // watchGasPrice with a short interval for test
        sharedState.unwatchGasPrice();
        sharedState.watchGasPrice(10);
        await sleep(100); // wait for new gas prices to be fetched

        expect(sharedState.gasPrice).toBe(5555n);
        expect(sharedState.l1GasPrice).toBe(8888n);

        sharedState.unwatchGasPrice();
    });

    it("should watch tokens", () => {
        const token1: TokenDetails = { address: "0xABC", symbol: "TKN", decimals: 18 };
        const token2: TokenDetails = { address: "0xDEF", symbol: "TKN2", decimals: 18 };
        sharedState.watchToken(token1);
        sharedState.watchToken(token2);

        expect(sharedState.watchedTokens.get("0xabc")).toBe(token1);
        expect(sharedState.watchedTokens.get("0xdef")).toBe(token2);
        expect(Array.from(sharedState.watchedTokens).length).toBe(2);

        // should not duplicate
        sharedState.watchToken(token2);
        expect(Array.from(sharedState.watchedTokens).length).toBe(2);
    });
});
