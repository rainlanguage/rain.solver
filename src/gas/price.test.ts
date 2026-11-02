import type { PublicClient } from "viem";
import { describe, it, expect, vi, assert } from "vitest";
import { getGasPrice, getChainGasPrice, getL1GasPrice, getFeeHistoryFees, mean } from "./price";

describe("getGasPrice", () => {
    const baseChainConfig = {
        id: 1,
        isSpecialL2: false,
    } as any;

    it("should return the node's gas price as it is", async () => {
        const mockClient = {
            getGasPrice: vi.fn().mockResolvedValue(1000n),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, baseChainConfig);
        assert(result.gasPrice.isOk());
        expect(result.gasPrice.value).toBe(1000n);
        assert(result.l1GasPrice.isOk());
        expect(result.l1GasPrice.value).toBe(0n);
    });

    it("should return l1GasPrice for special L2 chains", async () => {
        const l2ChainConfig = {
            id: 10,
            isSpecialL2: true,
        } as any;

        const l1BaseFee = 12345n;
        const mockL1Client = {
            getL1BaseFee: vi.fn().mockResolvedValue(l1BaseFee),
        };
        const mockClient = {
            getGasPrice: vi.fn().mockResolvedValue(5000n),
            extend: vi.fn().mockReturnValue(mockL1Client),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, l2ChainConfig);
        assert(result.gasPrice.isOk());
        assert(result.l1GasPrice.isOk());
        expect(result.gasPrice.value).toBe(5000n);
        expect(result.l1GasPrice.value).toBe(l1BaseFee);
    });

    it("should return error for gas price but value for l1GasPrice", async () => {
        const l2ChainConfig = {
            id: 10,
            isSpecialL2: true,
        } as any;

        const l1BaseFee = 12345n;
        const mockL1Client = {
            getL1BaseFee: vi.fn().mockResolvedValue(l1BaseFee),
        };
        const mockClient = {
            getGasPrice: vi.fn().mockRejectedValue(new Error("fail gas")),
            extend: vi.fn().mockReturnValue(mockL1Client),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, l2ChainConfig);
        assert(result.gasPrice.isErr());
        assert(result.l1GasPrice.isOk());
        expect(result.l1GasPrice.value).toBe(l1BaseFee);
    });

    it("should return value for gas price but error for l1GasPrice", async () => {
        const l2ChainConfig = {
            id: 10,
            isSpecialL2: true,
        } as any;

        const mockL1Client = {
            getL1BaseFee: vi.fn().mockRejectedValue(new Error("fail l1")),
        };
        const mockClient = {
            getGasPrice: vi.fn().mockResolvedValue(5000n),
            extend: vi.fn().mockReturnValue(mockL1Client),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, l2ChainConfig);
        assert(result.gasPrice.isOk());
        assert(result.l1GasPrice.isErr());
        expect(result.gasPrice.value).toBe(5000n);
    });

    it("should hand both failures back when the gas price and l1GasPrice fail", async () => {
        const l2ChainConfig = {
            id: 10,
            isSpecialL2: true,
        } as any;

        const mockL1Client = {
            getL1BaseFee: vi.fn().mockRejectedValue(new Error("fail l1")),
        };
        const mockClient = {
            getGasPrice: vi.fn().mockRejectedValue(new Error("fail gas")),
            extend: vi.fn().mockReturnValue(mockL1Client),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, l2ChainConfig);
        assert(result.gasPrice.isErr());
        assert(result.l1GasPrice.isErr());
    });
});

describe("getChainGasPrice", () => {
    it("should read the node's gas price", async () => {
        const client = { getGasPrice: vi.fn().mockResolvedValue(1000n) } as any;
        const result = await getChainGasPrice(client);
        assert(result.isOk());
        expect(result.value).toBe(1000n);
    });

    it("should hand a failed read back", async () => {
        const client = { getGasPrice: vi.fn().mockRejectedValue(new Error("down")) } as any;
        expect((await getChainGasPrice(client)).isErr()).toBe(true);
    });
});

describe("getL1GasPrice", () => {
    it("should be 0 on a chain that is no special L2, with no read", async () => {
        const client = { extend: vi.fn() } as unknown as PublicClient;
        const result = await getL1GasPrice(client, { id: 1, isSpecialL2: false } as any);
        assert(result.isOk());
        expect(result.value).toBe(0n);
        expect(client.extend).not.toHaveBeenCalled();
    });

    it("should read the L1 base fee on a special L2, and hand a failure back", async () => {
        const getL1BaseFee = vi.fn().mockResolvedValue(12345n);
        const client = { extend: vi.fn().mockReturnValue({ getL1BaseFee }) } as any;
        const l2 = { id: 10, isSpecialL2: true } as any;
        const result = await getL1GasPrice(client, l2);
        assert(result.isOk());
        expect(result.value).toBe(12345n);

        getL1BaseFee.mockRejectedValue(new Error("down"));
        expect((await getL1GasPrice(client, l2)).isErr()).toBe(true);
    });
});

