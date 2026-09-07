import { RpcState } from "../rpc";
import * as common from "../common";
import { SharedState } from "../state";
import { RainSolverSigner } from "./index";
import { publicActionsL2 } from "viem/op-stack";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, WaitForTransactionReceiptTimeoutError } from "viem";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import {
    sendTx,
    getTxGas,
    broadcastTx,
    tryGetReceipt,
    waitUntilFree,
    getSelfBalance,
    estimateGasCost,
    getWriteSignerFrom,
    isAlreadyKnownTxError,
    RainSolverSignerActions,
} from "./actions";

vi.mock("viem/op-stack", () => ({
    publicActionsL2: vi.fn(),
}));

describe("Test RainSolverSignerActions", () => {
    it("should correctly create actions using fromSharedState()", () => {
        const mockSharedState = {
            watchedTokens: new Map([
                ["0xtoken1", { address: "0xtoken1", symbol: "TKN1", decimals: 18 }],
                ["0xtoken2", { address: "0xtoken2", symbol: "TKN2", decimals: 6 }],
            ]),
        } as SharedState;

        const actions = RainSolverSignerActions.fromSharedState(mockSharedState)();

        expect(actions.state).toBe(mockSharedState);
        expect(actions.busy).toBe(false);
        expect(typeof actions.sendTx).toBe("function");
        expect(typeof actions.waitUntilFree).toBe("function");
        expect(typeof actions.getSelfBalance).toBe("function");
        expect(typeof actions.estimateGasCost).toBe("function");
        expect(typeof actions.asWriteSigner).toBe("function");
        expect(typeof actions.waitForReceipt).toBe("function");
    });
});

