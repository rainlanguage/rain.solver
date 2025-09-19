import { parseUnits } from "viem";
import * as sweepFns from "./sweep";
import { WalletType } from "./config";
import { WalletManager } from "./index";
import { ErrorSeverity } from "../error";
import { RainSolverSigner } from "../signer";
import { SpanStatusCode } from "@opentelemetry/api";
import { SharedState, TokenDetails } from "../state";
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
    const mockToken: TokenDetails = {
        address: "0xtoken" as `0x${string}`,
        symbol: "TEST",
        decimals: 18,
    };

    let singleWalletState: SharedState;
    let multiWalletState: SharedState;
    let workerSigner: RainSolverSigner;

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
                blockExplorers: {
                    default: { url: "https://explorer.test" },
                },
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
                blockExplorers: {
                    default: { url: "https://explorer.test" },
                },
            },
        } as any);

        workerSigner = RainSolverSigner.create(
            privateKeyToAccount(
                "0x2234567890123456789012345678901234567890123456789012345678901234",
            ),
            singleWalletState,
        );
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

    describe("Test sweepWallet", () => {
        beforeEach(() => {
            vi.clearAllMocks();

            // add watched token to state
            (singleWalletState as any).watchedTokens = new Map([["TEST", mockToken]]);
        });

        it("should successfully sweep all tokens and gas", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock successful token transfer
            const transferTokenFromSpy = vi
                .spyOn(walletManager, "transferTokenFrom")
                .mockResolvedValue({
                    amount: parseUnits("1", 18),
                    txHash: "0xtoken_hash",
                });

            // mock successful gas transfer
            const transferRemainingGasFromSpy = vi
                .spyOn(walletManager, "transferRemainingGasFrom")
                .mockResolvedValue({
                    amount: parseUnits("0.1", 18),
                    txHash: "0xgas_hash",
                });

            const report = await walletManager.sweepWallet(workerSigner);

            // verify report attributes
            expect(report.name).toBe("sweep-wallet");
            expect(report.attributes["details.wallet"]).toBe(workerSigner.account.address);
            expect(report.attributes["details.destination"]).toBe(walletManager.mainWallet.address);

            // verify token transfer details
            expect(report.attributes["details.transfers.TEST.token"]).toBe(mockToken.address);
            expect(report.attributes["details.transfers.TEST.tx"]).toBe(
                "https://explorer.test/tx/0xtoken_hash",
            );
            expect(report.attributes["details.transfers.TEST.status"]).toBe(
                "Transferred successfully",
            );
            expect(report.attributes["details.transfers.TEST.amount"]).toBe("1");

            // verify gas transfer details
            expect(report.attributes["details.transfers.remainingGas.tx"]).toBe(
                "https://explorer.test/tx/0xgas_hash",
            );
            expect(report.attributes["details.transfers.remainingGas.status"]).toBe(
                "Transferred successfully",
            );
            expect(report.attributes["details.transfers.remainingGas.amount"]).toBe("0.1");

            // verify no failures were recorded
            expect(report.status?.code).not.toBe(SpanStatusCode.ERROR);

            transferTokenFromSpy.mockRestore();
            transferRemainingGasFromSpy.mockRestore();
        });

        it("should handle token transfer failures", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock failed token transfer with transaction hash
            const transferTokenFromSpy = vi
                .spyOn(walletManager, "transferTokenFrom")
                .mockRejectedValue({
                    txHash: "0xfailed_token",
                    error: new Error("Token transfer failed"),
                });

            // mock successful gas transfer
            const transferRemainingGasFromSpy = vi
                .spyOn(walletManager, "transferRemainingGasFrom")
                .mockResolvedValue({
                    amount: parseUnits("0.1", 18),
                    txHash: "0xgas_hash",
                });

            const report = await walletManager.sweepWallet(workerSigner);

            // verify failure was recorded
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(report.status?.message).toBe(
                "Failed to sweep some tokens, it will try again later",
            );

            // verify token failure details
            expect(report.attributes["details.transfers.TEST.tx"]).toBe(
                "https://explorer.test/tx/0xfailed_token",
            );
            expect(report.attributes["details.transfers.TEST.status"]).toContain(
                "Token transfer failed",
            );

            transferTokenFromSpy.mockRestore();
            transferRemainingGasFromSpy.mockRestore();
        });

        it("should handle gas transfer failures", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock successful token transfer
            const transferTokenFromSpy = vi
                .spyOn(walletManager, "transferTokenFrom")
                .mockResolvedValue({
                    amount: parseUnits("1", 18),
                    txHash: "0xtoken_hash",
                });

            // mock failed gas transfer without transaction hash
            const transferRemainingGasFromSpy = vi
                .spyOn(walletManager, "transferRemainingGasFrom")
                .mockRejectedValue(new Error("Gas transfer failed"));

            const report = await walletManager.sweepWallet(workerSigner);

            // verify failure was recorded
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.LOW);

            // verify gas failure details
            expect(report.attributes["details.transfers.remainingGas.status"]).toContain(
                "Gas transfer failed",
            );

            transferTokenFromSpy.mockRestore();
            transferRemainingGasFromSpy.mockRestore();
        });

        it("should handle both token and gas transfer failures", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock failed token transfer without transaction hash
            const transferTokenFromSpy = vi
                .spyOn(walletManager, "transferTokenFrom")
                .mockRejectedValue(new Error("Token transfer failed"));

            // mock failed gas transfer with transaction hash
            const transferRemainingGasFromSpy = vi
                .spyOn(walletManager, "transferRemainingGasFrom")
                .mockRejectedValue({
                    txHash: "0xfailed_gas",
                    error: new Error("Gas transfer failed"),
                });

            const report = await walletManager.sweepWallet(workerSigner);

            // verify failures were recorded
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(report.attributes["severity"]).toBe(ErrorSeverity.LOW);
            expect(report.status?.message).toBe(
                "Failed to sweep some tokens, it will try again later",
            );

            // verify token failure details
            expect(report.attributes["details.transfers.TEST.status"]).toContain(
                "Failed to transfer",
            );

            // verify gas failure details
            expect(report.attributes["details.transfers.remainingGas.tx"]).toBe(
                "https://explorer.test/tx/0xfailed_gas",
            );
            expect(report.attributes["details.transfers.remainingGas.status"]).toContain(
                "Gas transfer failed",
            );

            transferTokenFromSpy.mockRestore();
            transferRemainingGasFromSpy.mockRestore();
        });

        it("should handle empty watched tokens list", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // clear watched tokens
            (singleWalletState as any).watchedTokens = new Map();

            const transferRemainingGasFromSpy = vi
                .spyOn(walletManager, "transferRemainingGasFrom")
                .mockResolvedValue({
                    amount: parseUnits("0.1", 18),
                    txHash: "0xgas_hash",
                });
            const transferTokenFromSpy = vi
                .spyOn(walletManager, "transferTokenFrom")
                .mockResolvedValue({
                    amount: parseUnits("0.1", 18),
                    txHash: "0xtoken_hash",
                });

            const report = await walletManager.sweepWallet(workerSigner);

            // verify no token transfers were attempted
            expect(transferRemainingGasFromSpy).toHaveBeenCalledTimes(1);
            expect(transferTokenFromSpy).not.toHaveBeenCalled();

            // verify gas transfer was still attempted and successful
            expect(report.attributes["details.transfers.remainingGas.status"]).toBe(
                "Transferred successfully",
            );

            transferRemainingGasFromSpy.mockRestore();
            transferTokenFromSpy.mockRestore();
        });
    });

    describe("Test transferTokenFrom", () => {
        it("should call transferTokenFrom function with this", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const spy = vi.spyOn(sweepFns, "transferTokenFrom");
            walletManager.transferTokenFrom(workerSigner, mockToken).catch(() => {});

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(workerSigner, walletManager.mainSigner, mockToken);

            spy.mockRestore();
        });
    });

    describe("Test transferRemainingGasFrom", () => {
        it("should call transferRemainingGasFrom function with this", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const spy = vi.spyOn(sweepFns, "transferRemainingGasFrom");
            walletManager.transferRemainingGasFrom(workerSigner).catch(() => {});

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(workerSigner, walletManager.mainWallet.address);

            spy.mockRestore();
        });
    });
});
