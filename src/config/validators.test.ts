import { Validator } from "./validators";
import { describe, it, assert } from "vitest";
import { readValue, tryIntoArray, validateHash, validateAddress } from "./validators";

describe("Test yaml Validator methods", async function () {
    it("test Validator resolveKey", async function () {
        const validKey = "0x" + "1".repeat(64);
        const validMnemonic = "test mnemonic phrase";

        // happy path: using key only
        let input: any = { key: validKey };
        let result = Validator.resolveWalletKey(input);
        assert.deepEqual(result, {
            key: validKey,
            mnemonic: undefined,
            walletCount: undefined,
            topupAmount: undefined,
        });

        // happy path: using mnemonic with walletCount and topupAmount
        input = { mnemonic: validMnemonic, walletCount: "3", topupAmount: "0.5" };
        result = Validator.resolveWalletKey(input);
        assert.deepEqual(result, {
            key: undefined,
            mnemonic: validMnemonic,
            walletCount: 3,
            topupAmount: "0.5",
        });

        // unhappy: neither key nor mnemonic provided
        input = {};
        assert.throws(
            () => Validator.resolveWalletKey(input),
            "only one of key or mnemonic should be specified",
        );

        // unhappy: both key and mnemonic provided
        input = { key: validKey, mnemonic: validMnemonic, walletCount: "3", topupAmount: "0.5" };
        assert.throws(
            () => Validator.resolveWalletKey(input),
            "only one of key or mnemonic should be specified",
        );

        // unhappy: mnemonic provided but missing walletCount or topupAmount
        input = { mnemonic: validMnemonic, walletCount: "3" };
        assert.throws(
            () => Validator.resolveWalletKey(input),
            "walletCount and topupAmount are required when using mnemonic key",
        );

        // unhappy: invalid walletCount
        input = { mnemonic: validMnemonic, walletCount: "invalid", topupAmount: "0.5" };
        assert.throws(
            () => Validator.resolveWalletKey(input),
            "invalid walletCount, it should be an integer greater than equal to 0",
        );

        // unhappy: invalid topupAmount
        input = { mnemonic: validMnemonic, walletCount: "3", topupAmount: "invalid" };
        assert.throws(
            () => Validator.resolveWalletKey(input),
            "invalid topupAmount, it should be a number greater than equal to 0",
        );

        // unhappy: key provided but invalid wallet private key
        const invalidKey = "invalidKey";
        input = { key: invalidKey };
        assert.throws(() => Validator.resolveWalletKey(input), "invalid wallet private key");
    });

    it("test Validator resolveUrls", async function () {
        // happy
        let input: any = ["url1", "url2", "url3"];
        let result: any = Validator.resolveUrls(input, "unexpected error");
        assert.deepEqual(result, ["url1", "url2", "url3"]);

        // happy optional
        input = undefined;
        result = Validator.resolveUrls(input, "unexpected error", true);
        assert.deepEqual(result, undefined);

        // happy from env
        process.env.INPUT = "url1,url2,url3";
        input = "$INPUT";
        result = Validator.resolveUrls(input, "unexpected error");
        assert.deepEqual(result, ["url1", "url2", "url3"]);

        // happy from env optional
        input = "$EMPTY_INPUT";
        result = Validator.resolveUrls(input, "unexpected error", true);
        assert.deepEqual(result, undefined);

        // unhappy
        input = [];
        assert.throws(() => Validator.resolveUrls(input, "unexpected error"), "unexpected error");

        // unhappy from env
        process.env.INPUT = "";
        input = "$INPUT";
        assert.throws(() => Validator.resolveUrls(input, "unexpected error"), "unexpected error");
    });

    it("test Validator resolveLiquidityProviders", async function () {
        // happy
        let input: any = ["lp1", "lp2", "lp3"];
        let result = Validator.resolveLiquidityProviders(input);
        assert.deepEqual(result, ["lp1", "lp2", "lp3"]);

        // happy from env
        process.env.INPUT = "lp1,lp2,lp3";
        input = "$INPUT";
        result = Validator.resolveLiquidityProviders(input);
        assert.deepEqual(result, ["lp1", "lp2", "lp3"]);

        // unhappy
        input = [1, 2, 3];
        assert.throws(
            () => Validator.resolveLiquidityProviders(input),
            "expected array of liquidity providers",
        );
    });

    it("test Validator resolveBool", async function () {
        // happy
        let input: any = true;
        let result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, true);

        input = false;
        result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, false);

        // happy from env
        process.env.INPUT = "true";
        input = "$INPUT";
        result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, true);

        process.env.INPUT = "false";
        input = "$INPUT";
        result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, false);

        // unhappy
        input = undefined;
        result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, false);

        // unhappy from env
        process.env.INPUT = "";
        input = "$INPUT";
        result = Validator.resolveBool(input, "unexpected error");
        assert.equal(result, false);
    });

    it("test Validator resolveAddress", async function () {
        const address = `0x${"1".repeat(40)}`;
        // happy
        let input: any = address;
        let result: any = Validator.resolveAddress(input, "SomeContractName");
        assert.deepEqual(result, address);

        // happy undefined
        input = undefined;
        result = Validator.resolveAddress(input, "SomeContractName", true);
        assert.deepEqual(result, undefined);

        // happy from env
        process.env.INPUT = address;
        input = "$INPUT";
        result = Validator.resolveAddress(input, "SomeContractName");
        assert.deepEqual(result, address);

        // happy from env undefined
        delete process.env.INPUT;
        input = "$INPUT";
        result = Validator.resolveAddress(input, "SomeContractName", true);
        assert.deepEqual(result, undefined);

        // unhappy
        input = "0x1234";
        assert.throws(
            () => Validator.resolveAddress(input, "SomeContractName"),
            "expected valid SomeContractName contract address",
        );

        // unhappy from env
        process.env.INPUT = "0x1234";
        input = "$INPUT";
        assert.throws(
            () => Validator.resolveAddress(input, "SomeContractName"),
            "expected valid SomeContractName contract address",
        );
    });

    it("test Validator resolveNumericValue", async function () {
        // happy case: valid integer string, returns number by default
        const intVal = Validator.resolveNumericValue("123", /^[0-9]+$/, "invalid int");
        assert.strictEqual(intVal, 123);

        // happy case: valid integer string with returnAsString true
        const intStrVal = Validator.resolveNumericValue(
            "456",
            /^[0-9]+$/,
            "invalid int",
            undefined,
            true,
        );
        assert.strictEqual(intStrVal, "456");

        // case with fallback: input is undefined, fallback provided, returns number
        const fallbackVal = Validator.resolveNumericValue(
            undefined,
            /^[0-9]+$/,
            "invalid int",
            "789",
        );
        assert.strictEqual(fallbackVal, 789);

        // case with fallback: input is undefined, fallback provided, return as string
        const fallbackStrVal = Validator.resolveNumericValue(
            undefined,
            /^[0-9]+$/,
            "invalid int",
            "321",
            true,
        );
        assert.strictEqual(fallbackStrVal, "321");

        // case with neither input nor fallback: returns undefined
        const undefinedVal = Validator.resolveNumericValue(undefined, /^[0-9]+$/, "invalid int");
        assert.strictEqual(undefinedVal, undefined);

        // callback test: capture converted number when returnAsString is false
        let callbackValue: any = null;
        const valWithCallback = Validator.resolveNumericValue(
            "999",
            /^[0-9]+$/,
            "invalid int",
            undefined,
            false,
            (value) => {
                callbackValue = value;
            },
        );
        assert.strictEqual(valWithCallback, 999);
        assert.strictEqual(callbackValue, 999);

        // callback test: capture string value when returnAsString is true
        callbackValue = null;
        const valStringWithCallback = Validator.resolveNumericValue(
            "888",
            /^[0-9]+$/,
            "invalid int",
            undefined,
            true,
            (value) => {
                callbackValue = value;
            },
        );
        assert.strictEqual(valStringWithCallback, "888");
        assert.strictEqual(callbackValue, "888");

        // negative test: if input value is not a string
        assert.throws(
            () => Validator.resolveNumericValue(123, /^[0-9]+$/, "invalid int"),
            "invalid int",
        );

        // negative test: if input string does not match the pattern
        assert.throws(
            () => Validator.resolveNumericValue("abc", /^[0-9]+$/, "invalid int"),
            "invalid int",
        );
    });

    it("test Validator resolveRouteType", async function () {
        // happy
        let input: any = "full";
        let result = Validator.resolveRouteType(input);
        assert.deepEqual(result, undefined);

        input = "single";
        result = Validator.resolveRouteType(input);
        assert.deepEqual(result, "single");

        input = "multi";
        result = Validator.resolveRouteType(input);
        assert.deepEqual(result, "multi");

        // happy from env
        process.env.INPUT = "full";
        input = "$INPUT";
        result = Validator.resolveRouteType(input);
        assert.deepEqual(result, undefined);

        process.env.INPUT = "single";
        input = "$INPUT";
        result = Validator.resolveRouteType(input);
        assert.deepEqual(result, "single");

        process.env.INPUT = "multi";
        input = "$INPUT";
        result = Validator.resolveRouteType(input);
        assert.deepEqual(result, "multi");

        // unhappy
        input = "bad";
        assert.throws(
            () => Validator.resolveRouteType(input),
            "expected either of full, single or multi",
        );

        // unhappy from env
        process.env.INPUT = "0x1234";
        input = "$INPUT";
        assert.throws(
            () => Validator.resolveRouteType(input),
            "expected either of full, single or multi",
        );
    });
    it("test Validator resolveOwnerProfile", async function () {
        const address1 = `0x${"1".repeat(40)}`;
        const address2 = `0x${"2".repeat(40)}`;
        const address3 = `0x${"3".repeat(40)}`;
        const address4 = `0x${"4".repeat(40)}`;
        // happy path using direct object input:
        const inputObj = [{ [address1]: "100" }, { [address2]: "max" }];
        const resultObj = Validator.resolveOwnerProfile(inputObj);
        const expectedObj = {
            [address1]: 100,
            [address2]: Number.MAX_SAFE_INTEGER,
        };
        assert.deepEqual(resultObj, expectedObj);

        // happy path using env variable:
        process.env.OWNER_PROFILE = `${address3}=200,${address4}=max`;
        const envInput = "$OWNER_PROFILE";
        const resultEnv = Validator.resolveOwnerProfile(envInput);
        const expectedEnv = {
            [address3]: 200,
            [address4]: Number.MAX_SAFE_INTEGER,
        };
        assert.deepEqual(resultEnv, expectedEnv);

        // unhappy: Invalid owner profile (bad format)
        const badInput = [{ [address1]: "100=200" }];
        assert.throws(
            () => Validator.resolveOwnerProfile(badInput),
            "Invalid owner profile limit, must be an integer gte 0 or 'max' for no limit",
        );

        const badInput2 = { [address1]: "100" };
        assert.throws(
            () => Validator.resolveOwnerProfile(badInput2),
            "expected array of owner limits in k/v format, example: - OWNER: LIMIT",
        );

        const badInput3 = [{ [address1]: "100", badProp: "something" }];
        assert.throws(
            () => Validator.resolveOwnerProfile(badInput3),
            "Invalid owner profile, must be in form of 'OWNER: LIMIT'",
        );

        // unhappy: invalid address in owner profile
        const badAddress = "0xinvalid";
        const badInput4 = [{ [badAddress]: "100" }];
        assert.throws(() => Validator.resolveOwnerProfile(badInput4), /Invalid owner address/);

        process.env.OWNER_PROFILE = `${address3}=200=somethingbad`;
        const badEnvInput = "$OWNER_PROFILE";
        assert.throws(
            () => Validator.resolveOwnerProfile(badEnvInput),
            "Invalid owner profile, must be in form of 'ownerAddress=limitValue'",
        );
    });

    it("test Validator resolveSelfFundVaults", async function () {
        const address1 = `0x${"1".repeat(40)}`;
        const address2 = `0x${"2".repeat(40)}`;
        const address3 = `0x${"3".repeat(40)}`;
        const address4 = `0x${"4".repeat(40)}`;
        const orderbookAddress = "0x1234567890123456789012345678901234567890";

        // happy path using direct object input:
        const inputOrders = [
            {
                token: address1,
                vaultId: "1",
                threshold: "0.5",
                topupAmount: "2.5",
                orderbook: orderbookAddress,
            },
            {
                token: address2,
                vaultId: "2",
                threshold: "1.0",
                topupAmount: "3.5",
                orderbook: orderbookAddress,
            },
        ];
        const resultOrders = Validator.resolveSelfFundVaults(inputOrders);
        const expectedOrders = [
            {
                token: address1,
                vaultId: "1",
                threshold: "0.5",
                topupAmount: "2.5",
                orderbook: orderbookAddress,
            },
            {
                token: address2,
                vaultId: "2",
                threshold: "1.0",
                topupAmount: "3.5",
                orderbook: orderbookAddress,
            },
        ];
        assert.deepEqual(resultOrders, expectedOrders);

        // happy path using env variable:
        process.env.SELF_FUND = `token=${address3},orderbook=${orderbookAddress},vaultId=3,threshold=1.5,topupAmount=2.5,token=${address4},orderbook=${orderbookAddress},vaultId=4,threshold=2.0,topupAmount=3.0`;
        const envInput = "$SELF_FUND";
        const resultEnv = Validator.resolveSelfFundVaults(envInput);
        const expectedEnv = [
            {
                token: address3,
                vaultId: "3",
                threshold: "1.5",
                topupAmount: "2.5",
                orderbook: orderbookAddress,
            },
            {
                token: address4,
                vaultId: "4",
                threshold: "2.0",
                topupAmount: "3.0",
                orderbook: orderbookAddress,
            },
        ];
        assert.deepEqual(resultEnv, expectedEnv);

        // unhappy: Env input with extra key
        process.env.SELF_FUND = `token=${address1},orderbook=${orderbookAddress},vaultId=5,threshold=1.5,topupAmount=2.5,extra=123`;
        assert.throws(
            () => Validator.resolveSelfFundVaults("$SELF_FUND"),
            /unknown key\/value: extra=123/,
        );

        // unhappy: Env input with undefined value
        process.env.SELF_FUND = `token=${address1},orderbook=${orderbookAddress},vaultId=5,threshold=1.5,topupAmount=`;
        assert.throws(
            () => Validator.resolveSelfFundVaults("$SELF_FUND"),
            /expected value after topupAmount=/,
        );

        // unhappy: Env input with extra argument
        process.env.SELF_FUND = `token=${address1}=extra,orderbook=${orderbookAddress},vaultId=5,threshold=1.5,topupAmount=`;
        assert.throws(
            () => Validator.resolveSelfFundVaults("$SELF_FUND"),
            /unexpected arguments: extra/,
        );

        // unhappy: Env input with extra argument
        process.env.SELF_FUND = `token=${address1},orderbook=${orderbookAddress},vaultId=5,threshold=1.5,threshold=2`;
        assert.throws(() => Validator.resolveSelfFundVaults("$SELF_FUND"), /duplicate threshold/);

        // Test case for partial self fund order
        process.env.SELF_FUND = `token=${address1},orderbook=${orderbookAddress},vaultId=5,threshold=1.5`;
        assert.throws(
            () => Validator.resolveSelfFundVaults("$SELF_FUND"),
            "expected a number greater than equal to 0 for topupAmount",
        );

        // unhappy: Direct input not provided as an array
        const badInput = {
            token: address2,
            vaultId: "6",
            threshold: "1.0",
            topupAmount: "2.0",
            orderbook: orderbookAddress,
        };
        assert.throws(
            () => Validator.resolveSelfFundVaults(badInput),
            "expected array of SelfFundVault",
        );

        // unhappy: Invalid token address format in direct input
        const badInput2 = [
            {
                token: "invalid", // not a valid address
                vaultId: "7",
                threshold: "1.2",
                topupAmount: "2.2",
                orderbook: orderbookAddress,
            },
        ];
        assert.throws(() => Validator.resolveSelfFundVaults(badInput2), /invalid token address/);

        // unhappy: Invalid orderbook address format in direct input
        const badInput3 = [
            {
                token: address1,
                vaultId: "7",
                threshold: "1.2",
                topupAmount: "2.2",
                orderbook: "invalid",
            },
        ];
        assert.throws(
            () => Validator.resolveSelfFundVaults(badInput3),
            /invalid orderbook address/,
        );
    });

    it("test Validator resolveSgFilters", async function () {
        // --- Direct object input ---
        const orderHash1 = "0x" + "a".repeat(64);
        const orderHash2 = "0x" + "b".repeat(64);
        const owner1 = "0x" + "1".repeat(40);
        const owner2 = "0x" + "2".repeat(40);
        const orderbook1 = "0x" + "3".repeat(40);
        const orderbook2 = "0x" + "4".repeat(40);

        const inputFilters = {
            includeOrders: [orderHash1, orderHash2],
            excludeOrders: [orderHash2],
            includeOwners: [owner1],
            excludeOwners: [owner2],
            includeOrderbooks: [orderbook1],
            excludeOrderbooks: [orderbook2],
        };
        const resultFilters = Validator.resolveSgFilters(inputFilters)!;
        // Each property should be converted to a Set after validation
        assert(resultFilters, "Expected result object");
        assert.deepEqual(
            resultFilters.includeOrders!,
            new Set(inputFilters.includeOrders.map((v) => v.toLowerCase())),
        );
        assert.deepEqual(
            resultFilters.excludeOrders!,
            new Set(inputFilters.excludeOrders.map((v) => v.toLowerCase())),
        );
        assert.deepEqual(
            resultFilters.includeOwners!,
            new Set(inputFilters.includeOwners.map((v) => v.toLowerCase())),
        );
        assert.deepEqual(
            resultFilters.excludeOwners!,
            new Set(inputFilters.excludeOwners.map((v) => v.toLowerCase())),
        );
        assert.deepEqual(
            resultFilters.includeOrderbooks!,
            new Set(inputFilters.includeOrderbooks.map((v) => v.toLowerCase())),
        );
        assert.deepEqual(
            resultFilters.excludeOrderbooks!,
            new Set(inputFilters.excludeOrderbooks.map((v) => v.toLowerCase())),
        );

        // --- Using environment variable inputs ---
        process.env.FILTER_INCLUDE_ORDERS = `${orderHash1}, ${orderHash2}`;
        process.env.FILTER_INCLUDE_OWNERS = `${owner1}`;
        // Only providing a subset via env vars; the others remain undefined
        const inputFiltersEnv = {
            includeOrders: "$FILTER_INCLUDE_ORDERS",
            includeOwners: "$FILTER_INCLUDE_OWNERS",
        };
        const resultFiltersEnv = Validator.resolveSgFilters(inputFiltersEnv)!;
        assert(resultFiltersEnv, "Expected result object from env input");
        assert.deepEqual(
            resultFiltersEnv.includeOrders!,
            new Set([orderHash1.toLowerCase(), orderHash2.toLowerCase()]),
        );
        assert.deepEqual(resultFiltersEnv.includeOwners!, new Set([owner1.toLowerCase()]));
        // The keys that were not provided should be undefined
        assert.equal(resultFiltersEnv.excludeOrders, undefined);
        assert.equal(resultFiltersEnv.excludeOwners, undefined);
        assert.equal(resultFiltersEnv.includeOrderbooks, undefined);
        assert.equal(resultFiltersEnv.excludeOrderbooks, undefined);

        // When no filters are provided
        const emptyResult = Validator.resolveSgFilters({});
        assert.equal(emptyResult, undefined, "Expected undefined when no filter fields are set");

        // unhappy with invalid filters
        let badInputFilters: any = {
            includeOrders: { orderHash1: orderHash2 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of orderhashes",
        );
        badInputFilters = {
            excludeOrders: { orderHash1: orderHash2 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of orderhashes",
        );
        badInputFilters = {
            includeOrderbooks: { orderHash1: orderbook1 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of orderbook addresses",
        );
        badInputFilters = {
            excludeOrderbooks: { orderHash1: orderbook1 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of orderbook addresses",
        );
        badInputFilters = {
            includeOwners: { orderHash1: owner1 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of owner addresses",
        );
        badInputFilters = {
            excludeOwners: { orderHash1: owner1 },
        };
        assert.throws(
            () => Validator.resolveSgFilters(badInputFilters),
            "expected an array of owner addresses",
        );
    });

    it("test Validator resolveRpc", async function () {
        // happy path using direct object input:
        const inputs = [
            {
                url: "https://example1.com/auth=123",
            },
            {
                url: "https://example2.com",
                weight: "2.5",
                trackSize: "50",
            },
            {
                url: "wss://example3.com",
                weight: "1.5",
            },
            {
                url: "https://example4.com",
                trackSize: "200",
            },
        ];
        const result = Validator.resolveRpc(inputs);
        const expected = [
            {
                url: "https://example1.com/auth=123",
            },
            {
                url: "https://example2.com",
                trackSize: 50,
                selectionWeight: 2.5,
            },
            {
                url: "wss://example3.com",
                selectionWeight: 1.5,
            },
            {
                url: "https://example4.com",
                trackSize: 200,
            },
        ];
        assert.deepEqual(result, expected);

        // happy path using env variable:
        process.env.RPC_URLS =
            "url=https://example1.com/auth=123,url=https://example2.com,weight=2.5,trackSize=50,url=wss://example3.com,weight=1.5,url=https://example4.com,trackSize=200";
        const envInput = "$RPC_URLS";
        const resultEnv = Validator.resolveRpc(envInput);
        assert.deepEqual(resultEnv, expected);

        // unhappy: Env input with extra key
        process.env.RPC_URLS = `url=https://example2.com,weight=2.5,trackSize=50,badKey=123`;
        assert.throws(() => Validator.resolveRpc("$RPC_URLS"), /unknown key: badKey/);

        // unhappy: Env input with undefined value
        process.env.RPC_URLS = `url=https://example2.com,weight=2.5,trackSize=`;
        assert.throws(() => Validator.resolveRpc("$RPC_URLS"), /expected value after trackSize=/);

        // unhappy: Env input with extra argument
        process.env.RPC_URLS = `url=https://example2.com,weight=2.5,trackSize=50=extra`;
        assert.throws(() => Validator.resolveRpc("$RPC_URLS"), /unexpected arguments: extra/);

        // unhappy: Env input duplicate
        process.env.RPC_URLS = `url=https://example2.com,weight=2.5,weight=1.5`;
        assert.throws(() => Validator.resolveRpc("$RPC_URLS"), /duplicate weight/);

        // Test case for bad value
        process.env.RPC_URLS = `url=https://example2.com,weight=2.5,trackSize=abcd`;
        assert.throws(
            () => Validator.resolveRpc("$RPC_URLS"),
            `invalid rpc track size: "abcd", expected an integer greater than equal to 0`,
        );

        // unhappy: Direct input not provided as an array
        const badInput = {
            url: "https://example2.com",
            weight: "2.5",
            trackSize: "50",
        };
        assert.throws(() => Validator.resolveRpc(badInput), "expected array of RpcConfig");

        // unhappy: Invalid token address format in direct input
        const badInput2 = [
            {
                url: "https://example2.com",
                weight: "abcd",
                trackSize: "50",
            },
        ];
        assert.throws(
            () => Validator.resolveRpc(badInput2),
            `invalid rpc weight: "abcd", expected a number greater than equal to 0`,
        );
    });
});

describe("Test yaml Validator helpers", async function () {
    it("test read value", async function () {
        const inputs = {
            env1: "$ENV_VAR",
            env2: "$OTHER_ENV_VAR",
            number: 123,
            str: "something",
            bool: true,
            notDefined: undefined,
        };

        // env override
        process.env.ENV_VAR = "some env var";
        assert.deepEqual(readValue(inputs.env1), { isEnv: true, value: "some env var" });
        process.env.OTHER_ENV_VAR = "some other env var";
        assert.deepEqual(readValue(inputs.env2), { isEnv: true, value: "some other env var" });

        // no env
        assert.deepEqual(readValue(inputs.number), { isEnv: false, value: 123 });
        assert.deepEqual(readValue(inputs.str), { isEnv: false, value: "something" });
        assert.deepEqual(readValue(inputs.bool), { isEnv: false, value: true });

        // undefined
        assert.deepEqual(readValue(inputs.notDefined), { isEnv: false, value: undefined });

        // undefined env
        assert.deepEqual(readValue("$UNDEFINED_ENV"), { isEnv: true, value: undefined });
    });

    it("test try parse array", async function () {
        let result = tryIntoArray("a, b,c, d");
        let expected: any = ["a", "b", "c", "d"];
        assert.deepEqual(result, expected);

        result = tryIntoArray("  abcd   ");
        expected = ["abcd"];
        assert.deepEqual(result, expected);

        result = tryIntoArray("");
        expected = undefined;
        assert.deepEqual(result, expected);

        result = tryIntoArray();
        expected = undefined;
        assert.deepEqual(result, expected);
    });

    it("test validate address", async function () {
        assert.ok(validateAddress("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8D"));

        assert.throws(() => validateAddress(), "expected string");
        assert.throws(() => validateAddress(0x1234567), "expected string");
        assert.throws(() => validateAddress(""), " is not a valid address");
        assert.throws(
            () => validateAddress("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8"),
            "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8 is not a valid address",
        );
        assert.throws(
            () => validateAddress("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8GGG"),
            "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8GGG is not a valid address",
        );
    });

    it("test validate hash", async function () {
        assert.ok(
            validateHash("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8DeDd866204eE07f8DeDd86620"),
        );

        assert.throws(() => validateHash(), "expected string");
        assert.throws(() => validateHash(0x1234567), "expected string");
        assert.throws(() => validateHash(""), " is not a valid hash");
        assert.throws(
            () => validateHash("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8"),
            "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8 is not a valid hash",
        );
        assert.throws(
            () => validateHash("0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8GGG"),
            "0xC1A14cE2fd58A3A2f99deCb8eDd866204eE07f8GGG is not a valid hash",
        );
    });
});