describe("Test sendTx", () => {
    let mockSigner: RainSolverSigner;
    const mockTx = {
        to: "0xdestination" as `0x${string}`,
        data: "0xdata" as `0x${string}`,
        gas: 100000n,
    };

    beforeEach(() => {
        mockSigner = {
            busy: false,
            chain: { id: 1 },
            account: {
                address: "0xsender",
                signTransaction: vi.fn().mockResolvedValue("0xserialized"),
            },
            state: {
                gasPrice: 20000000000n,
                gasPriceMultiplier: 110,
                chainConfig: {
                    id: 1,
                    isSpecialL2: false,
                },
                l1GasPrice: undefined,
            },
            waitUntilFree: vi.fn().mockResolvedValue(undefined),
            getTransactionCount: vi.fn().mockResolvedValue(5),
            sendTransaction: vi.fn(),
            sendRawTransaction: vi.fn().mockResolvedValue("0xhash"),
            estimateGas: vi.fn().mockResolvedValue(100000n),
        } as unknown as RainSolverSigner;

        vi.clearAllMocks();
    });

    describe("multi broadcast", () => {
        const serialized = "0x02abcd" as `0x${string}`;
        let request1: Mock;
        let request2: Mock;

        beforeEach(() => {
            request1 = vi.fn();
            request2 = vi.fn();
            (mockSigner as any).chain = { id: 8453 };
            (mockSigner.state as any).chainConfig.id = 8453;
            (mockSigner as any).account.signTransaction = vi.fn().mockResolvedValue(serialized);
            (mockSigner.state as any).appOptions = { multiBroadcast: true };
            (mockSigner.state as any).rainSolverTransportConfig = { timeout: 1234 };
            (mockSigner as any).transport = {
                rpcState: {
                    urls: ["https://rpc1", "https://rpc2"],
                    transports: {
                        "https://rpc1": vi.fn().mockReturnValue({ request: request1 }),
                        "https://rpc2": vi.fn().mockReturnValue({ request: request2 }),
                    },
                },
            };
        });

        it("should sign once and send the raw tx through every rpc, taking the first accepted", async () => {
            request1.mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve("0xhash"), 50)),
            );
            request2.mockResolvedValue("0xhash");

            const { hash } = await sendTx(mockSigner, mockTx);

            expect(hash).toBe("0xhash");
            expect(mockSigner.sendRawTransaction).not.toHaveBeenCalled();
            expect(mockSigner.account.signTransaction).toHaveBeenCalledTimes(1);
            expect(mockSigner.account.signTransaction).toHaveBeenCalledWith(
                { ...mockTx, nonce: 5, chainId: 8453 },
                { serializer: undefined },
            );
            const rpcState = (mockSigner as any).transport.rpcState;
            expect(rpcState.transports["https://rpc1"]).toHaveBeenCalledWith({
                chain: mockSigner.chain,
                retryCount: 0,
                timeout: 1234,
            });
            for (const request of [request1, request2]) {
                expect(request).toHaveBeenCalledTimes(1);
                expect(request).toHaveBeenCalledWith({
                    method: "eth_sendRawTransaction",
                    params: [serialized],
                });
            }
        });

        it("should count an already known error as accepted with the local hash", async () => {
            request1.mockRejectedValue(new Error("already known"));
            request2.mockRejectedValue({ details: "nonce too low" });

            const { hash } = await sendTx(mockSigner, mockTx);

            expect(hash).toBe(keccak256(serialized));
            expect(mockSigner.sendRawTransaction).not.toHaveBeenCalled();
        });

        it("should throw the first error when every rpc rejects the tx", async () => {
            const error1 = new Error("insufficient funds");
            request1.mockRejectedValue(error1);
            request2.mockRejectedValue(new Error("gas too low"));

            // sendTx retries the send once before giving up
            await expect(sendTx(mockSigner, mockTx, 10)).rejects.toThrow(error1);
            expect(request1).toHaveBeenCalledTimes(2);
            expect(request2).toHaveBeenCalledTimes(2);
            expect(mockSigner.busy).toBe(false);
        });

        it("should use the signer's own pool, so a write signer broadcasts through the write rpcs only", async () => {
            // the state has write rpcs, but the pool is the one the signer was
            // built on, which for a write signer is the write rpcs themselves
            (mockSigner.state as any).writeRpc = {
                urls: ["https://write1", "https://write2"],
                transports: {
                    "https://write1": vi.fn().mockReturnValue({ request: vi.fn() }),
                    "https://write2": vi.fn().mockReturnValue({ request: vi.fn() }),
                },
            };
            request1.mockResolvedValue("0xhash");
            request2.mockResolvedValue("0xhash");

            const { hash } = await sendTx(mockSigner, mockTx);

            expect(hash).toBe("0xhash");
            expect(request1).toHaveBeenCalledTimes(1);
            expect(request2).toHaveBeenCalledTimes(1);
            const writeRpc = (mockSigner.state as any).writeRpc;
            expect(writeRpc.transports["https://write1"]).not.toHaveBeenCalled();
            expect(writeRpc.transports["https://write2"]).not.toHaveBeenCalled();
        });

        it("should send the raw tx through the signer transport when disabled or with a single rpc", async () => {
            (mockSigner.state as any).appOptions.multiBroadcast = false;
            await sendTx(mockSigner, mockTx);
            expect(mockSigner.sendRawTransaction).toHaveBeenCalledTimes(1);
            expect(mockSigner.sendRawTransaction).toHaveBeenCalledWith({
                serializedTransaction: serialized,
            });
            expect(request1).not.toHaveBeenCalled();

            (mockSigner.state as any).appOptions.multiBroadcast = true;
            (mockSigner as any).transport.rpcState.urls = ["https://rpc1"];
            mockSigner.busy = false;
            await sendTx(mockSigner, mockTx);
            expect(mockSigner.sendRawTransaction).toHaveBeenCalledTimes(2);
            expect(request1).not.toHaveBeenCalled();
            expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
        });
    });

    it("should successfully send a transaction on first attempt", async () => {
        const { hash: txHash, wait } = await sendTx(mockSigner, mockTx);

        expect(mockSigner.waitUntilFree).not.toHaveBeenCalled();
        expect(mockSigner.getTransactionCount).toHaveBeenCalledWith({
            address: "0xsender",
            blockTag: "latest",
        });
        // signed locally with the signer chain id and sent as raw tx
        expect(mockSigner.account.signTransaction).toHaveBeenCalledWith(
            { ...mockTx, nonce: 5, chainId: 1 },
            { serializer: undefined },
        );
        expect(mockSigner.sendRawTransaction).toHaveBeenCalledWith({
            serializedTransaction: "0xserialized",
        });
        expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
        expect(txHash).toBe("0xhash");
        expect(mockSigner.busy).toBe(true);
        expect(wait).toBeTypeOf("function");
    });

    it("should successfully send a transaction on second attempt", async () => {
        (mockSigner.sendRawTransaction as Mock)
            .mockRejectedValueOnce(new Error("First attempt failed"))
            .mockResolvedValueOnce("0xhash");
        const { hash: txHash, wait } = await sendTx(mockSigner, mockTx, 10);

        expect(mockSigner.waitUntilFree).not.toHaveBeenCalled();
        expect(mockSigner.getTransactionCount).toHaveBeenCalledWith({
            address: "0xsender",
            blockTag: "latest",
        });
        expect(mockSigner.sendRawTransaction).toHaveBeenCalledTimes(2);
        expect(mockSigner.account.signTransaction).toHaveBeenCalledWith(
            { ...mockTx, nonce: 5, chainId: 1 },
            { serializer: undefined },
        );
        expect(txHash).toBe("0xhash");
        expect(mockSigner.busy).toBe(true);
        expect(wait).toBeTypeOf("function");
    });

    it("should successfully send a transaction on second attempt when first nonce fails", async () => {
        (mockSigner.getTransactionCount as Mock)
            .mockRejectedValueOnce(new Error("First attempt failed"))
            .mockResolvedValueOnce(6);
        const { hash: txHash, wait } = await sendTx(mockSigner, mockTx, 10);

        expect(mockSigner.waitUntilFree).not.toHaveBeenCalled();
        expect(mockSigner.getTransactionCount).toHaveBeenCalledTimes(2);
        expect(mockSigner.getTransactionCount).toHaveBeenCalledWith({
            address: "0xsender",
            blockTag: "latest",
        });
        expect(mockSigner.sendRawTransaction).toHaveBeenCalledTimes(1);
        expect(mockSigner.account.signTransaction).toHaveBeenCalledWith(
            { ...mockTx, nonce: 6, chainId: 1 },
            { serializer: undefined },
        );
        expect(txHash).toBe("0xhash");
        expect(mockSigner.busy).toBe(true);
        expect(wait).toBeTypeOf("function");
    });

    it("should wait until signer is free before sending", async () => {
        let busyResolved = false;
        mockSigner.busy = true;
        mockSigner.waitUntilFree = vi.fn().mockImplementation(async () => {
            busyResolved = true;
            return Promise.resolve();
        });

        await sendTx(mockSigner, mockTx);

        expect(busyResolved).toBe(true);
        expect(mockSigner.sendRawTransaction).toHaveBeenCalled();
    });

    it("should set busy state during transaction", async () => {
        const states: boolean[] = [];
        mockSigner.sendRawTransaction = vi.fn().mockImplementation(async () => {
            states.push(mockSigner.busy);
            return "0xhash";
        });

        expect(mockSigner.busy).toBe(false);
        await sendTx(mockSigner, mockTx);
        expect(mockSigner.busy).toBe(true);
        expect(states).toContain(true); // Was busy during transaction
    });

    it("should reset busy state even if transaction fails", async () => {
        const error = new Error("Transaction failed");
        mockSigner.sendRawTransaction = vi.fn().mockRejectedValue(error);

        expect(mockSigner.busy).toBe(false);
        await expect(sendTx(mockSigner, mockTx, 10)).rejects.toThrow(error);
        expect(mockSigner.busy).toBe(false);
    });

    it("should handle getTransactionCount failure", async () => {
        const error = new Error("Failed to get nonce");
        mockSigner.getTransactionCount = vi.fn().mockRejectedValue(error);

        await expect(sendTx(mockSigner, mockTx, 10)).rejects.toThrow(error);
        expect(mockSigner.busy).toBe(false);
        expect(mockSigner.account.signTransaction).not.toHaveBeenCalled();
        expect(mockSigner.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("should use provided gas", async () => {
        const txWithGas = {
            ...mockTx,
            gas: 200000n,
        };

        await sendTx(mockSigner, txWithGas);

        expect(mockSigner.account.signTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
                gas: 200000n,
            }),
            expect.anything(),
        );
    });
});

