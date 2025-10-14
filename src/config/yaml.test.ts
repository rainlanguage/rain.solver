import { AppOptions } from "./yaml";
import { describe, it, assert } from "vitest";
import { writeFileSync, unlinkSync } from "fs";

describe("Test yaml AppOptions", async function () {
    it("test AppOptions fromYaml", async function () {
        // Set up environment variables for fields that should come from env
        process.env.MY_MNEMONIC = "test mnemonic key";
        process.env.MY_RPC = "url=http://rpc1.example.com,url=http://rpc2.example.com";
        process.env.OWNER_PROFILE =
            "0x4444444444444444444444444444444444444444=100,0x5555555555555555555555555555555555555555=max";

        const yaml = `
mnemonic: "$MY_MNEMONIC"
rpc: "$MY_RPC"
walletCount: 10
topupAmount: 0.5
writeRpc:
    - url: http://write-rpc.example.com
subgraph: ["http://subgraph.example.com"]
contracts:
  v4:
    sushiArbAddress: "0x1111111111111111111111111111111111111111"
    balancerArbAddress: "0x3333333333333333333333333333333333333333"
    dispair: "0x2222222222222222222222222222222222222222"
liquidityProviders: 
 - lp1
 - lp2
route: multi
sleep: 20
poolUpdateInterval: 30
gasCoveragePercentage: 110
txGas: 15000
quoteGas: 2000000
botMinBalance: 50.5
gasPriceMultiplier: 150
gasLimitMultiplier: 90
timeout: 20000
maxRatio: true
ownerProfile: $OWNER_PROFILE
selfFundVaults:
  - token: "0x6666666666666666666666666666666666666666"
    vaultId: "1"
    threshold: "0.5"
    topupAmount: "2.5"
    orderbook: "0x1234567890123456789012345678901234567890"
  - token: "0x7777777777777777777777777777777777777777"
    vaultId: "2"
    threshold: "1.0"
    topupAmount: "3.5"
    orderbook: "0x1234567890123456789012345678901234567890"
sgFilter:
  includeOrders:
    - "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    - "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  includeOwners:
    - "0x9999999999999999999999999999999999999999"
orderbookTradeTypes:
  router:
    - "0x1111111111111111111111111111111111111111"
    - "0x2222222222222222222222222222222222222222"
    - "0x1111111111111111111111111111111111111111"
  interOrderbook:
    - "0x3333333333333333333333333333333333333333"
    - "0x4444444444444444444444444444444444444444"
    - "0x3333333333333333333333333333333333333333"
  intraOrderbook:
    - "0x5555555555555555555555555555555555555555"
    - "0x6666666666666666666666666666666666666666"
    - "0x6666666666666666666666666666666666666666"
  `;

        const path = "./first.test.yaml";
        writeFileSync(path, yaml, "utf8");

        const res = AppOptions.tryFromYamlPath(path);
        assert(res.isOk());
        const result = res.value;
        const expected: AppOptions = {
            key: undefined,
            rpc: [{ url: "http://rpc1.example.com" }, { url: "http://rpc2.example.com" }],
            mnemonic: process.env.MY_MNEMONIC,
            walletCount: 10,
            topupAmount: "0.5",
            writeRpc: [{ url: "http://write-rpc.example.com" }],
            subgraph: ["http://subgraph.example.com"],
            contracts: {
                v4: {
                    sushiArb: "0x1111111111111111111111111111111111111111",
                    balancerArb: "0x3333333333333333333333333333333333333333",
                    dispair: "0x2222222222222222222222222222222222222222",
                    genericArb: undefined,
                },
            },
            liquidityProviders: ["lp1", "lp2"],
            route: "multi",
            sleep: 20 * 1000,
            poolUpdateInterval: 30,
            gasCoveragePercentage: "110",
            txGas: "15000",
            quoteGas: BigInt(2000000),
            botMinBalance: "50.5",
            gasPriceMultiplier: 150,
            gasLimitMultiplier: 90,
            timeout: 20000,
            maxRatio: true,
            ownerProfile: {
                "0x4444444444444444444444444444444444444444": 100,
                "0x5555555555555555555555555555555555555555": Number.MAX_SAFE_INTEGER,
            },
            selfFundVaults: [
                {
                    token: "0x6666666666666666666666666666666666666666",
                    vaultId: "1",
                    threshold: "0.5",
                    topupAmount: "2.5",
                    orderbook: "0x1234567890123456789012345678901234567890",
                },
                {
                    token: "0x7777777777777777777777777777777777777777",
                    vaultId: "2",
                    threshold: "1.0",
                    topupAmount: "3.5",
                    orderbook: "0x1234567890123456789012345678901234567890",
                },
            ],
            sgFilter: {
                includeOrders: new Set([
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ]),
                excludeOrders: undefined,
                includeOwners: new Set(["0x9999999999999999999999999999999999999999"]),
                excludeOwners: undefined,
                includeOrderbooks: undefined,
                excludeOrderbooks: undefined,
            },
            orderbookTradeTypes: {
                router: new Set([`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`]),
                interOrderbook: new Set([`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`]),
                intraOrderbook: new Set([`0x${"5".repeat(40)}`, `0x${"6".repeat(40)}`]),
            },
        };

        // AppOptions returned from fromYaml() should match expected
        assert.deepEqual(result, expected);

        // cleanup the temporary file
        unlinkSync(path);
    });

    it("test AppOptions tryFrom", async function () {
        // Set up environment variables for fields that should come from env
        process.env.MY_KEY = "0x" + "a".repeat(64);
        process.env.MY_RPC = "url=http://rpc1.example.com,url=http://rpc2.example.com";

        const input = {
            key: "$MY_KEY",
            rpc: "$MY_RPC",
            writeRpc: [{ url: "http://write-rpc.example.com" }],
            subgraph: ["http://subgraph.example.com"],
            contracts: {
                v5: {
                    sushiArbAddress: "0x1111111111111111111111111111111111111111",
                    dispair: "0x2222222222222222222222222222222222222222",
                    genericArbAddress: "0x3333333333333333333333333333333333333333",
                },
            },
            liquidityProviders: ["lp1", "lp2"],
            route: "multi",
            sleep: "20",
            poolUpdateInterval: "30",
            gasCoveragePercentage: "110",
            txGas: "15000",
            quoteGas: "2000000",
            botMinBalance: "50.5",
            gasPriceMultiplier: "150",
            gasLimitMultiplier: "90",
            timeout: "20000",
            maxRatio: true,
            ownerProfile: [
                { "0x4444444444444444444444444444444444444444": "100" },
                { "0x5555555555555555555555555555555555555555": "max" },
            ],
            selfFundVaults: [
                {
                    token: "0x6666666666666666666666666666666666666666",
                    vaultId: "1",
                    threshold: "0.5",
                    topupAmount: "2.5",
                    orderbook: "0x1234567890123456789012345678901234567890",
                },
                {
                    token: "0x7777777777777777777777777777777777777777",
                    vaultId: "2",
                    threshold: "1.0",
                    topupAmount: "3.5",
                    orderbook: "0x1234567890123456789012345678901234567890",
                },
            ],
            sgFilter: {
                includeOrders: [
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ],
                includeOwners: ["0x9999999999999999999999999999999999999999"],
            },
            orderbookTradeTypes: {
                router: [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, `0x${"1".repeat(40)}`], // duplicate to test set
                interOrderbook: [
                    `0x${"3".repeat(40)}`,
                    `0x${"4".repeat(40)}`,
                    `0x${"3".repeat(40)}`, // duplicate to test set
                ],
                intraOrderbook: [
                    `0x${"5".repeat(40)}`,
                    `0x${"6".repeat(40)}`,
                    `0x${"6".repeat(40)}`, // duplicate to test set
                ],
            },
        };
        const res = AppOptions.tryFrom(input);
        assert(res.isOk());
        const result = res.value;

        // Assertions for the env-provided fields:
        assert.deepEqual(result.key, process.env.MY_KEY);
        assert.deepEqual(result.rpc, [
            { url: "http://rpc1.example.com" },
            { url: "http://rpc2.example.com" },
        ]);

        // Assertions for directly specified fields:
        assert.deepEqual(result.writeRpc, [{ url: "http://write-rpc.example.com" }]);
        assert.deepEqual(result.subgraph, ["http://subgraph.example.com"]);
        assert.deepEqual(
            result.contracts.v5?.sushiArb,
            "0x1111111111111111111111111111111111111111".toLowerCase(),
        );
        assert.deepEqual(
            result.contracts.v5?.dispair,
            "0x2222222222222222222222222222222222222222".toLowerCase(),
        );
        assert.deepEqual(
            result.contracts.v5?.genericArb,
            "0x3333333333333333333333333333333333333333".toLowerCase(),
        );
        assert.deepEqual(result.liquidityProviders, ["lp1", "lp2"]);
        assert.deepEqual(result.route, "multi");

        // sleep is multiplied by 1000 in init()
        assert.deepEqual(result.sleep, 20 * 1000);
        assert.deepEqual(result.poolUpdateInterval, 30);
        // gasCoveragePercentage was resolved with returnAsString
        assert.deepEqual(result.gasCoveragePercentage, "110");
        // txGas is returned as a string ("15000")
        assert.deepEqual(result.txGas, "15000");
        // quoteGas is converted to bigint
        assert.deepEqual(result.quoteGas, BigInt(2000000));
        // botMinBalance is resolved as string ("50.5")
        assert.deepEqual(result.botMinBalance, "50.5");
        assert.deepEqual(result.gasPriceMultiplier, 150);
        assert.deepEqual(result.gasLimitMultiplier, 90);
        assert.deepEqual(result.timeout, 20000);
        assert.equal(result.maxRatio, true);

        // ownerProfile
        const expectedOwnerProfile = {
            "0x4444444444444444444444444444444444444444": 100,
            "0x5555555555555555555555555555555555555555": Number.MAX_SAFE_INTEGER,
        };
        assert.deepEqual(result.ownerProfile, expectedOwnerProfile);

        // selfFundVaults
        const expectedselfFundVaults = [
            {
                token: "0x6666666666666666666666666666666666666666".toLowerCase(),
                vaultId: "1",
                threshold: "0.5",
                topupAmount: "2.5",
                orderbook: "0x1234567890123456789012345678901234567890",
            },
            {
                token: "0x7777777777777777777777777777777777777777".toLowerCase(),
                vaultId: "2",
                threshold: "1.0",
                topupAmount: "3.5",
                orderbook: "0x1234567890123456789012345678901234567890",
            },
        ];
        assert.deepEqual(result.selfFundVaults, expectedselfFundVaults);

        // sgFilter
        const expectedSgFilter = {
            includeOrders: new Set([
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ]),
            excludeOrders: undefined,
            includeOwners: new Set(["0x9999999999999999999999999999999999999999"]),
            excludeOwners: undefined,
            includeOrderbooks: undefined,
            excludeOrderbooks: undefined,
        };
        assert.deepEqual(result.sgFilter!.includeOrders, expectedSgFilter.includeOrders);
        assert.deepEqual(result.sgFilter!.includeOwners, expectedSgFilter.includeOwners);

        // orderbookTradeTypes
        assert.deepEqual(result.orderbookTradeTypes, {
            router: new Set<string>([`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`]),
            interOrderbook: new Set<string>([`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`]),
            intraOrderbook: new Set<string>([`0x${"5".repeat(40)}`, `0x${"6".repeat(40)}`]),
        });
    });
});
