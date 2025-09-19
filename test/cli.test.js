require("dotenv").config();
const { assert } = require("chai");
const { sleep } = require("../src/utils");
const mockServer = require("mockttp").getLocal();
const { writeFileSync, unlinkSync } = require("fs");
const { startup, arbRound } = require("../src/cli");
const { trace, context } = require("@opentelemetry/api");
const { Resource } = require("@opentelemetry/resources");
const { BasicTracerProvider } = require("@opentelemetry/sdk-trace-base");
const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

describe("Test cli", async function () {
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockServer.stop());

    it("return correct result for empty orders array", async function () {
        const provider = new BasicTracerProvider({
            resource: new Resource({
                [SEMRESATTRS_SERVICE_NAME]: "rain-solver-test",
            }),
        });
        const tracer = provider.getTracer("rain-solver-tracer");
        const testSpan = tracer.startSpan("test");
        const ctx = trace.setSpan(context.active(), testSpan);

        // Mock sg status and orders query
        await mockServer
            .forPost("/sg-url")
            .withBodyIncluding("_meta")
            .thenReply(200, JSON.stringify({ data: { _meta: { hasIndexingErrors: false } } }));
        await mockServer
            .forPost("/sg-url")
            .withBodyIncluding("orders")
            .thenReply(200, JSON.stringify({ data: { orders: [] } }));

        // mock provider chain id call
        await mockServer
            .forPost("/rpc-url")
            .withBodyIncluding("eth_chainId")
            .thenReply(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "137" }));

        const options = {
            rpc: ["http://localhost:8080/rpc-url"],
            key: "0x" + "1".repeat(64),
            arbAddress: "0x" + "0".repeat(40),
            maxRatio: true,
            subgraph: ["http://localhost:8080/sg-url"],
        };

        const response = await arbRound(tracer, ctx, options, { mainAccount: {} });
        const expected = { txs: [], foundOpp: false, didClear: false, avgGasCost: undefined };
        assert.deepEqual(response, expected);

        testSpan.end();
    });

    it("test cli startup", async function () {
        process.env.CLI_STARTUP_TEST = true;
        const deployer = "0xE7116BC05C8afe25e5B54b813A74F916B5D42aB1";

        try {
            await startup(["", ""]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "no such file or directory, open './config.yaml'";
            assert.include(error.message, expected);
        }

        try {
            await startup(["", "", "-c", "./some-other-path.yaml"]);
            assert.fail("expected to fail, but resolved");
        } catch (error) {
            const expected = "no such file or directory, open './some-other-path.yaml'";
            assert.include(error.message, expected);
        }

        const yaml = `
key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
rpc:
    - url: https://polygon.drpc.org
writeRpc:
    - url: http://write-rpc.example.com
subgraph: ["${mockServer.url}/sg"]
arbAddress: "0x${"1".repeat(40)}"
dispair: "${deployer}"
liquidityProviders: 
    - lp1
    - lp2
txGas: 123456789
quoteGas: 7777
botMinBalance: 0.123
gasPriceMultiplier: 120
gasLimitMultiplier: 110
timeout: 20000
hops: 2
retries: 3
maxRatio: true
rpOnly: true
publicRpc: true
sgFilter:
    includeOrders:
        - "0x${"1".repeat(64)}"
        - "0x${"2".repeat(64)}"
    excludeOrders:
        - "0x${"3".repeat(64)}"
        - "0x${"4".repeat(64)}"
    includeOwners:
        - "0x${"1".repeat(40)}"
        - "0x${"2".repeat(40)}"
    excludeOwners:
        - "0x${"3".repeat(40)}"
        - "0x${"4".repeat(40)}"
    includeOrderbooks:
        - "0x${"5".repeat(40)}"
        - "0x${"6".repeat(40)}"
    excludeOrderbooks:
        - "0x${"7".repeat(40)}"
        - "0x${"8".repeat(40)}"
`;

        const path = "./test/second.test.yaml";
        writeFileSync(path, yaml, "utf8");

        await mockServer
            .forPost("/sg")
            .withBodyIncluding("_meta")
            .thenReply(200, JSON.stringify({ data: { _meta: { hasIndexingErrors: false } } }));
        await mockServer
            .forPost("/sg")
            .withBodyIncluding("orders")
            .thenReply(200, JSON.stringify({ data: { orders: [] } }));

        const result = await startup(["", "", "--config", path]);
        const expected = {
            roundGap: 10000,
            poolUpdateInterval: 0,
            config: {
                chain: { id: 137 },
                rpc: [{ url: "https://polygon.drpc.org" }],
                arbAddress: `0x${"1".repeat(40)}`,
                route: "single",
                rpcState: {
                    metrics: {
                        "https://polygon.drpc.org/": {
                            req: 5,
                            success: 5,
                            failure: 0,
                            cache: {},
                        },
                    },
                },
                gasPriceMultiplier: 120,
                gasLimitMultiplier: 110,
                txGas: "123456789",
                quoteGas: 7777n,
                rpOnly: true,
                dispair: {
                    interpreter: "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8D",
                    store: "0xFA4989F5D49197FD9673cE4B7Fe2A045A0F2f9c8",
                    deployer: deployer.toLowerCase(),
                },
            },
            options: {
                botMinBalance: "0.123",
                gasPriceMultiplier: 120,
                gasLimitMultiplier: 110,
                txGas: "123456789",
                quoteGas: 7777n,
                rpOnly: true,
                dispair: deployer.toLowerCase(),
                sgFilter: {
                    includeOrders: new Set([`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`]),
                    excludeOrders: new Set([`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`]),
                    includeOwners: new Set([`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`]),
                    excludeOwners: new Set([`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`]),
                    includeOrderbooks: new Set([`0x${"5".repeat(40)}`, `0x${"6".repeat(40)}`]),
                    excludeOrderbooks: new Set([`0x${"7".repeat(40)}`, `0x${"8".repeat(40)}`]),
                },
            },
        };

        // rm test yaml file
        unlinkSync(path);

        await sleep(1000);
        assert.equal(result.roundGap, expected.roundGap);
        assert.equal(result.poolUpdateInterval, expected.poolUpdateInterval);
        assert.equal(result.config.chain.id, expected.config.chain.id);
        assert.deepEqual(result.config.rpc[0], expected.config.rpc[0]);
        assert.equal(result.config.arbAddress, expected.config.arbAddress);
        assert.equal(result.config.route, expected.config.route);
        assert.equal(result.options.botMinBalance, expected.options.botMinBalance);
        assert.equal(result.options.gasPriceMultiplier, expected.options.gasPriceMultiplier);
        assert.equal(result.config.gasPriceMultiplier, expected.config.gasPriceMultiplier);
        assert.equal(result.options.gasLimitMultiplier, expected.options.gasLimitMultiplier);
        assert.equal(result.config.gasLimitMultiplier, expected.config.gasLimitMultiplier);
        assert.equal(result.options.txGas, expected.options.txGas);
        assert.equal(result.config.txGas, expected.config.txGas);
        assert.equal(result.options.quoteGas, expected.options.quoteGas);
        assert.equal(result.config.quoteGas, expected.config.quoteGas);
        assert.equal(result.options.rpOnly, expected.options.rpOnly);
        assert.equal(result.config.rpOnly, expected.config.rpOnly);
        assert.deepEqual(result.options.dispair, expected.options.dispair);
        assert.deepEqual(result.config.dispair, expected.config.dispair);
        for (const url in result.state.rpc.metrics) {
            assert.ok(result.state.rpc.metrics[url].req >= 0);
            assert.ok(result.state.rpc.metrics[url].success >= 0);
            assert.ok(result.state.rpc.metrics[url].failure < 4);
            assert.deepEqual(result.state.rpc.metrics[url].cache, {});
            assert.notEqual(result.state.rpc.metrics[url].lastRequestTimestamp, 0);
            assert.isNotEmpty(result.state.rpc.metrics[url].requestIntervals);
        }
        assert.deepEqual(result.options.sgFilter, expected.options.sgFilter);
    });
});
