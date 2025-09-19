const { assert } = require("chai");
const { getConfig } = require("../src");
const { RpcState } = require("../src/rpc");
const { getChainConfig } = require("../src/state/chain");
const { createPublicClient, http, fallback } = require("viem");
const { publicClientConfig } = require("sushi/config");

describe("Test app options", async function () {
    it("should use defaults", async function () {
        const rpcs = [{ url: "https://polygon.drpc.org" }, { url: "https://polygon-rpc.com" }];
        const config = await getConfig(
            {
                rpc: rpcs,
                walletcount: 1,
                topupAmount: "1",
                arbAddress: "0x" + "1".repeat(64), // wallet key
                genericArbAddress: "0x" + "3".repeat(40), // arb address
                liquidityProviders: ["SUShIswapV2", "bIsWaP"],
                dispair: "0xE7116BC05C8afe25e5B54b813A74F916B5D42aB1",
                hops: 1,
                retries: 1,
                gasCoveragePercentage: "100",
                maxRatio: false,
            },
            {
                rpc: new RpcState(rpcs),
                chainConfig: getChainConfig(137),
                walletKey: "test test test test test test test test test test test junk",
                client: createPublicClient({
                    chain: publicClientConfig[137]?.chain,
                    transport: fallback(rpcs.map((v) => http(v.url))),
                }),
                watchedTokens: new Map(),
            },
        );

        assert.equal(config.flashbotRpc, undefined);
        assert.equal(config.maxRatio, false);
        assert.equal(config.hops, 1);
        assert.equal(config.retries, 1);
        assert.equal(config.chain.id, 137);
        assert.equal(config.gasCoveragePercentage, "100");
        assert.deepEqual(config.rpc, rpcs);
    });
});
