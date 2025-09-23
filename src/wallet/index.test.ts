import { parseUnits } from "viem";
import * as common from "../common";
import * as sweepFns from "./sweep";
import { WalletType } from "./config";
import { SharedState } from "../state";
import { ErrorSeverity } from "../error";
import * as fundVault from "./fundVault";
import { RainSolverSigner } from "../signer";
import { ABI, TokenDetails } from "../common";
import { SpanStatusCode } from "@opentelemetry/api";
import { SWEEP_RETRY_COUNT, WalletManager } from "./index";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// mock signer module
vi.mock("../signer", () => ({
    RainSolverSigner: {
        create: vi.fn().mockImplementation((wallet) => ({
            account: wallet,
            getSelfBalance: vi.fn(),
            getBalance: vi.fn().mockResolvedValue(0n),
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
            client: {
                multicall: vi.fn(),
                getBalance: vi.fn().mockResolvedValue(0n),
                chain: { contracts: { multicall3: { address: "0xmulticall" } } },
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
            client: {
                multicall: vi.fn(),
                getBalance: vi.fn().mockResolvedValue(0n),
                chain: { contracts: { multicall3: { address: "0xmulticall" } } },
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

            const fundWalletResult = await walletManager.fundWallet(targetWallet);
            assert(fundWalletResult.isErr());
            expect(fundWalletResult.error.status?.message).toMatch("undefined topup amount");
        });

        it("should skip funding if amount is zero", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const spy = vi.spyOn(walletManager.mainSigner, "getSelfBalance");
            const result = await walletManager.fundWallet(
                "0x1234567890123456789012345678901234567890",
                0n,
            );
            assert(result.isOk());
            const report = result.value;

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

            const fundWalletResult = await walletManager.fundWallet(targetWallet);
            assert(fundWalletResult.isErr());
            expect(fundWalletResult.error).toMatchObject({
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

            const result = await walletManager.fundWallet(targetWallet);
            assert(result.isOk());
            const report = result.value;

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

            const fundWalletResult = await walletManager.fundWallet(targetWallet);
            assert(fundWalletResult.isErr());
            expect(fundWalletResult.error).toMatchObject({
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

            // verify successfully swept
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(report.status?.message).toBe("Successfully swept wallet tokens");

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

    describe("Test convertToGas", () => {
        it("should call convertToGas function with this", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const spy = vi.spyOn(sweepFns, "convertToGas");
            walletManager.convertToGas(mockToken, 10n).catch(() => {});

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(walletManager.mainSigner, mockToken, 10n);

            spy.mockRestore();
        });
    });

    describe("Test convertHoldingsToGas", () => {
        beforeEach(() => {
            vi.clearAllMocks();

            // add watched tokens to state
            (singleWalletState as any).watchedTokens = new Map([
                [
                    "TEST1",
                    {
                        address: "0xtoken1" as `0x${string}`,
                        symbol: "TEST1",
                        decimals: 18,
                    },
                ],
                [
                    "TEST2",
                    {
                        address: "0xtoken2" as `0x${string}`,
                        symbol: "TEST2",
                        decimals: 6,
                    },
                ],
            ]);
        });

        it("should successfully convert all tokens to gas", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock successful conversions
            const convertToGasSpy = vi
                .spyOn(walletManager, "convertToGas")
                .mockResolvedValueOnce({
                    txHash: "0xhash1",
                    amount: parseUnits("100", 18),
                    route: "TEST1 -> WETH",
                    receivedAmount: parseUnits("0.1", 18),
                    receivedAmountMin: parseUnits("0.095", 18),
                    status: "Successfully swapped",
                    expectedGasCost: parseUnits("0.01", 18),
                })
                .mockResolvedValueOnce({
                    txHash: "0xhash2",
                    amount: parseUnits("50", 6),
                    route: "TEST2 -> WETH",
                    receivedAmount: parseUnits("0.05", 18),
                    receivedAmountMin: parseUnits("0.0475", 18),
                    status: "Successfully swapped",
                    expectedGasCost: parseUnits("0.01", 18),
                });

            const report = await walletManager.convertHoldingsToGas(2n);

            // verify report structure
            expect(report.name).toBe("sweep-wallet");
            expect(report.attributes["details.wallet"]).toBe(walletManager.mainWallet.address);

            // verify TEST1 conversion details
            expect(report.attributes["details.swaps.TEST1.token"]).toBe("0xtoken1");
            expect(report.attributes["details.swaps.TEST1.tx"]).toBe(
                "https://explorer.test/tx/0xhash1",
            );
            expect(report.attributes["details.swaps.TEST1.status"]).toBe("Successfully swapped");
            expect(report.attributes["details.swaps.TEST1.amount"]).toBe("100");
            expect(report.attributes["details.swaps.TEST1.receivedAmount"]).toBe("0.1");
            expect(report.attributes["details.swaps.TEST1.receivedAmountMin"]).toBe("0.095");
            expect(report.attributes["details.swaps.TEST1.expectedGasCost"]).toBe("0.01");
            expect(report.attributes["details.swaps.TEST1.route"]).toBe("TEST1 -> WETH");

            // verify TEST2 conversion details
            expect(report.attributes["details.swaps.TEST2.token"]).toBe("0xtoken2");
            expect(report.attributes["details.swaps.TEST2.tx"]).toBe(
                "https://explorer.test/tx/0xhash2",
            );
            expect(report.attributes["details.swaps.TEST2.status"]).toBe("Successfully swapped");
            expect(report.attributes["details.swaps.TEST2.amount"]).toBe("50");
            expect(report.attributes["details.swaps.TEST2.receivedAmount"]).toBe("0.05");
            expect(report.attributes["details.swaps.TEST2.receivedAmountMin"]).toBe("0.0475");
            expect(report.attributes["details.swaps.TEST2.expectedGasCost"]).toBe("0.01");
            expect(report.attributes["details.swaps.TEST2.route"]).toBe("TEST2 -> WETH");

            // verify spy calls
            expect(convertToGasSpy).toHaveBeenCalledTimes(2);
            expect(convertToGasSpy).toHaveBeenNthCalledWith(
                1,
                (singleWalletState as any).watchedTokens.get("TEST1"),
                2n,
            );
            expect(convertToGasSpy).toHaveBeenNthCalledWith(
                2,
                (singleWalletState as any).watchedTokens.get("TEST2"),
                2n,
            );

            convertToGasSpy.mockRestore();
        });

        it("should handle conversion failures with transaction hash", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock failed conversion with tx hash
            const convertToGasSpy = vi.spyOn(walletManager, "convertToGas").mockRejectedValue({
                txHash: "0xfailed",
                error: new Error("Swap failed due to slippage"),
            });

            const report = await walletManager.convertHoldingsToGas(2n);

            // verify TEST1 failure details
            expect(report.attributes["details.swaps.TEST1.tx"]).toBe(
                "https://explorer.test/tx/0xfailed",
            );
            expect(report.attributes["details.swaps.TEST1.status"]).toContain(
                "Swap failed due to slippage",
            );

            // verify TEST2 failure details
            expect(report.attributes["details.swaps.TEST2.tx"]).toBe(
                "https://explorer.test/tx/0xfailed",
            );
            expect(report.attributes["details.swaps.TEST2.status"]).toContain(
                "Swap failed due to slippage",
            );

            convertToGasSpy.mockRestore();
        });

        it("should handle conversion failures without transaction hash", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock failed conversion without tx hash
            const convertToGasSpy = vi
                .spyOn(walletManager, "convertToGas")
                .mockRejectedValue(new Error("No route found"));

            const report = await walletManager.convertHoldingsToGas(2n);

            // verify TEST1 failure details
            expect(report.attributes["details.swaps.TEST1.status"]).toContain(
                "Failed to convert token to gas",
            );
            expect(report.attributes["details.swaps.TEST1.status"]).toContain("No route found");

            // verify TEST2 failure details
            expect(report.attributes["details.swaps.TEST2.status"]).toContain(
                "Failed to convert token to gas",
            );
            expect(report.attributes["details.swaps.TEST2.status"]).toContain("No route found");

            convertToGasSpy.mockRestore();
        });

        it("should handle mixed success and failure cases", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // mock mixed success/failure
            const convertToGasSpy = vi
                .spyOn(walletManager, "convertToGas")
                .mockResolvedValueOnce({
                    txHash: "0xsuccess",
                    amount: parseUnits("100", 18),
                    route: "TEST1 -> WETH",
                    receivedAmount: parseUnits("0.1", 18),
                    receivedAmountMin: parseUnits("0.095", 18),
                    status: "Successfully swapped",
                    expectedGasCost: parseUnits("0.01", 18),
                })
                .mockRejectedValueOnce(new Error("No route found"));

            const report = await walletManager.convertHoldingsToGas(2n);

            // verify TEST1 success details
            expect(report.attributes["details.swaps.TEST1.tx"]).toBe(
                "https://explorer.test/tx/0xsuccess",
            );
            expect(report.attributes["details.swaps.TEST1.status"]).toBe("Successfully swapped");

            // verify TEST2 failure details
            expect(report.attributes["details.swaps.TEST2.status"]).toContain(
                "Failed to convert token to gas",
            );
            expect(report.attributes["details.swaps.TEST2.status"]).toContain("No route found");

            convertToGasSpy.mockRestore();
        });

        it("should handle empty watched tokens list", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);

            // clear watched tokens
            (singleWalletState as any).watchedTokens = new Map();

            const convertToGasSpy = vi.spyOn(walletManager, "convertToGas");

            const report = await walletManager.convertHoldingsToGas(2n);

            // verify no conversions were attempted
            expect(convertToGasSpy).not.toHaveBeenCalled();
            expect(Object.keys(report.attributes)).not.toContain("details.swaps");

            convertToGasSpy.mockRestore();
        });

        it("should pass swapCostMultiplier correctly", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const convertToGasSpy = vi.spyOn(walletManager, "convertToGas");

            await walletManager.convertHoldingsToGas(5n);

            // verify multiplier was passed correctly
            expect(convertToGasSpy).toHaveBeenCalledTimes(2);
            expect(convertToGasSpy).toHaveBeenCalledWith(expect.any(Object), 5n);

            convertToGasSpy.mockRestore();
        });
    });

    describe("Test tryRemoveWorker", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should successfully remove worker after successful sweep", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const sweepWalletSpy = vi.spyOn(walletManager, "sweepWallet").mockResolvedValue({
                name: "sweep-wallet",
                status: { code: SpanStatusCode.OK },
                attributes: {},
                end: vi.fn(),
            } as any);

            const report = await walletManager.tryRemoveWorker(workerSigner);

            expect(report.name).toBe("remove-wallet");
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(walletManager.workers.pendingRemove.size).toBe(0);
            expect(sweepWalletSpy).toHaveBeenCalledWith(workerSigner);

            sweepWalletSpy.mockRestore();
        });

        it("should add worker to pendingRemove on first sweep failure", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const sweepWalletSpy = vi.spyOn(walletManager, "sweepWallet").mockResolvedValue({
                name: "sweep-wallet",
                status: { code: SpanStatusCode.ERROR },
                attributes: {},
                end: vi.fn(),
            } as any);

            const report = await walletManager.tryRemoveWorker(workerSigner);

            expect(report.name).toBe("remove-wallet");
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(walletManager.workers.pendingRemove.get(workerSigner)).toBe(1);

            sweepWalletSpy.mockRestore();
        });

        it("should increment retry count on subsequent sweep failures", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const sweepWalletSpy = vi.spyOn(walletManager, "sweepWallet").mockResolvedValue({
                name: "sweep-wallet",
                status: { code: SpanStatusCode.ERROR },
                attributes: {},
                end: vi.fn(),
            } as any);

            // first failure
            await walletManager.tryRemoveWorker(workerSigner);
            expect(walletManager.workers.pendingRemove.get(workerSigner)).toBe(1);

            // second failure
            await walletManager.tryRemoveWorker(workerSigner);
            expect(walletManager.workers.pendingRemove.get(workerSigner)).toBe(2);

            sweepWalletSpy.mockRestore();
        });

        it("should remove worker from pendingRemove after max retries", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const sweepWalletSpy = vi.spyOn(walletManager, "sweepWallet").mockResolvedValue({
                name: "sweep-wallet",
                status: { code: SpanStatusCode.ERROR },
                attributes: {},
                end: vi.fn(),
            } as any);

            // set initial retry count to max - 1
            walletManager.workers.pendingRemove.set(workerSigner, SWEEP_RETRY_COUNT);

            // final failure attempt
            await walletManager.tryRemoveWorker(workerSigner);
            expect(walletManager.workers.pendingRemove.has(workerSigner)).toBe(false);

            sweepWalletSpy.mockRestore();
        });
    });

    describe("Test tryAddWorker", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should successfully add worker after successful funding", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const fundWalletSpy = vi.spyOn(walletManager, "fundWallet").mockResolvedValue(
                common.Result.ok({
                    name: "fund-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: {},
                    end: vi.fn(),
                } as any),
            );

            const report = await walletManager.tryAddWorker(workerSigner);

            expect(report.name).toBe("add-wallet");
            expect(report.status?.code).toBe(SpanStatusCode.OK);
            expect(
                walletManager.workers.signers.has(workerSigner.account.address.toLowerCase()),
            ).toBe(true);
            expect(walletManager.workers.pendingAdd.size).toBe(0);
            expect(fundWalletSpy).toHaveBeenCalledWith(workerSigner.account.address);

            fundWalletSpy.mockRestore();
        });

        it("should add worker to pendingAdd on funding failure", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const fundWalletSpy = vi.spyOn(walletManager, "fundWallet").mockResolvedValue(
                common.Result.err({
                    name: "fund-wallet",
                    status: { code: SpanStatusCode.ERROR },
                    attributes: {},
                    end: vi.fn(),
                } as any),
            );

            const report = await walletManager.tryAddWorker(workerSigner);

            expect(report.name).toBe("add-wallet");
            expect(report.status?.code).toBe(SpanStatusCode.ERROR);
            expect(
                walletManager.workers.pendingAdd.has(workerSigner.account.address.toLowerCase()),
            ).toBe(true);
            expect(
                walletManager.workers.signers.has(workerSigner.account.address.toLowerCase()),
            ).toBe(false);

            fundWalletSpy.mockRestore();
        });
    });

    describe("Test retryPendingAddWorkers", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should retry all pending add workers", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup pending add workers
            const pendingAddWorker1 = RainSolverSigner.create(
                privateKeyToAccount(
                    "0x3234567890123456789012345678901234567890123456789012345678901234",
                ),
                multiWalletState,
            );
            const pendingAddWorker2 = RainSolverSigner.create(
                privateKeyToAccount(
                    "0x4234567890123456789012345678901234567890123456789012345678901234",
                ),
                multiWalletState,
            );

            walletManager.workers.pendingAdd.set(
                pendingAddWorker1.account.address.toLowerCase(),
                pendingAddWorker1,
            );
            walletManager.workers.pendingAdd.set(
                pendingAddWorker2.account.address.toLowerCase(),
                pendingAddWorker2,
            );

            // mock tryAddWorker
            const tryAddWorkerSpy = vi
                .spyOn(walletManager, "tryAddWorker")
                .mockResolvedValueOnce({
                    name: "add-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: { worker: pendingAddWorker1.account.address },
                    end: vi.fn(),
                } as any)
                .mockResolvedValueOnce({
                    name: "add-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: { worker: pendingAddWorker2.account.address },
                    end: vi.fn(),
                } as any);

            const reports = await walletManager.retryPendingAddWorkers();

            // verify reports
            expect(reports).toHaveLength(2);
            expect(reports[0].name).toBe("add-wallet");
            expect(reports[1].name).toBe("add-wallet");

            // verify tryAddWorker was called for each pending worker
            expect(tryAddWorkerSpy).toHaveBeenCalledTimes(2);
            expect(tryAddWorkerSpy).toHaveBeenCalledWith(pendingAddWorker1);
            expect(tryAddWorkerSpy).toHaveBeenCalledWith(pendingAddWorker2);

            tryAddWorkerSpy.mockRestore();
        });

        it("should handle empty pending add list", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const tryAddWorkerSpy = vi.spyOn(walletManager, "tryAddWorker");

            const reports = await walletManager.retryPendingAddWorkers();

            expect(reports).toHaveLength(0);
            expect(tryAddWorkerSpy).not.toHaveBeenCalled();

            tryAddWorkerSpy.mockRestore();
        });

        it("should handle failures during retry", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup a pending add worker
            const pendingAddWorker = RainSolverSigner.create(
                privateKeyToAccount(
                    "0x3234567890123456789012345678901234567890123456789012345678901234",
                ),
                multiWalletState,
            );
            walletManager.workers.pendingAdd.set(
                pendingAddWorker.account.address.toLowerCase(),
                pendingAddWorker,
            );

            // mock tryAddWorker to fail
            const tryAddWorkerSpy = vi
                .spyOn(walletManager, "tryAddWorker")
                .mockRejectedValue(new Error("Funding failed"));

            await expect(walletManager.retryPendingAddWorkers()).rejects.toThrow("Funding failed");

            tryAddWorkerSpy.mockRestore();
        });
    });

    describe("Test retryPendingRemoveWorkers", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should retry all pending remove workers", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup pending remove workers
            const pendingRemoveWorker1 = workerSigner;
            const pendingRemoveWorker2 = RainSolverSigner.create(
                privateKeyToAccount(
                    "0x3234567890123456789012345678901234567890123456789012345678901234",
                ),
                multiWalletState,
            );

            walletManager.workers.pendingRemove.set(pendingRemoveWorker1, 1);
            walletManager.workers.pendingRemove.set(pendingRemoveWorker2, 1);

            // mock tryRemoveWorker
            const tryRemoveWorkerSpy = vi
                .spyOn(walletManager, "tryRemoveWorker")
                .mockResolvedValueOnce({
                    name: "remove-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: { worker: pendingRemoveWorker1.account.address },
                    end: vi.fn(),
                } as any)
                .mockResolvedValueOnce({
                    name: "remove-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: { worker: pendingRemoveWorker2.account.address },
                    end: vi.fn(),
                } as any);

            const reports = await walletManager.retryPendingRemoveWorkers();

            // verify reports
            expect(reports).toHaveLength(2);
            expect(reports[0].name).toBe("remove-wallet");
            expect(reports[1].name).toBe("remove-wallet");

            // verify tryRemoveWorker was called for each pending worker
            expect(tryRemoveWorkerSpy).toHaveBeenCalledTimes(2);
            expect(tryRemoveWorkerSpy).toHaveBeenCalledWith(pendingRemoveWorker1);
            expect(tryRemoveWorkerSpy).toHaveBeenCalledWith(pendingRemoveWorker2);

            tryRemoveWorkerSpy.mockRestore();
        });

        it("should handle empty pending remove list", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const tryRemoveWorkerSpy = vi.spyOn(walletManager, "tryRemoveWorker");

            const reports = await walletManager.retryPendingRemoveWorkers();

            expect(reports).toHaveLength(0);
            expect(tryRemoveWorkerSpy).not.toHaveBeenCalled();

            tryRemoveWorkerSpy.mockRestore();
        });

        it("should handle failures during retry", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup a pending remove worker
            walletManager.workers.pendingRemove.set(workerSigner, 1);

            // mock tryRemoveWorker to fail
            const tryRemoveWorkerSpy = vi
                .spyOn(walletManager, "tryRemoveWorker")
                .mockRejectedValue(new Error("Sweep failed"));

            await expect(walletManager.retryPendingRemoveWorkers()).rejects.toThrow("Sweep failed");

            tryRemoveWorkerSpy.mockRestore();
        });
    });

    describe("Test assessWorkers", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should identify and replace low balance workers", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup state with average gas cost
            (multiWalletState as any).gasCosts = [parseUnits("0.01", 18)];

            // mock a worker with low balance
            const workers = Array.from(walletManager.workers.signers.values());
            const lowBalanceWorker = workers[0];
            vi.spyOn(lowBalanceWorker, "getSelfBalance").mockResolvedValue(parseUnits("0.01", 18));

            // mock a worker with sufficient balance
            vi.spyOn(workers[1], "getSelfBalance").mockResolvedValue(parseUnits("100", 18));
            vi.spyOn(workers[2], "getSelfBalance").mockResolvedValue(parseUnits("100", 18));

            // mock the worker management methods
            const tryRemoveWorkerSpy = vi
                .spyOn(walletManager, "tryRemoveWorker")
                .mockResolvedValue({
                    name: "remove-wallet",
                    status: { code: SpanStatusCode.OK },
                    attributes: {},
                    end: vi.fn(),
                } as any);

            const tryAddWorkerSpy = vi.spyOn(walletManager, "tryAddWorker").mockResolvedValue({
                name: "add-wallet",
                status: { code: SpanStatusCode.OK },
                attributes: {},
                end: vi.fn(),
            } as any);

            const reports = await walletManager.assessWorkers();

            expect(reports).toHaveLength(1);
            expect(reports[0]).toHaveProperty("removeWorkerReport");
            expect(reports[0]).toHaveProperty("addWorkerReport");
            expect(tryRemoveWorkerSpy).toHaveBeenCalledWith(lowBalanceWorker);
            expect(tryAddWorkerSpy).toHaveBeenCalled();
            expect(walletManager.workers.lastUsedDerivationIndex).toBeGreaterThan(3);

            tryRemoveWorkerSpy.mockRestore();
            tryAddWorkerSpy.mockRestore();
        });

        it("should not replace workers with sufficient balance", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);

            // setup state with average gas cost
            (multiWalletState as any).gasCosts = [parseUnits("0.01", 18)];

            // mock workers with sufficient balance
            for (const [, worker] of walletManager.workers.signers) {
                vi.spyOn(worker, "getSelfBalance").mockResolvedValue(parseUnits("1", 18));
            }

            const reports = await walletManager.assessWorkers();

            expect(reports).toHaveLength(0);
            expect(walletManager.workers.lastUsedDerivationIndex).toBe(3);
        });
    });

    describe("Test fundOwnedVaults", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should return empty array when no self fund vaults configured", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            walletManager.config.selfFundVaults = undefined;

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toEqual([]);
        });

        it("should successfully fund multiple vaults", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.config.selfFundVaults = [
                {
                    token: "0xtoken1",
                    vaultId: "1",
                    orderbook: "0xorderbook1",
                    threshold: "100",
                    topupAmount: "1000",
                },
                {
                    token: "0xtoken2",
                    vaultId: "2",
                    orderbook: "0xorderbook2",
                    threshold: "200",
                    topupAmount: "2000",
                },
            ];

            // mock fundVault to return success for both vaults
            const fundVaultSpy = vi
                .spyOn(fundVault, "fundVault")
                .mockResolvedValueOnce({ txHash: "0xtx1" })
                .mockResolvedValueOnce({ txHash: "0xtx2" });

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toHaveLength(2);

            // verify first vault report
            expect(reports[0].name).toBe("fund-owned-vaults");
            expect(reports[0].attributes).toMatchObject({
                "details.wallet": walletManager.mainWallet.address,
                "details.vault": "1",
                "details.token": "0xtoken1",
                "details.orderbook": "0xorderbook1",
                "details.topupAmount": "1000",
                "details.threshold": "100",
                "details.tx": "https://explorer.test/tx/0xtx1",
            });
            expect(reports[0].status).toEqual({
                code: SpanStatusCode.OK,
                message: "Successfully funded vault",
            });

            // verify second vault report
            expect(reports[1].name).toBe("fund-owned-vaults");
            expect(reports[1].attributes).toMatchObject({
                "details.wallet": walletManager.mainWallet.address,
                "details.vault": "2",
                "details.token": "0xtoken2",
                "details.orderbook": "0xorderbook2",
                "details.topupAmount": "2000",
                "details.threshold": "200",
                "details.tx": "https://explorer.test/tx/0xtx2",
            });
            expect(reports[1].status).toEqual({
                code: SpanStatusCode.OK,
                message: "Successfully funded vault",
            });

            fundVaultSpy.mockRestore();
        });

        it("should handle funding failure with transaction hash", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.config.selfFundVaults = [
                {
                    token: "0xtoken1",
                    vaultId: "1",
                    orderbook: "0xorderbook1",
                    threshold: "100",
                    topupAmount: "1000",
                },
            ];

            // mock fundVault to throw error with transaction hash
            const fundVaultSpy = vi.spyOn(fundVault, "fundVault").mockRejectedValue({
                txHash: "0xfailed",
                error: new Error("Transaction reverted"),
            });

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toHaveLength(1);
            expect(reports[0].attributes).toMatchObject({
                "details.wallet": walletManager.mainWallet.address,
                "details.vault": "1",
                "details.token": "0xtoken1",
                "details.tx": "https://explorer.test/tx/0xfailed",
                severity: ErrorSeverity.MEDIUM,
            });
            expect(reports[0].status).toEqual({
                code: SpanStatusCode.ERROR,
                message: expect.stringContaining("Transaction reverted"),
            });

            fundVaultSpy.mockRestore();
        });

        it("should handle funding failure without transaction hash", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.config.selfFundVaults = [
                {
                    token: "0xtoken1",
                    vaultId: "1",
                    orderbook: "0xorderbook1",
                    threshold: "100",
                    topupAmount: "1000",
                },
            ];

            // mock fundVault to throw error without transaction hash
            const fundVaultSpy = vi
                .spyOn(fundVault, "fundVault")
                .mockRejectedValue(new Error("Failed to fetch balance"));

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toHaveLength(1);
            expect(reports[0].attributes).toMatchObject({
                "details.wallet": walletManager.mainWallet.address,
                "details.vault": "1",
                "details.token": "0xtoken1",
                severity: ErrorSeverity.MEDIUM,
            });
            expect(reports[0].status).toEqual({
                code: SpanStatusCode.ERROR,
                message: expect.stringContaining("Failed to fetch balance"),
            });
            expect(reports[0].attributes).not.toHaveProperty("details.tx");

            fundVaultSpy.mockRestore();
        });

        it("should handle mixed success and failure cases", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.config.selfFundVaults = [
                {
                    token: "0xtoken1",
                    vaultId: "1",
                    orderbook: "0xorderbook1",
                    threshold: "100",
                    topupAmount: "1000",
                },
                {
                    token: "0xtoken2",
                    vaultId: "2",
                    orderbook: "0xorderbook2",
                    threshold: "200",
                    topupAmount: "2000",
                },
            ];

            // mock fundVault to succeed for first vault and fail for second
            const fundVaultSpy = vi
                .spyOn(fundVault, "fundVault")
                .mockResolvedValueOnce({ txHash: "0xsuccess" })
                .mockRejectedValue(new Error("Funding failed"));

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toHaveLength(2);

            // verify successful vault report
            expect(reports[0].status).toEqual({
                code: SpanStatusCode.OK,
                message: "Successfully funded vault",
            });
            expect(reports[0].attributes["details.tx"]).toBe("https://explorer.test/tx/0xsuccess");

            // verify failed vault report
            expect(reports[1].status).toEqual({
                code: SpanStatusCode.ERROR,
                message: expect.stringContaining("Funding failed"),
            });
            expect(reports[1].attributes.severity).toBe(ErrorSeverity.MEDIUM);

            fundVaultSpy.mockRestore();
        });

        it("should skip funding when vault balance is sufficient", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.config.selfFundVaults = [
                {
                    token: "0xtoken1",
                    vaultId: "1",
                    orderbook: "0xorderbook1",
                    threshold: "100",
                    topupAmount: "1000",
                },
            ];

            // mock fundVault to return undefined (indicating skip)
            const fundVaultSpy = vi.spyOn(fundVault, "fundVault").mockResolvedValue(undefined);

            const reports = await walletManager.fundOwnedVaults();

            expect(reports).toHaveLength(0);

            fundVaultSpy.mockRestore();
        });
    });

    describe("Test getRandomSigner", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should return mainSigner when no workers available (single wallet mode)", async () => {
            const { walletManager } = await WalletManager.init(singleWalletState);
            const signer = await walletManager.getRandomSigner();

            expect(signer).toBe(walletManager.mainSigner);
        });

        it("should return mainSigner when workers map is empty (multi wallet mode)", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            walletManager.workers.signers.clear();
            const signer = await walletManager.getRandomSigner();

            expect(signer).toBe(walletManager.mainSigner);
        });

        it("should return available worker when not busy", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            // mock all workers as not busy
            for (const [, worker] of walletManager.workers.signers) {
                (worker as any).busy = false;
            }
            const signer = await walletManager.getRandomSigner();

            expect(walletManager.workers.signers.has(signer.account.address.toLowerCase())).toBe(
                true,
            );
            expect(signer).not.toBe(walletManager.mainSigner);
        });

        it("should wait and return first available worker when all initially busy", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const workers = Array.from(walletManager.workers.signers.values());
            // mock all workers as busy initially
            workers.forEach((worker) => {
                (worker as any).busy = true;
            });
            // make first worker available after some time
            setTimeout(() => {
                (workers[0] as any).busy = false;
            }, 50);
            const signer = await walletManager.getRandomSigner();

            expect(signer).toBe(workers[0]);
        });

        it("should shuffle workers when shuffle parameter is true", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            // mock all workers as not busy
            for (const [, worker] of walletManager.workers.signers) {
                (worker as any).busy = false;
            }
            // spy on shuffleArray utility
            const shuffleArraySpy = vi.spyOn(common, "shuffleArray");
            await walletManager.getRandomSigner(true);

            expect(shuffleArraySpy).toHaveBeenCalledTimes(1);
            expect(shuffleArraySpy).toHaveBeenCalledWith(expect.any(Array));

            shuffleArraySpy.mockRestore();
        });

        it("should return first available worker in order when shuffle is false", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const workers = Array.from(walletManager.workers.signers.values());
            // make first two workers busy, third one available
            (workers[0] as any).busy = true;
            (workers[1] as any).busy = true;
            (workers[2] as any).busy = false;

            const signer = await walletManager.getRandomSigner(false);

            expect(signer).toBe(workers[2]);
        });

        it("should handle scenario where worker becomes available during polling", async () => {
            const { walletManager } = await WalletManager.init(multiWalletState);
            const workers = Array.from(walletManager.workers.signers.values());
            // mock all workers as busy initially
            workers.forEach((worker) => {
                (worker as any).busy = true;
            });
            // make second worker available after two polling cycles
            setTimeout(() => {
                (workers[1] as any).busy = false;
            }, 70); // should be after 2-3 polling cycles (30ms each)

            const start = Date.now();
            const signer = await walletManager.getRandomSigner();
            const elapsed = Date.now() - start;

            expect(signer).toBe(workers[1]);
            expect(elapsed).toBeGreaterThanOrEqual(60); // at least 2 polling cycles
        });
    });

    describe("Test getWorkerWalletsBalance", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should return empty object when in single wallet mode (PrivateKey)", async () => {
            // setup single wallet mode
            const { walletManager } = await WalletManager.init(singleWalletState);

            const result = await walletManager.getWorkerWalletsBalance();

            expect(result).toEqual({});
            expect(walletManager.state.client.multicall).not.toHaveBeenCalled();
        });

        it("should call multicall with correct parameters and return worker balances", async () => {
            // setup mock balances
            const { walletManager } = await WalletManager.init(multiWalletState);
            const mockBalances = [1000000000000000000n, 2000000000000000000n, 3000000000000000000n];
            (walletManager.state.client.multicall as Mock).mockResolvedValue(mockBalances);

            const result = await walletManager.getWorkerWalletsBalance();
            const workers = Array.from(walletManager.workers.signers);

            // verify multicall was called with correct parameters
            expect(walletManager.state.client.multicall).toHaveBeenCalledTimes(1);
            expect(walletManager.state.client.multicall).toHaveBeenCalledWith({
                multicallAddress: "0xmulticall",
                allowFailure: false,
                contracts: [
                    {
                        address: "0xmulticall",
                        allowFailure: false,
                        abi: ABI.Multicall3.Primary.Multicall,
                        functionName: "getEthBalance",
                        args: [workers[0][1].account.address],
                    },
                    {
                        address: "0xmulticall",
                        allowFailure: false,
                        abi: ABI.Multicall3.Primary.Multicall,
                        functionName: "getEthBalance",
                        args: [workers[1][1].account.address],
                    },
                    {
                        address: "0xmulticall",
                        allowFailure: false,
                        abi: ABI.Multicall3.Primary.Multicall,
                        functionName: "getEthBalance",
                        args: [workers[2][1].account.address],
                    },
                ],
            });

            // verify returned result
            expect(result).toStrictEqual({
                [workers[0][0]]: 1000000000000000000n,
                [workers[1][0]]: 2000000000000000000n,
                [workers[2][0]]: 3000000000000000000n,
            });
        });

        it("should handle empty workers list", async () => {
            // setup empty workers
            const { walletManager } = await WalletManager.init(multiWalletState);
            (walletManager as any).workers = {
                signers: new Map(),
            };

            (walletManager.state.client.multicall as Mock).mockResolvedValue([]);

            const result = await walletManager.getWorkerWalletsBalance();

            // verify multicall was called with empty contracts array
            expect(walletManager.state.client.multicall as Mock).toHaveBeenCalledWith({
                multicallAddress: "0xmulticall",
                allowFailure: false,
                contracts: [],
            });

            expect(result).toEqual({});
        });

        it("should return empty object when multicall fails", async () => {
            // setup multicall to reject
            const { walletManager } = await WalletManager.init(multiWalletState);
            (walletManager.state.client.multicall as Mock).mockRejectedValue(
                new Error("Multicall failed"),
            );

            const result = await walletManager.getWorkerWalletsBalance();

            expect(walletManager.state.client.multicall).toHaveBeenCalledTimes(1);
            expect(result).toEqual({});
        });
    });
});