describe("getFeeHistoryFees", () => {
    it("should ask for the history and give the mean tip and the next base fee", async () => {
        const getFeeHistory = vi.fn().mockResolvedValue({
            oldestBlock: 96n,
            baseFeePerGas: [1n, 2n, 3n, 4n, 5n, 6n],
            gasUsedRatio: [0.5, 0.5, 0.5, 0.5, 0.5],
            // an empty block has a tip of 0, it is left out
            reward: [[30n], [0n], [10n], [40n], [20n]],
        });
        const client = { getFeeHistory } as unknown as PublicClient;
        const result = await getFeeHistoryFees(client, 5, [75], "pending");
        expect(getFeeHistory).toHaveBeenCalledWith({
            blockCount: 5,
            blockTag: "pending",
            rewardPercentiles: [75],
        });
        assert(result.isOk());
        // the mean of 30, 10, 40 and 20, the 0 left out
        expect(result.value).toEqual({ tip: 25n, nextBaseFee: 6n });
    });

    it("should take the mean of all the blocks' tips at all the percentiles together", async () => {
        // 2 percentiles over 3 blocks give 6 values, one of them an empty block's 0
        const getFeeHistory = vi.fn().mockResolvedValue({
            baseFeePerGas: [1n, 2n, 3n, 4n],
            gasUsedRatio: [0.5, 0.5, 0.5],
            reward: [
                [10n, 60n],
                [0n, 50n],
                [20n, 40n],
            ],
        });
        const result = await getFeeHistoryFees({ getFeeHistory } as any, 3, [76, 90]);
        expect(getFeeHistory.mock.calls[0][0].rewardPercentiles).toEqual([76, 90]);
        assert(result.isOk());
        // the mean of 10, 60, 50, 20 and 40, the 0 left out
        expect(result.value.tip).toBe(36n);
    });

    it("should ask up to the latest block when no tag is given", async () => {
        const getFeeHistory = vi
            .fn()
            .mockResolvedValue({ baseFeePerGas: [1n], gasUsedRatio: [], reward: [] });
        await getFeeHistoryFees({ getFeeHistory } as any, 1, [50]);
        expect(getFeeHistory.mock.calls[0][0].blockTag).toBe("latest");
    });

    it("should give a tip of 0 when no block paid one, and none when the history has no rewards", async () => {
        // a chain with no tip market, every block's reward is 0, that is a read
        const getFeeHistory = vi.fn().mockResolvedValue({
            baseFeePerGas: [1n, 2n, 3n],
            gasUsedRatio: [0, 0.5],
            reward: [
                [0n, 0n],
                [0n, 0n],
            ],
        });
        const result = await getFeeHistoryFees({ getFeeHistory } as any, 2, [50, 75]);
        assert(result.isOk());
        expect(result.value).toEqual({ tip: 0n, nextBaseFee: 3n });

        // no rewards at all is no read of the tip
        getFeeHistory.mockResolvedValue({ baseFeePerGas: [1n, 2n], gasUsedRatio: [0] });
        const noRewards = await getFeeHistoryFees({ getFeeHistory } as any, 1, [50]);
        assert(noRewards.isOk());
        expect(noRewards.value.tip).toBeUndefined();
        getFeeHistory.mockResolvedValue({ baseFeePerGas: [1n, 2n], gasUsedRatio: [0], reward: [] });
        const emptyRewards = await getFeeHistoryFees({ getFeeHistory } as any, 1, [50]);
        assert(emptyRewards.isOk());
        expect(emptyRewards.value.tip).toBeUndefined();
    });

    it("should hand a failed read back", async () => {
        const getFeeHistory = vi.fn().mockRejectedValue(new Error("down"));
        expect((await getFeeHistoryFees({ getFeeHistory } as any, 1, [50])).isErr()).toBe(true);
    });
});

describe("mean", () => {
    it("should give the mean of the values, rounded down, undefined for none", () => {
        expect(mean([])).toBeUndefined();
        expect(mean([5n])).toBe(5n);
        expect(mean([9n, 1n, 5n])).toBe(5n);
        expect(mean([4n, 1n, 3n, 2n])).toBe(2n); // 10 / 4, rounded down
        expect(mean([10n, 30n])).toBe(20n);
        expect(mean([1n, 1n, 2n])).toBe(1n); // 4 / 3, rounded down
    });
});
