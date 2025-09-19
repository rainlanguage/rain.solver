import { parseUnits } from "viem";
import { WalletType } from "./config";
import { SharedState } from "../state";
import { WalletManager } from "./index";
import { ErrorSeverity } from "../error";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

// mock signer module
vi.mock("../signer", () => ({
    RainSolverSigner: {
        create: vi.fn().mockImplementation((wallet) => ({
            account: wallet,
            getSelfBalance: vi.fn(),
            sendTx: vi.fn(),
            waitForTransactionReceipt: vi.fn(),
        })),
    },
}));

describe("Test WalletManager", () => {
    const testPrivateKey = "0x1234567890123456789012345678901234567890123456789012345678901234";
    const testMnemonic = "test test test test test test test test test test test junk";

    let singleWalletState: SharedState;
    let multiWalletState: SharedState;

    beforeEach(() => {
        singleWalletState = new SharedState({
            rpc: "https://example.com",
            walletConfig: {
                type: WalletType.PrivateKey,
                key: testPrivateKey,
                minBalance: parseUnits("1", 18),
            },
            chainConfig: {
                id: 1,
                isSpecialL2: false,
            },
        } as any);

        multiWalletState = new SharedState({
            rpc: "https://example.com",
            walletConfig: {
                type: WalletType.Mnemonic,
                key: testMnemonic,
                count: 3,
                minBalance: parseUnits("1", 18),
                topupAmount: parseUnits("0.1", 18),
            },
            chainConfig: {
                id: 1,
                isSpecialL2: false,
            },
        } as any);
    });

    describe("Test init", () => {
        it("should initialize single wallet manager correctly", async () => {
            const { walletManager, reports } = await WalletManager.init(singleWalletState);

            expect(walletManager.config.type).toBe(WalletType.PrivateKey);
            expect(walletManager.mainWallet.address).toBe(
                privateKeyToAccount(testPrivateKey).address,
            );
            expect(walletManager.workers.signers.size).toBe(0);
            expect(reports).toHaveLength(0);
        });

        it("should initialize multi wallet manager with workers", async () => {
            const { walletManager, reports } = await WalletManager.init(multiWalletState);

            expect(walletManager.config.type).toBe(WalletType.Mnemonic);
            expect(walletManager.mainWallet.address).toBe(
                mnemonicToAccount(testMnemonic, { addressIndex: 0 }).address,
            );
            expect(walletManager.workers.signers.size).toBe(3);
            expect(reports).toHaveLength(3);
            expect(walletManager.workers.lastUsedDerivationIndex).toBe(3);
        });
    });

    describe("Test fundWallet", () => {
        it("should throw error if topup amount is undefined", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const targetWallet = "0x1234567890123456789012345678901234567890";

            await expect(walletManager.fundWallet(targetWallet)).rejects.toThrow(
                "undefined topup amount",
            );
        });

        it("should skip funding if amount is zero", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const spy = vi.spyOn(walletManager.mainSigner, "getSelfBalance");
            const report = await walletManager.fundWallet(
                "0x1234567890123456789012345678901234567890",
                0n,
            );

            expect(spy).not.toHaveBeenCalled();
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("Zero topup amount");

            spy.mockRestore();
        });

        it("should report medium severity when main wallet has insufficient funds", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const targetWallet = "0x1234567890123456789012345678901234567890";

            (walletManager.mainSigner.getSelfBalance as Mock).mockResolvedValue(
                parseUnits("0.05", 18),
            );

            await expect(() => walletManager.fundWallet(targetWallet)).rejects.toMatchObject({
                status: {
                    code: SpanStatusCode.ERROR,
                    message: [
                        "Low on funds to topup the wallet",
                        "current main account balance: 0.05",
                        "topup amount: 0.1",
                    ].join("\n"),
                },
                attributes: { severity: ErrorSeverity.MEDIUM },
            });
        });

        it("should successfully fund wallet", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const targetWallet = "0x1234567890123456789012345678901234567890";

            (walletManager.mainSigner.getSelfBalance as Mock).mockResolvedValue(
                parseUnits("1", 18),
            );
            (walletManager.mainSigner.sendTx as Mock).mockResolvedValue("0x123");
            (walletManager.mainSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "success",
            });

            const report = await walletManager.fundWallet(targetWallet);

            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("Successfully topped up");
        });

        it("should handle failed transactions", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const targetWallet = "0x1234567890123456789012345678901234567890";

            (walletManager.mainSigner.getSelfBalance as Mock).mockResolvedValue(
                parseUnits("1", 18),
            );
            (walletManager.mainSigner.sendTx as Mock).mockResolvedValue("0x123");
            (walletManager.mainSigner.waitForTransactionReceipt as Mock).mockResolvedValue({
                status: "reverted",
            });

            await expect(() => walletManager.fundWallet(targetWallet)).rejects.toMatchObject({
                status: {
                    code: SpanStatusCode.ERROR,
                    message: "Failed to topup wallet: tx reverted",
                },
                attributes: { severity: ErrorSeverity.LOW },
            });
        });
    });

    describe("Test addWallet", () => {
        it("should exit early for single wallet mode", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const result = await walletManager.addWallet();
            expect(result).toBeUndefined();
        });

        it("should add new worker wallet in multi wallet mode", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const initialCount = walletManager.workers.signers.size;
            const initialIndex = walletManager.workers.lastUsedDerivationIndex;

            const getSelfBalanceSpy = vi
                .spyOn(walletManager.mainSigner, "getSelfBalance")
                .mockResolvedValue(parseUnits("1", 18));
            const sendTxSpy = vi
                .spyOn(walletManager.mainSigner, "sendTx")
                .mockResolvedValue("0x123");
            const waitForTransactionReceiptSpy = vi
                .spyOn(walletManager.mainSigner, "waitForTransactionReceipt")
                .mockResolvedValue({
                    status: "success",
                } as any);

            const report = await walletManager.addWallet();

            expect(report).toBeDefined();
            expect(walletManager.workers.signers.size).toBe(initialCount + 1);
            expect(walletManager.workers.lastUsedDerivationIndex).toBe(initialIndex + 1);
            expect(report!.name).toBe("add-wallet");

            expect(getSelfBalanceSpy).toHaveBeenCalledTimes(1);
            expect(sendTxSpy).toHaveBeenCalledTimes(1);
            expect(waitForTransactionReceiptSpy).toHaveBeenCalledTimes(1);

            getSelfBalanceSpy.mockRestore();
            sendTxSpy.mockRestore();
            waitForTransactionReceiptSpy.mockRestore();
        });
    });

    describe("Test checkMainWalletBalance", () => {
        it("should report OK when balance is sufficient", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const getSelfBalanceSpy = vi
                .spyOn(walletManager.mainSigner, "getSelfBalance")
                .mockResolvedValue(parseUnits("2", 18));

            const report = await walletManager.checkMainWalletBalance();

            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(getSelfBalanceSpy).toHaveBeenCalledTimes(1);

            getSelfBalanceSpy.mockRestore();
        });

        it("should report high severity for low balance in single wallet mode", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const getSelfBalanceSpy = vi
                .spyOn(walletManager.mainSigner, "getSelfBalance")
                .mockResolvedValue(parseUnits("0.5", 18));

            const report = await walletManager.checkMainWalletBalance();

            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.HIGH);
            expect(getSelfBalanceSpy).toHaveBeenCalledTimes(1);

            getSelfBalanceSpy.mockRestore();
        });

        it("should report medium severity for low balance in multi wallet mode", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const getSelfBalanceSpy = vi
                .spyOn(walletManager.mainSigner, "getSelfBalance")
                .mockResolvedValue(parseUnits("0.5", 18));

            const report = await walletManager.checkMainWalletBalance();

            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.MEDIUM);
            expect(report.status?.message).toContain("wallets with enough balance in circulation");
            expect(getSelfBalanceSpy).toHaveBeenCalledTimes(1);

            getSelfBalanceSpy.mockRestore();
        });

        it("should handle balance check errors", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const error = new Error("Balance check failed");
            const getSelfBalanceSpy = vi
                .spyOn(walletManager.mainSigner, "getSelfBalance")
                .mockRejectedValue(error);

            const report = await walletManager.checkMainWalletBalance();
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(report.status?.message).toContain("Balance check failed");
            expect(getSelfBalanceSpy).toHaveBeenCalledTimes(1);

            getSelfBalanceSpy.mockRestore();
        });
    });
});
