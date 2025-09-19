import { ChainId } from "sushi";
import type { PublicClient } from "viem";
import { describe, it, expect, vi } from "vitest";
import { getGasPrice, BSC_DEFAULT_GAS_PRICE } from "./gasPrice";

describe("getGasPrice", () => {
    const baseChainConfig = {
        id: 1,
        isSpecialL2: false,
    } as any;

    it("should return gas price from client and apply multiplier", async () => {
        const mockClient = {
            getGasPrice: vi.fn().mockResolvedValue(1000n),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, baseChainConfig, 200);
        expect(result.gasPrice).toEqual({ value: 2000n });
        expect(result.l1GasPrice).toEqual({ value: 0n });
    });

    it("should return BSC default gas price if below minimum", async () => {
        const bscChainConfig = {
            id: ChainId.BSC,
            isSpecialL2: false,
        } as any;
        const mockClient = {
            getGasPrice: vi.fn().mockResolvedValue(1n),
        } as unknown as PublicClient;

        const result = await getGasPrice(mockClient, bscChainConfig, 100);
        expect(result.gasPrice).toEqual({ value: BSC_DEFAULT_GAS_PRICE });
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
        expect(result.gasPrice).toEqual({ value: 5000n });
        expect(result.l1GasPrice).toEqual({ value: l1BaseFee });
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
        expect(result.gasPrice).toHaveProperty("error");
        expect(result.l1GasPrice).toEqual({ value: l1BaseFee });
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
        expect(result.gasPrice).toEqual({ value: 5000n });
        expect(result.l1GasPrice).toHaveProperty("error");
    });

    it("should throw if both gas price and l1GasPrice fail", async () => {
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

        await expect(getGasPrice(mockClient, l2ChainConfig, 100)).rejects.toMatchObject({
            gasPrice: { error: expect.any(Error) },
            l1GasPrice: { error: expect.any(Error) },
        });
    });
});