describe("Test isAlreadyKnownTxError", () => {
    it("should match the already known error messages in any of the error fields", () => {
        expect(isAlreadyKnownTxError(new Error("already known"))).toBe(true);
        expect(isAlreadyKnownTxError(new Error("Transaction ALREADY KNOWN"))).toBe(true);
        expect(isAlreadyKnownTxError({ details: "nonce too low" })).toBe(true);
        expect(isAlreadyKnownTxError({ shortMessage: "known transaction: 0xabc" })).toBe(true);
        expect(isAlreadyKnownTxError({ message: "transaction already imported" })).toBe(true);
        expect(isAlreadyKnownTxError({ details: "ALREADY_EXISTS: already exists" })).toBe(true);
        expect(isAlreadyKnownTxError("AlreadyKnown")).toBe(true);
    });

    it("should prefer details over short message over message", () => {
        // details wins even when the other fields dont match
        expect(
            isAlreadyKnownTxError({
                details: "already known",
                shortMessage: "something else",
                message: "something else",
            }),
        ).toBe(true);
        // and a non matching details hides a matching message
        expect(
            isAlreadyKnownTxError({ details: "insufficient funds", message: "already known" }),
        ).toBe(false);
    });

    it("should not match other errors", () => {
        expect(isAlreadyKnownTxError(new Error("insufficient funds for gas"))).toBe(false);
        expect(isAlreadyKnownTxError(new Error("execution reverted"))).toBe(false);
        expect(isAlreadyKnownTxError({ details: "replacement transaction underpriced" })).toBe(
            false,
        );
        expect(isAlreadyKnownTxError(undefined)).toBe(false);
        expect(isAlreadyKnownTxError(null)).toBe(false);
        expect(isAlreadyKnownTxError(42)).toBe(false);
    });
});

