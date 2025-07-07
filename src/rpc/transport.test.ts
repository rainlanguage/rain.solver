import { randomInt } from "crypto";
import { getLocal } from "mockttp";
import { polygon } from "viem/chains";
import { describe, it, assert } from "vitest";
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
        try {
            await transport.request({ method: "eth_blockNumber" });
            throw "expected to fail, but fulfilled";
        } catch (error) {
            if (error === "expected to fail, but fulfilled") throw error;
            assert.deepEqual(error, new RainSolverTransportTimeoutError(0));
        }

        await mockServer1.stop();
        await mockServer2.stop();
    });
});
