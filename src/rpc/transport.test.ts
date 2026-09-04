import { randomInt } from "crypto";
import { getLocal } from "mockttp";
import { polygon } from "viem/chains";
import { describe, it, assert, expect, vi } from "vitest";
import { normalizeUrl, RpcConfig, RpcBufferType, RpcState } from ".";
import {
    rainSolverTransport,
    RainSolverTransportConfig,
    RainSolverTransportTimeoutError,
} from "./transport";

describe("Test transport", async function () {
    it("test RainSolver transport happy", async function () {
        // setup 2 rpc mock servers
        const mockServer1 = getLocal();
        const mockServer2 = getLocal();
        await mockServer1.start(9292);
        await mockServer2.start(9393);

        const rpcConfigs: RpcConfig[] = [
            {
                url: mockServer1.url,
            },
            {
                url: mockServer2.url,
            },
        ];
        const state = new RpcState(rpcConfigs);
        const config: RainSolverTransportConfig = {
            key: "some-key",
            name: "some-name",
            retryCount: 0,
            retryDelay: 2_000,
            timeout: 60_000,
            pollingInterval: 0,
        };
        const transport = rainSolverTransport(state, config)({ chain: polygon });

        // should have correct config
        assert.equal(transport.config.key, "some-key");
        assert.equal(transport.config.name, "some-name");
        assert.equal(transport.config.retryCount, 0);
        assert.equal(transport.config.retryDelay, 2_000);
        assert.equal(transport.config.timeout, 60_000);
        assert.equal(transport.config.type, "RainSolverTransport");

        // call 1000 times with random responses
        await mockServer1.forPost().times(10).thenSendJsonRpcResult(1234);
        await mockServer2.forPost().times(10).thenSendJsonRpcResult(1234);
        for (let i = 1; i <= 1000; i++) {
            // randomly revert or resolve the call
            if (i > 10) {
                if (randomInt(1, 3) === 1) {
                    await mockServer1.forPost().once().thenSendJsonRpcResult(1234);
                    await mockServer2.forPost().once().thenSendJsonRpcResult(1234);
                } else {
                    await mockServer1.forPost().once().thenSendJsonRpcError({
                        code: -32000,
                        message: "ratelimit exceeded",
                    });
                    await mockServer2.forPost().once().thenSendJsonRpcError({
                        code: -32000,
                        message: "ratelimit exceeded",
                    });
                }
            }
            await transport.request({ method: "eth_blockNumber" }).catch(() => {});
        }

        // both rpcs should have been used equally close to each other with close success rate
        assert.closeTo(
            state.metrics[normalizeUrl(mockServer1.url)].progress.successRate,
            state.metrics[normalizeUrl(mockServer2.url)].progress.successRate,
            1000, // 10% delta
        );

        await mockServer1.stop();
        await mockServer2.stop();
    });

    it("should dedupe identical concurrent requests into a single wire request", async function () {
        const mockServer = getLocal();
        await mockServer.start(9494);

        const state = new RpcState([{ url: mockServer.url }]);
        // pin the rpc at 100% success rate so nextRpc always picks it on the
        // first try without ever yielding to the macrotask queue, otherwise a
        // caller could enter after the first response already settled and got
        // knocked out of viem's dedupe cache, firing a second wire request
        const dedupeRecord = state.metrics[normalizeUrl(mockServer.url)];
        dedupeRecord.progress.buffer = Array(100).fill(RpcBufferType.Success);
        dedupeRecord.progress.success = 100;
        const transport = rainSolverTransport(state, {
            retryCount: 0,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        const endpoint = await mockServer.forPost().thenSendJsonRpcResult(1234);

        // fire 5 identical requests concurrently
        const results = await Promise.all(
            Array.from({ length: 5 }, () => transport.request({ method: "eth_blockNumber" })),
        );

        // all callers get the result, but only one request hits the wire
        expect(results).toEqual([1234, 1234, 1234, 1234, 1234]);
        const seenRequests = await endpoint.getSeenRequests();
        expect(seenRequests.length).toBe(1);

        // metrics record all 5 logical requests
        const record = state.metrics[normalizeUrl(mockServer.url)];
        expect(record.req).toBe(5);
        expect(record.success).toBe(5);

        await mockServer.stop();
    });

    it("should retry the same rpc when it has a good success rate", async function () {
        const mockServer = getLocal();
        await mockServer.start(9595);

        const state = new RpcState([{ url: mockServer.url }]);
        // set a healthy success rate (90%) so same rpc retries kick in
        const record = state.metrics[normalizeUrl(mockServer.url)];
        record.progress.buffer = Array(100).fill(RpcBufferType.Success);
        record.progress.success = 90;

        // fail twice, then succeed
        await mockServer.forPost().times(2).thenSendJsonRpcError({
            code: -32000,
            message: "ratelimit exceeded",
        });
        const successEndpoint = await mockServer.forPost().thenSendJsonRpcResult(1234);

        const transport = rainSolverTransport(state, {
            retryCount: 2,
            retryCountNext: 1,
            retryDelay: 10,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        // succeeds via 2 same-rpc retries without consuming the next-rpc retry,
        // with the next-rpc path alone (retryCountNext 1) only 2 attempts would
        // be made and the request would have failed
        const result = await transport.request({ method: "eth_blockNumber" });
        expect(result).toBe(1234);
        expect((await successEndpoint.getSeenRequests()).length).toBe(1);

        await mockServer.stop();
    });

    it("should not retry the same rpc when it has a poor success rate", async function () {
        const mockServer = getLocal();
        await mockServer.start(9696);

        const state = new RpcState([{ url: mockServer.url }]);
        // set a poor success rate (10%) so same rpc retries are skipped
        const record = state.metrics[normalizeUrl(mockServer.url)];
        record.progress.buffer = Array(100).fill(RpcBufferType.Failure);
        record.progress.success = 10;

        // always fail
        await mockServer.forPost().thenSendJsonRpcError({
            code: -32000,
            message: "ratelimit exceeded",
        });

        const transport = rainSolverTransport(state, {
            retryCount: 2,
            retryCountNext: 1,
            retryDelay: 10,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        await expect(transport.request({ method: "eth_blockNumber" })).rejects.toThrow();

        // only the initial attempt: no same-rpc retries despite retryCount
        // being 2 (poor success rate), and the next-rpc rotation bails out
        // since it lands on the same rpc that just failed (only rpc there is)
        expect(state.metrics[normalizeUrl(mockServer.url)].req).toBe(1);

        await mockServer.stop();
    });

    it("should rotate to the next rpc when the picked one fails", async function () {
        const mockServer1 = getLocal();
        const mockServer2 = getLocal();
        await mockServer1.start(9797);
        await mockServer2.start(9898);

        const state = new RpcState([{ url: mockServer1.url }, { url: mockServer2.url }]);
        // both rpcs start at 50% success rate, so each occupies the first half of
        // its 10000 wide slot, pin the picks so rpc1 is picked first and rpc2 second
        const randomSpy = vi
            .spyOn(Math, "random")
            .mockReturnValueOnce(0) // pick 1 -> rpc1 slot
            .mockReturnValueOnce(0.55); // pick 11001 -> rpc2 slot

        await mockServer1.forPost().thenSendJsonRpcError({
            code: -32000,
            message: "ratelimit exceeded",
        });
        await mockServer2.forPost().thenSendJsonRpcResult(1234);

        const transport = rainSolverTransport(state, {
            retryCount: 0, // no same-rpc retries, isolate the rotation path
            retryCountNext: 1,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        const result = await transport.request({ method: "eth_blockNumber" });
        expect(result).toBe(1234);
        expect(state.metrics[normalizeUrl(mockServer1.url)].req).toBe(1);
        expect(state.metrics[normalizeUrl(mockServer2.url)].req).toBe(1);

        randomSpy.mockRestore();
        await mockServer1.stop();
        await mockServer2.stop();
    });

    it("should bail out of rotation when it lands on the rpc that just failed", async function () {
        const mockServer = getLocal();
        await mockServer.start(9999);

        const state = new RpcState([{ url: mockServer.url }]);
        // healthy rpc, so the same-rpc retry does kick in before rotation
        const record = state.metrics[normalizeUrl(mockServer.url)];
        record.progress.buffer = Array(100).fill(RpcBufferType.Success);
        record.progress.success = 100;

        // always fail
        await mockServer.forPost().thenSendJsonRpcError({
            code: -32000,
            message: "ratelimit exceeded",
        });

        const transport = rainSolverTransport(state, {
            retryCount: 1,
            retryCountNext: 1,
            retryDelay: 10,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        await expect(transport.request({ method: "eth_blockNumber" })).rejects.toThrow();

        // initial attempt plus one same-rpc retry, then the rotation lands on
        // the same rpc (only rpc there is) and bails out with the error
        expect(record.req).toBe(2);

        await mockServer.stop();
    });

    it("should not retry at all when the error is a node level error", async function () {
        const mockServer = getLocal();
        await mockServer.start(10101);

        const state = new RpcState([{ url: mockServer.url }]);
        // healthy rpc, retries would kick in if the error classification allowed
        const record = state.metrics[normalizeUrl(mockServer.url)];
        record.progress.buffer = Array(100).fill(RpcBufferType.Success);
        record.progress.success = 100;

        // node level error, the rpc itself responded fine
        await mockServer.forPost().thenSendJsonRpcError({
            code: 3,
            message: "execution reverted",
        });

        const transport = rainSolverTransport(state, {
            retryCount: 2,
            retryCountNext: 1,
            retryDelay: 10,
            timeout: 60_000,
            pollingInterval: 0,
        })({ chain: polygon });

        await expect(transport.request({ method: "eth_call" })).rejects.toThrow();

        // single attempt, no same-rpc retries and no rotation since node level
        // errors are deterministic, and it counts as a success for the metrics
        expect(record.req).toBe(1);
        expect(record.success).toBe(1);
        expect(record.failure).toBe(0);

        await mockServer.stop();
    });

    it("test RainSolver transport unhappy", async function () {
        // setup 2 rpc mock servers
        const mockServer1 = getLocal();
        const mockServer2 = getLocal();
        await mockServer1.start(6767);
        await mockServer2.start(6969);

        const rpcConfigs: RpcConfig[] = [
            {
                url: mockServer1.url,
            },
            {
                url: mockServer2.url,
            },
        ];
        const state = new RpcState(rpcConfigs);
        for (const url in state.metrics) {
            state.metrics[url].progress.buffer = Array(100).fill(RpcBufferType.Failure);
        }
        const config: RainSolverTransportConfig = {
            retryCount: 0,
            pollingInterval: 50,
            pollingTimeout: 0,
        };
        const transport = rainSolverTransport(state, config)({ chain: polygon });

        // timeout responses
        await mockServer1.forPost().withBodyIncluding("eth_blockNumber").thenTimeout();
        await mockServer2.forPost().withBodyIncluding("eth_blockNumber").thenTimeout();

        // should timeout
        await expect(transport.request({ method: "eth_blockNumber" })).rejects.toThrow(
            new RainSolverTransportTimeoutError(0),
        );

        await mockServer1.stop();
        await mockServer2.stop();
    });
});