describe("Test broadcastTx", () => {
    const serialized = "0x02abcd" as `0x${string}`;
    const localHash = keccak256(serialized);
    const tx = {
        to: "0xdestination" as `0x${string}`,
        data: "0xdata" as `0x${string}`,
        gas: 100000n,
        gasPrice: 10n,
        nonce: 5,
    };
    let signer: any;
    let request1: Mock;
    let request2: Mock;
    let request3: Mock;
    let transport1: Mock;
    let transport2: Mock;
    let transport3: Mock;
    const serializer = vi.fn();

    // a request that settles only when told to
    const deferred = () => {
        let resolve!: (value: any) => void;
        let reject!: (error: any) => void;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };

    beforeEach(() => {
        request1 = vi.fn();
        request2 = vi.fn();
        request3 = vi.fn();
        transport1 = vi.fn().mockReturnValue({ request: request1 });
        transport2 = vi.fn().mockReturnValue({ request: request2 });
        transport3 = vi.fn().mockReturnValue({ request: request3 });
        signer = {
            chain: { id: 8453, serializers: { transaction: serializer } },
            account: {
                address: "0xsender",
                signTransaction: vi.fn().mockResolvedValue(serialized),
            },
            state: {
                chainConfig: { id: 8453 },
                appOptions: { multiBroadcast: true },
                rainSolverTransportConfig: { timeout: 1234 },
            },
            transport: {
                rpcState: {
                    urls: ["https://rpc1", "https://rpc2", "https://rpc3"],
                    transports: {
                        "https://rpc1": transport1,
                        "https://rpc2": transport2,
                        "https://rpc3": transport3,
                    },
                },
            },
            getChainId: vi.fn().mockResolvedValue(10),
            sendRawTransaction: vi.fn().mockResolvedValue("0xsinglehash"),
        };
    });

    describe("signing", () => {
        it("should sign the tx as given with the state chain id and the signer chain serializer", async () => {
            request1.mockResolvedValue("0xhash");
            request2.mockResolvedValue("0xhash");
            request3.mockResolvedValue("0xhash");

            await broadcastTx(signer, tx as any);

            expect(signer.account.signTransaction).toHaveBeenCalledTimes(1);
            expect(signer.account.signTransaction).toHaveBeenCalledWith(
                { ...tx, chainId: 8453 },
                { serializer },
            );
            expect(signer.getChainId).not.toHaveBeenCalled();
        });

        it("should read the chain id from the rpc when the state chain config has none", async () => {
            signer.chain = undefined;
            signer.state.chainConfig = {};
            request1.mockResolvedValue("0xhash");
            request2.mockResolvedValue("0xhash");
            request3.mockResolvedValue("0xhash");

            await broadcastTx(signer, tx as any);

            expect(signer.getChainId).toHaveBeenCalledTimes(1);
            expect(signer.account.signTransaction).toHaveBeenCalledWith(
                { ...tx, chainId: 10 },
                { serializer: undefined },
            );
        });

        it("should propagate a signing failure without sending anything", async () => {
            const error = new Error("signing failed");
            signer.account.signTransaction.mockRejectedValue(error);

            await expect(broadcastTx(signer, tx as any)).rejects.toThrow(error);
            expect(request1).not.toHaveBeenCalled();
            expect(request2).not.toHaveBeenCalled();
            expect(request3).not.toHaveBeenCalled();
            expect(signer.sendRawTransaction).not.toHaveBeenCalled();
        });
    });

    describe("single send", () => {
        it("should send the raw tx through the signer transport when multi broadcast is off", async () => {
            signer.state.appOptions.multiBroadcast = false;

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe("0xsinglehash");
            expect(signer.sendRawTransaction).toHaveBeenCalledWith({
                serializedTransaction: serialized,
            });
            expect(transport1).not.toHaveBeenCalled();
            expect(transport2).not.toHaveBeenCalled();
            expect(transport3).not.toHaveBeenCalled();
        });

        it("should send the raw tx through the signer transport with a single rpc pool", async () => {
            signer.transport.rpcState.urls = ["https://rpc1"];

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe("0xsinglehash");
            expect(signer.sendRawTransaction).toHaveBeenCalledTimes(1);
            expect(transport1).not.toHaveBeenCalled();
        });

        it("should send the raw tx through the signer transport without a reachable pool", async () => {
            signer.transport = undefined;

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe("0xsinglehash");
            expect(signer.sendRawTransaction).toHaveBeenCalledTimes(1);
        });

        it("should propagate the send failure", async () => {
            signer.state.appOptions.multiBroadcast = false;
            const error = new Error("send failed");
            signer.sendRawTransaction.mockRejectedValue(error);

            await expect(broadcastTx(signer, tx as any)).rejects.toThrow(error);
        });
    });

    describe("multi send", () => {
        it("should instantiate each pool transport with the signer chain, no retry and the configured timeout", async () => {
            request1.mockResolvedValue("0xhash");
            request2.mockResolvedValue("0xhash");
            request3.mockResolvedValue("0xhash");

            await broadcastTx(signer, tx as any);

            for (const transport of [transport1, transport2, transport3]) {
                expect(transport).toHaveBeenCalledTimes(1);
                expect(transport).toHaveBeenCalledWith({
                    chain: signer.chain,
                    retryCount: 0,
                    timeout: 1234,
                });
            }
            for (const request of [request1, request2, request3]) {
                expect(request).toHaveBeenCalledTimes(1);
                expect(request).toHaveBeenCalledWith({
                    method: "eth_sendRawTransaction",
                    params: [serialized],
                });
            }
        });

        it("should leave the timeout undefined without a transport config", async () => {
            signer.state.rainSolverTransportConfig = undefined;
            request1.mockResolvedValue("0xhash");
            request2.mockResolvedValue("0xhash");
            request3.mockResolvedValue("0xhash");

            await broadcastTx(signer, tx as any);

            expect(transport1).toHaveBeenCalledWith({
                chain: signer.chain,
                retryCount: 0,
                timeout: undefined,
            });
        });

        it("should settle with the first accepted hash while the others are still pending", async () => {
            const slow1 = deferred();
            const slow3 = deferred();
            request1.mockReturnValue(slow1.promise);
            request2.mockResolvedValue("0xhash2");
            request3.mockReturnValue(slow3.promise);

            const hash = await broadcastTx(signer, tx as any);

            // settled before the slow ones answered at all
            expect(hash).toBe("0xhash2");
            expect(request1).toHaveBeenCalledTimes(1);
            expect(request3).toHaveBeenCalledTimes(1);

            // the late answers, success or failure, are inert
            slow1.resolve("0xhash1");
            slow3.reject(new Error("late failure"));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("should wait for a later acceptance when the first answers are rejections", async () => {
            const slow = deferred();
            request1.mockRejectedValue(new Error("insufficient funds"));
            request2.mockReturnValue(slow.promise);
            request3.mockRejectedValue(new Error("gas too low"));

            const promise = broadcastTx(signer, tx as any);
            // let the rejections land first
            await new Promise((resolve) => setTimeout(resolve, 0));
            slow.resolve("0xlatehash");

            expect(await promise).toBe("0xlatehash");
        });

        it("should count an already known rejection as acceptance with the local hash", async () => {
            const slow = deferred();
            request1.mockRejectedValue(new Error("already known"));
            request2.mockReturnValue(slow.promise);
            request3.mockReturnValue(slow.promise);

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe(localHash);
            slow.resolve("0xhash");
        });

        it("should return the accepted rpc hash over the local hash when both come in", async () => {
            request1.mockResolvedValue("0xrpchash");
            request2.mockRejectedValue(new Error("already known"));
            request3.mockRejectedValue(new Error("already known"));

            const hash = await broadcastTx(signer, tx as any);

            // whichever settled first wins, both name the same tx
            expect(["0xrpchash", localHash]).toContain(hash);
        });

        it("should count a mix of a real rejection and an already known one as accepted", async () => {
            request1.mockRejectedValue(new Error("insufficient funds"));
            request2.mockRejectedValue({ details: "nonce too low" });
            request3.mockRejectedValue(new Error("execution reverted"));

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe(localHash);
        });

        it("should throw the first rpc error when every rpc rejects", async () => {
            const error1 = new Error("insufficient funds");
            request1.mockRejectedValue(error1);
            request2.mockRejectedValue(new Error("gas too low"));
            request3.mockRejectedValue(new Error("execution reverted"));

            await expect(broadcastTx(signer, tx as any)).rejects.toThrow(error1);
            expect(request1).toHaveBeenCalledTimes(1);
            expect(request2).toHaveBeenCalledTimes(1);
            expect(request3).toHaveBeenCalledTimes(1);
        });

        it("should throw the first rpc error in pool order, not in settle order", async () => {
            const slow = deferred();
            const error1 = new Error("first in pool");
            request1.mockReturnValue(slow.promise);
            request2.mockRejectedValue(new Error("second in pool"));
            request3.mockRejectedValue(new Error("third in pool"));

            const promise = broadcastTx(signer, tx as any);
            await new Promise((resolve) => setTimeout(resolve, 0));
            slow.reject(error1);

            await expect(promise).rejects.toThrow(error1);
        });

        it("should throw non error rejections as they are", async () => {
            request1.mockRejectedValue("rpc unavailable");
            request2.mockRejectedValue("rpc unavailable");
            request3.mockRejectedValue("rpc unavailable");

            await expect(broadcastTx(signer, tx as any)).rejects.toBe("rpc unavailable");
        });

        it("should treat a transport instantiation failure as that rpc rejecting", async () => {
            transport1.mockImplementation(() => {
                throw new Error("bad transport");
            });
            request2.mockResolvedValue("0xhash");
            request3.mockResolvedValue("0xhash");

            const hash = await broadcastTx(signer, tx as any);

            expect(hash).toBe("0xhash");
        });
    });
});

describe("Test estimateGasCost", () => {
    let mockSigner: RainSolverSigner;
    const mockTx = {
        to: "0xdestination" as `0x${string}`,
        data: "0xdata" as `0x${string}`,
    };

    beforeEach(() => {
        mockSigner = {
            state: {
                gasPrice: 20000000000n, // 20 gwei
                gasPriceMultiplier: 110, // 110%
                chainConfig: {
                    isSpecialL2: false,
                },
                l1GasPrice: undefined,
            },
            estimateGas: vi.fn().mockResolvedValue(100000n),
            extend: vi.fn(),
        } as unknown as RainSolverSigner;
    });

    it("should calculate basic gas cost non-L2 chains", async () => {
        const result = await estimateGasCost(mockSigner, mockTx);

        expect(mockSigner.estimateGas).toHaveBeenCalledWith({ ...mockTx, blockTag: "pending" });
        expect(result).toEqual({
            gas: 100000n,
            gasPrice: 20000000000n, // 20 gwei * 110%
            l1GasPrice: 0n,
            l1Cost: 0n,
            totalGasCost: 2000000000000000n, // gas * gasPrice
        });
    });

    it("should include usd value of the total gas cost when gas token usd price is known", async () => {
        (mockSigner.state as any).gasTokenUsdPrice = "2";

        const result = await estimateGasCost(mockSigner, mockTx);

        // price is 2 dollars per gas token, so usd value is 2x the eth value
        expect(result.totalGasCost).toBe(2000000000000000n);
        expect(result.totalGasCostUsd).toBe(4000000000000000n);
    });

    it("should not include usd value of the total gas cost when gas token usd price is unknown", async () => {
        const result = await estimateGasCost(mockSigner, mockTx);

        expect(result.totalGasCostUsd).toBeUndefined();
    });

    it("should calculate gas cost including L2 fees chain is special L2", async () => {
        const mockL2Client = {
            getL1BaseFee: vi.fn().mockResolvedValue(50000000000n), // 50 gwei
            estimateL1Fee: vi.fn().mockResolvedValue(500000000000n), // 500 gwei
        };
        mockSigner.state.chainConfig.isSpecialL2 = true;
        (mockSigner.extend as Mock).mockReturnValue(mockL2Client);

        const result = await estimateGasCost(mockSigner, mockTx);

        expect(mockSigner.extend).toHaveBeenCalledWith(publicActionsL2());
        expect(mockL2Client.getL1BaseFee).toHaveBeenCalled();
        expect(mockL2Client.estimateL1Fee).toHaveBeenCalledWith({
            to: mockTx.to,
            data: mockTx.data,
        });
        expect(result).toEqual({
            gas: 100000n,
            gasPrice: 20000000000n,
            l1GasPrice: 50000000000n,
            l1Cost: 500000000000n,
            totalGasCost: 20000000000n * 100000n + 500000000000n, // L2 gas cost + L1 cost
        });
    });

    it("should use state L1 gas price", async () => {
        const mockL2Client = {
            getL1BaseFee: vi.fn(),
            estimateL1Fee: vi.fn().mockResolvedValue(500000000000n),
        };
        mockSigner.state.chainConfig.isSpecialL2 = true;
        mockSigner.state.l1GasPrice = 40000000000n; // 40 gwei
        (mockSigner.extend as Mock).mockReturnValue(mockL2Client);

        const result = await estimateGasCost(mockSigner, mockTx);

        expect(mockL2Client.getL1BaseFee).not.toHaveBeenCalled();
        expect(result.l1GasPrice).toBe(0n);
    });

    it("should handle L2 estimation errors gracefully", async () => {
        const mockL2Client = {
            getL1BaseFee: vi.fn().mockRejectedValue(new Error("L1 fee estimation failed")),
            estimateL1Fee: vi.fn().mockRejectedValue(new Error("L2 fee estimation failed")),
        };
        mockSigner.state.chainConfig.isSpecialL2 = true;
        (mockSigner.extend as Mock).mockReturnValue(mockL2Client);

        const result = await estimateGasCost(mockSigner, mockTx);

        expect(result).toEqual({
            gas: 100000n,
            gasPrice: 20000000000n,
            l1GasPrice: 0n,
            l1Cost: 0n,
            totalGasCost: 2000000000000000n, // Only L2 gas cost
        });
    });
});

describe("Test getTxGas", () => {
    const originalGas = 100000n;

    it("should return original gas when no transactionGas is set", () => {
        const state = {
            transactionGas: undefined,
        } as SharedState;
        const result = getTxGas(state, originalGas);

        expect(result).toBe(originalGas);
    });

    it("should apply percentage multiplier when transactionGas ends with %", () => {
        const state = {
            transactionGas: "150%", // 150% of original gas
        } as SharedState;
        const result = getTxGas(state, originalGas);

        expect(result).toBe(150000n); // 100000 * 150 / 100
    });

    it("should use fixed gas value when transactionGas is a number string", () => {
        const state = {
            transactionGas: "200000",
        } as SharedState;
        const result = getTxGas(state, originalGas);

        expect(result).toBe(200000n);
    });
});

describe("Test waitUntilFree", () => {
    let mockSigner: RainSolverSigner;
    let sleepSpy: any;

    beforeEach(() => {
        mockSigner = {
            busy: true,
        } as unknown as RainSolverSigner;

        sleepSpy = vi.spyOn(common, "sleep");
        vi.clearAllMocks();
    });

    it("should call sleep once and resolve after 30 ms", async () => {
        setTimeout(() => (mockSigner.busy = false), 10); // set busy to false after 10 ms
        await waitUntilFree(mockSigner);

        expect(sleepSpy).toHaveBeenCalledTimes(1);
        expect(sleepSpy).toHaveBeenCalledWith(30);
    });

    it("should call sleep twice and resolve after 60 ms", async () => {
        setTimeout(() => (mockSigner.busy = false), 40); // set busy to false after 40 ms
        await waitUntilFree(mockSigner);

        expect(sleepSpy).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenCalledWith(30);
    });
});

describe("Test getSelfBalance", () => {
    it("should return the balance for the signer's address", async () => {
        const mockSigner = {
            account: {
                address: "0xuser",
            },
            getBalance: vi.fn(),
        } as unknown as RainSolverSigner;
        const expectedBalance = 1000000n;
        (mockSigner.getBalance as any).mockResolvedValue(expectedBalance);
        const balance = await getSelfBalance(mockSigner);

        expect(mockSigner.getBalance).toHaveBeenCalledWith({
            address: "0xuser",
        });
        expect(balance).toBe(expectedBalance);
    });
});

describe("Test getWriteSignerFrom", () => {
    const account = privateKeyToAccount(
        "0x1234567890123456789012345678901234567890123456789012345678901234",
    );

    it("should return same signer when no write RPC is configured", () => {
        const mockState = new SharedState({
            rpcState: new RpcState([{ url: "https://example.com" }]),
            chainConfig: {
                id: 1,
                isSpecialL2: false,
            },
        } as any);

        const signer = RainSolverSigner.create(account, mockState);
        const spySigner = vi.spyOn(RainSolverSigner, "create");
        getWriteSignerFrom(signer);

        expect(spySigner).toHaveBeenCalledTimes(0);

        spySigner.mockRestore();
    });

    it("should return new signer with write RPC when configured", () => {
        const mockState = new SharedState({
            rpcState: new RpcState([{ url: "https://example.com" }]),
            writeRpcState: new RpcState([{ url: "https://example-write.com" }]),
            chainConfig: {
                id: 1,
                isSpecialL2: false,
            },
        } as any);

        const signer: any = RainSolverSigner.create(account, mockState);
        const spySigner = vi.spyOn(RainSolverSigner, "create");
        getWriteSignerFrom(signer);

        expect(spySigner).toHaveBeenCalledTimes(1);
        expect(spySigner).toHaveBeenCalledWith(account, mockState, true);

        spySigner.mockRestore();
    });
});

describe("Test tryGetReceipt", () => {
    let mockSigner: RainSolverSigner;
    let sleepSpy: any;
    let promiseTimeoutSpy: any;

    beforeEach(() => {
        mockSigner = {
            busy: true,
            state: {
                appOptions: { blockTime: 150 },
                blockNumber: 100n,
                client: {
                    getTransactionReceipt: vi.fn(),
                },
                gasManager: {
                    onTransactionMine: vi.fn(),
                },
            },
        } as unknown as RainSolverSigner;

        sleepSpy = vi.spyOn(common, "sleep");
        promiseTimeoutSpy = vi.spyOn(common, "promiseTimeout");
        vi.clearAllMocks();
    });

    /** Advances the mock state's block number every "every" ms until cleared */
    function startBlocks(every: number) {
        const timer = setInterval(() => ((mockSigner.state as any).blockNumber += 1n), every);
        return () => clearInterval(timer);
    }

    it("should look up the receipt once per new block", async () => {
        (mockSigner.state.client.getTransactionReceipt as Mock)
            .mockRejectedValueOnce(new Error("not found"))
            .mockResolvedValueOnce({ status: "success" });
        // the watcher advances the block number twice
        setTimeout(() => ((mockSigner.state as any).blockNumber = 101n), 50);
        setTimeout(() => ((mockSigner.state as any).blockNumber = 102n), 250);

        const start = Date.now();
        const result = await tryGetReceipt(mockSigner, "0xhash", 5_000, 500);

        expect(result).toEqual({ status: "success" });
        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledTimes(2);
        // two lookups right after the two new blocks
        expect(Date.now() - start).toBeLessThan(1_000);
        // the block number is checked at a fifth of the polling interval
        expect(sleepSpy).toHaveBeenCalledWith(100);
    });

    it("should not look up the receipt while the block number stays the same", async () => {
        (mockSigner.state.client.getTransactionReceipt as Mock).mockResolvedValue({
            status: "success",
        });

        await expect(tryGetReceipt(mockSigner, "0xhash", 350, 100)).rejects.toBeInstanceOf(
            WaitForTransactionReceiptTimeoutError,
        );
        expect(sleepSpy).toHaveBeenCalledWith(20);
        expect(mockSigner.state.client.getTransactionReceipt).not.toHaveBeenCalled();
    });

    it("should default the polling interval to the configured block time", async () => {
        (mockSigner.state.appOptions as any).blockTime = 500;
        (mockSigner.state.client.getTransactionReceipt as Mock).mockResolvedValue({
            status: "success",
        });
        setTimeout(() => ((mockSigner.state as any).blockNumber = 101n), 50);

        const start = Date.now();
        await tryGetReceipt(mockSigner, "0xhash");

        // the tick is a fifth of the block time
        expect(sleepSpy).toHaveBeenCalledWith(100);
        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(Date.now() - start).toBeLessThan(400);
    });

    it("should stop polling once the wait has timed out", async () => {
        (mockSigner.state.client.getTransactionReceipt as Mock).mockRejectedValue(
            new Error("not found"),
        );
        const stopBlocks = startBlocks(5);

        try {
            await expect(tryGetReceipt(mockSigner, "0xhash", 50, 10)).rejects.toBeInstanceOf(
                WaitForTransactionReceiptTimeoutError,
            );
            expect(mockSigner.state.gasManager.onTransactionMine).toHaveBeenCalledWith({
                didMine: false,
                length: expect.any(Number),
            });
            expect(mockSigner.busy).toBe(false);
            // the receipt was looked up while the wait was alive
            expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalled();

            // the dead wait must not keep polling the receipt in the background
            // even though the block number keeps advancing
            await new Promise((resolve) => setTimeout(resolve, 20));
            const calls = (mockSigner.state.client.getTransactionReceipt as Mock).mock.calls.length;
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect((mockSigner.state.client.getTransactionReceipt as Mock).mock.calls.length).toBe(
                calls,
            );
        } finally {
            stopBlocks();
        }
    });

    it("should correctly try to get transaction receipt", async () => {
        (mockSigner.state.client.getTransactionReceipt as Mock)
            .mockImplementationOnce(() => {
                throw new Error("not found");
            }) // 1st call error
            .mockImplementationOnce(() => {
                throw new Error("not found");
            }) // 2nd call error
            .mockImplementationOnce(() => {
                throw new Error("not found");
            }) // 3rd call error
            .mockResolvedValueOnce({ status: "success" }); // 4th call success
        const stopBlocks = startBlocks(40);
        const result = await tryGetReceipt(mockSigner, "0xhash", 1_000, 150).finally(stopBlocks);

        expect(result).toEqual({ status: "success" });
        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledTimes(4);
        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledWith({
            hash: "0xhash",
        });
        expect(sleepSpy).toHaveBeenCalledWith(30);
        expect(promiseTimeoutSpy).toHaveBeenCalledTimes(1);
        expect(promiseTimeoutSpy).toHaveBeenCalledWith(
            expect.any(Promise),
            1000,
            expect.any(Object),
        );
        expect(mockSigner.state.gasManager.onTransactionMine).toHaveBeenCalledTimes(1);
        expect(mockSigner.state.gasManager.onTransactionMine).toHaveBeenCalledWith({
            didMine: true,
            length: expect.any(Number),
        });
        expect(mockSigner.busy).toBe(false);
    });

    it("should hit timeout", async () => {
        (mockSigner.state.client.getTransactionReceipt as Mock).mockImplementationOnce(() => {
            throw new Error("not found");
        });
        // a single new block before the timeout
        setTimeout(() => ((mockSigner.state as any).blockNumber = 101n), 30);
        await tryGetReceipt(mockSigner, "0xhash", 150, 100).catch((err) => {
            expect(err).toBeInstanceOf(WaitForTransactionReceiptTimeoutError);
        });

        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(mockSigner.state.client.getTransactionReceipt).toHaveBeenCalledWith({
            hash: "0xhash",
        });
        expect(sleepSpy).toHaveBeenCalledWith(20);
        expect(promiseTimeoutSpy).toHaveBeenCalledTimes(1);
        expect(promiseTimeoutSpy).toHaveBeenCalledWith(
            expect.any(Promise),
            150,
            new WaitForTransactionReceiptTimeoutError({ hash: "0xhash" }),
        );
        expect(mockSigner.state.gasManager.onTransactionMine).toHaveBeenCalledTimes(1);
        expect(mockSigner.state.gasManager.onTransactionMine).toHaveBeenCalledWith({
            didMine: false,
            length: expect.any(Number),
        });
        expect(mockSigner.busy).toBe(false);
    });
});
