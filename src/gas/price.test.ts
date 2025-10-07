import { ChainId } from "sushi";
import type { PublicClient } from "viem";
import { describe, it, expect, vi, assert } from "vitest";
import { getGasPrice, BSC_DEFAULT_GAS_PRICE } from "./price";

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
        assert(result.gasPrice.isOk());
        expect(result.gasPrice.value).toBe(2000n);
        assert(result.l1GasPrice.isOk());
        expect(result.l1GasPrice.value).toBe(0n);
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
        assert(result.gasPrice.isOk());
        expect(result.gasPrice.value).toBe(BSC_DEFAULT_GAS_PRICE);
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
        assert(result.gasPrice.isOk());
        assert(result.l1GasPrice.isErr());
        expect(result.gasPrice.value).toBe(5000n);
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

        const result = await getGasPrice(mockClient, l2ChainConfig, 100);
        assert(result.gasPrice.isErr());
        assert(result.l1GasPrice.isErr());
    });
});
