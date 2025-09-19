import { Router } from "sushi";
import { parseUnits } from "viem";
import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { fallbackEthPrice, getMarketPrice } from "./marketPrice";
import { PoolBlackList, RPoolFilter } from ".";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("sushi", async (importOriginal) => ({
    ...(await importOriginal()),
    Router: {
        findBestRoute: vi.fn(),
    },
}));

describe("Test getMarketPrice", () => {
    let mockSharedState: SharedState;
    let mockFromToken: Token;
    let mockToToken: Token;
    let mockDataFetcher: any;
    let mockPoolCodeMap: Map<string, any>;

    beforeEach(() => {
        vi.clearAllMocks();

        // mock tokens
        mockFromToken = {
            decimals: 18,
            symbol: "WETH",
            address: "0xETH",
            chainId: 1,
        } as any as Token;

        mockToToken = {
            decimals: 6,
            symbol: "USDC",
            address: "0xUSDC",
            chainId: 1,
        } as any as Token;

        // mock pool code map
        mockPoolCodeMap = new Map();

        // mock data fetcher
        mockDataFetcher = {
            fetchPoolsForToken: vi.fn(),
            getCurrentPoolCodeMap: vi.fn().mockReturnValue(mockPoolCodeMap),
        };

        // mock shared state
        mockSharedState = {
            dataFetcher: mockDataFetcher,
            chainConfig: {
                id: 1,
            },
            gasPrice: 20000000000n,
        } as SharedState;
    });

    describe("happy", () => {
        it("should return 1 if from/to tokens are the same", async () => {
            const result = await getMarketPrice.call(mockSharedState, mockFromToken, mockFromToken);
            expect(result).toEqual({ price: "1" });
        });

        it("should call dataFetcher methods with correct parameters", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: parseUnits("2000", 6),
            };
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute as any);
            await getMarketPrice.call(mockSharedState, mockFromToken, mockToToken);

            expect(mockDataFetcher.fetchPoolsForToken).toHaveBeenCalledWith(
                mockFromToken,
                mockToToken,
                PoolBlackList,
                { blockNumber: undefined },
            );
            expect(mockDataFetcher.getCurrentPoolCodeMap).toHaveBeenCalledWith(
                mockFromToken,
                mockToToken,
            );
        });

        it("should call Router.findBestRoute with correct parameters", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: parseUnits("2000", 6),
            };
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute as any);
            await getMarketPrice.call(mockSharedState, mockFromToken, mockToToken);

            expect(Router.findBestRoute).toHaveBeenCalledWith(
                mockPoolCodeMap,
                1,
                mockFromToken,
                parseUnits("1", 18),
                mockToToken,
                Number(mockSharedState.gasPrice),
                undefined,
                RPoolFilter,
            );
        });

        it("should return correct structure for successful route", async () => {
            const mockRoute = {
                status: "Success",
                amountOutBI: parseUnits("2000", 6),
            };
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute as any);
            const result = await getMarketPrice.call(mockSharedState, mockFromToken, mockToToken);

            expect(result).toHaveProperty("price");
            expect(typeof result?.price).toBe("string");
            expect(result?.price).toBe("2000");
        });

        it("should pass blockNumber to fetchPoolsForToken when provided", async () => {
            const blockNumber = 12345678n;
            const mockRoute = {
                status: "Success",
                amountOutBI: parseUnits("1800", 6),
            };
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute as any);
            await getMarketPrice.call(mockSharedState, mockFromToken, mockToToken, blockNumber);

            expect(mockDataFetcher.fetchPoolsForToken).toHaveBeenCalledWith(
                mockFromToken,
                mockToToken,
                PoolBlackList,
                { blockNumber },
            );
        });
    });

    describe("unhappy", () => {
        it("should return undefined when route status is NoWay", async () => {
            const mockRoute = {
                status: "NoWay",
            };
            (Router.findBestRoute as Mock).mockReturnValue(mockRoute as any);
            const result = await getMarketPrice.call(mockSharedState, mockFromToken, mockToToken);

            expect(result).toBeUndefined();
        });
    });
});

describe("Test fallbackEthPrice", () => {
    it("should calculate fallback price when oiRatio is less than ioRatio", () => {
        const oiRatio = parseUnits("0.5", 18); // 0.5 output per input
        const ioRatio = parseUnits("3", 18); // 3 input per output
        const inputPrice = "2000"; // $2000 ETH price for input token
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 5e17 = 2e18 (2 input per output)
        // minRatio = min(2e18, 3e18) = 2e18
        // result = (2e18 * 2000e18) / 1e18 = 4000
        expect(result).toBe("4000");
    });

    it("should calculate fallback price when ioRatio is less than oiRatio", () => {
        const oiRatio = parseUnits("0.1", 18); // 0.1 output per input
        const ioRatio = parseUnits("5", 18); // 5 input per output
        const inputPrice = "1500"; // $1500 ETH price for input token
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 1e17 = 1e19 (10 input per output)
        // minRatio = min(1e19, 5e18) = 5e18
        // result = (5e18 * 1500e18) / 1e18 = 7500
        expect(result).toBe("7500");
    });

    it("should handle zero oiRatio", () => {
        const oiRatio = 0n;
        const ioRatio = parseUnits("2", 18);
        const inputPrice = "3000";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = maxUint256 (very large number)
        // minRatio = min(maxUint256, 2e18) = 2e18
        // result = (2e18 * 3000e18) / 1e18 = 6000
        expect(result).toBe("6000");
    });

    it("should handle equal ratios", () => {
        const oiRatio = parseUnits("0.5", 18);
        const ioRatio = parseUnits("2", 18); // Inverse of oiRatio
        const inputPrice = "2500";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 5e17 = 2e18
        // minRatio = min(2e18, 2e18) = 2e18
        // result = (2e18 * 2500e18) / 1e18 = 5000
        expect(result).toBe("5000");
    });

    it("should handle decimal input prices", () => {
        const oiRatio = parseUnits("0.25", 18);
        const ioRatio = parseUnits("5", 18);
        const inputPrice = "1234.56789";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 25e16 = 4e18
        // minRatio = min(4e18, 5e18) = 4e18
        // result = (4e18 * 1234.56789e18) / 1e18 = 4938.27156
        expect(result).toBe("4938.27156");
    });
});
