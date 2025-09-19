import { createWalletClient } from "viem";
import { RainSolverSigner } from "./index";
import { type SharedState } from "../state";
import { describe, it, expect, vi } from "vitest";
import { rainSolverTransport } from "../transport";
import { RainSolverSignerActions } from "./actions";
import { HDAccount, PrivateKeyAccount, publicActions } from "viem";

vi.mock("../transport", () => ({
    rainSolverTransport: vi.fn().mockReturnValue("mockedTransport"),
}));

vi.mock("viem", () => ({
    createWalletClient: vi.fn().mockReturnValue({
        extend: vi.fn().mockReturnThis(),
    }),
    publicActions: vi.fn(),
}));

vi.mock("./actions", () => ({
    RainSolverSignerActions: {
        fromSharedState: vi.fn().mockReturnValue("mockedActions"),
    },
}));

describe("Test RainSolverSigner creation", () => {
    const mockAccount = {
        address: "0xuser",
        type: "local",
    } as any;

    const mockSharedState = {
        rpc: "https://example.com",
        rainSolverTransportConfig: { timeout: 5000 },
        chainConfig: {
            id: 1,
            name: "Mainnet",
        },
    } as any as SharedState;

    it("should create a signer with correct configuration", () => {
        RainSolverSigner.create(mockAccount, mockSharedState);

        // verify transport creation
        expect(rainSolverTransport).toHaveBeenCalledWith(
            mockSharedState.rpc,
            mockSharedState.rainSolverTransportConfig,
        );

        // verify wallet client creation
        expect(createWalletClient).toHaveBeenCalledWith({
            account: mockAccount,
            transport: "mockedTransport",
            chain: mockSharedState.chainConfig,
        });
    });

    it("should extend the client with public actions and RainSolver actions", () => {
        const mockExtend = vi.fn().mockReturnThis();
        (createWalletClient as any).mockReturnValue({
            extend: mockExtend,
        });

        RainSolverSigner.create(mockAccount, mockSharedState);

        // verify extensions
        expect(mockExtend).toHaveBeenCalledWith(publicActions);
        expect(mockExtend).toHaveBeenCalledWith("mockedActions");
        expect(RainSolverSignerActions.fromSharedState).toHaveBeenCalledWith(mockSharedState);
    });

    it("should create signer with different account types", () => {
        const mockHDAccount = {
            address: "0xuser",
            type: "hd",
            path: "m/44'/60'/0'/0/0",
        } as any as HDAccount;

        const mockPrivateKeyAccount = {
            address: "0xuser",
            type: "local",
            privateKey: "0xprivatekey",
        } as any as PrivateKeyAccount;

        // test with HD account
        RainSolverSigner.create(mockHDAccount, mockSharedState);
        expect(createWalletClient).toHaveBeenCalledWith(
            expect.objectContaining({ account: mockHDAccount }),
        );

        // test with private key account
        RainSolverSigner.create(mockPrivateKeyAccount, mockSharedState);
        expect(createWalletClient).toHaveBeenCalledWith(
            expect.objectContaining({ account: mockPrivateKeyAccount }),
        );
    });

    it("should handle custom chain configurations", () => {
        const customChainState = {
            ...mockSharedState,
            chainConfig: {
                id: 42161,
                name: "Arbitrum One",
                isSpecialL2: true,
            },
        } as SharedState;

        RainSolverSigner.create(mockAccount, customChainState);

        expect(createWalletClient).toHaveBeenCalledWith(
            expect.objectContaining({
                chain: customChainState.chainConfig,
            }),
        );
    });

    it("should handle custom transport configurations", () => {
        const customTransportState = {
            ...mockSharedState,
            rainSolverTransportConfig: {
                timeout: 10000,
                retryCount: 3,
                retryDelay: 1000,
            },
        } as SharedState;

        RainSolverSigner.create(mockAccount, customTransportState);

        expect(rainSolverTransport).toHaveBeenCalledWith(
            customTransportState.rpc,
            customTransportState.rainSolverTransportConfig,
        );
    });
});
