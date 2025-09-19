import { Router } from "sushi";
import { parseUnits } from "viem";
import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { getMarketPrice } from "./marketPrice";
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
            expect(result).toEqual({
                price: "1",
                amountOut: "1",
            });
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
            expect(result).toHaveProperty("amountOut");
            expect(typeof result?.price).toBe("string");
            expect(typeof result?.amountOut).toBe("string");
            expect(result?.amountOut).toBe("2000");
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
