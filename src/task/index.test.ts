import { getLocal } from "mockttp";
import { randomBytes } from "crypto";
import { describe, it, assert } from "vitest";
import { getBountyEnsureRainlang, getWithdrawEnsureRainlang, parseRainlang } from ".";
import { createPublicClient, encodeAbiParameters, formatUnits, http, toHex } from "viem";

describe("Test task", async function () {
    const mockServer = getLocal();
    beforeEach(() => mockServer.start(8095));
    afterEach(() => mockServer.stop());

    it("should get ensure bounty rainlang", async function () {
        const inputToEthPrice = 10n;
        const outputToEthPrice = 20n;
        const minimumExpected = 15n;
        const sender = toHex(randomBytes(20));

        const result = await getBountyEnsureRainlang(
            inputToEthPrice,
            outputToEthPrice,
            minimumExpected,
            sender,
        );
        const expected = `/* 0. main */ 
:ensure(equal-to(${sender} context<0 0>()) "unknown sender"),
total-bounty-eth: add(
    mul(${formatUnits(inputToEthPrice, 18)} context<1 0>())
    mul(${formatUnits(outputToEthPrice, 18)} context<1 1>())
),
:ensure(
    greater-than(
        total-bounty-eth
        ${formatUnits(minimumExpected, 18)}
    )
    "minimum sender output"
);`;
        assert.equal(result, expected);
    });

    it("should get withdraw ensure bounty rainlang", async function () {
        const inputToEthPrice = 10n;
        const outputToEthPrice = 20n;
        const minimumExpected = 15n;
        const sender = toHex(randomBytes(20));
        const botAddress = toHex(randomBytes(20));
        const inputToken = toHex(randomBytes(20));
        const outputToken = toHex(randomBytes(20));
        const orgInputBalance = 45n;
        const orgOutputBalance = 55n;

        const result = await getWithdrawEnsureRainlang(
            botAddress,
            inputToken,
            outputToken,
            orgInputBalance,
            orgOutputBalance,
            inputToEthPrice,
            outputToEthPrice,
            minimumExpected,
            sender,
        );
        const expected = `/* 0. main */ 
:ensure(equal-to(${sender} context<0 0>()) "unknown sender"),
input-bounty: sub(
    erc20-balance-of(${inputToken} ${botAddress})
    ${formatUnits(orgInputBalance, 18)}
),
output-bounty: sub(
    erc20-balance-of(${outputToken} ${botAddress})
    ${formatUnits(orgOutputBalance, 18)}
),
total-bounty-eth: add(
    mul(input-bounty ${formatUnits(inputToEthPrice, 18)})
    mul(output-bounty ${formatUnits(outputToEthPrice, 18)})
),
:ensure(
    greater-than(
        total-bounty-eth
        ${formatUnits(minimumExpected, 18)}
    )
    "minimum sender output"
);`;
        assert.equal(result, expected);
    });

    it("should parse rainlang to bytecode", async function () {
        const viemClient = createPublicClient({
            transport: http(mockServer.url + "/rpc"),
        });
        const rainlang = "some-rainlang";
        const dispair = {
            interpreter: toHex(randomBytes(20)),
            store: toHex(randomBytes(20)),
            deployer: toHex(randomBytes(20)),
        };

        const expected = toHex(randomBytes(32)) as `0x${string}`;
        const callResult = encodeAbiParameters([{ type: "bytes" }], [expected]);

        // mock call
        await mockServer
            .forPost("/rpc")
            .withBodyIncluding("0xa3869e14") // parse2() selector
            .thenSendJsonRpcResult(callResult);
        const result = await parseRainlang(rainlang, viemClient, dispair);

        assert.equal(result, expected);
    });
});
