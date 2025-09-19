const { assert } = require("chai");
const { ethers } = require("hardhat");
const { BridgeUnlimited, ConstantProductRPool } = require("sushi/tines");
const { WNATIVE, WNATIVE_ADDRESS, Native, DAI } = require("sushi/currency");
const { NativeWrapBridgePoolCode, LiquidityProviders, ConstantProductPoolCode } = require("sushi");
const {
    rotateAccounts,
    getBatchEthBalance,
    getBatchTokenBalanceForAccount,
    fundOwnedOrders,
} = require("../src/account");

describe("Test accounts", async function () {
    it("should get batch eth balance", async function () {
        const balances = [10000n, 0n, 0n];
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => balances,
        };
        const result = await getBatchEthBalance(
            [`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`],
            viemClient,
        );
        const expected = balances.map((v) => ethers.BigNumber.from(v));
        assert.deepEqual(result, expected);
    });

    it("should get batch token balance for address", async function () {
        const balances = [10000n, 4567n];
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => balances,
        };
        const result = await getBatchTokenBalanceForAccount(
            { account: { address: `0x${"0".repeat(64)}` } },
            [`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`],
            viemClient,
        );
        const expected = balances.map((v) => ethers.BigNumber.from(v));
        assert.deepEqual(result, expected);
    });

    it("should rotate accounts", async function () {
        const accounts = ["account1", "account2", "account3"];
        rotateAccounts(accounts);

        const expected = ["account2", "account3", "account1"];
        assert.deepEqual(accounts, expected);
    });

    it("should fund owned orders", async function () {
        const { hexlify, randomBytes } = ethers.utils;
        const chainId = 137;
        const wallet = hexlify(randomBytes(20));
        const poolAddress = hexlify(randomBytes(20));
        const fromToken = DAI[chainId];
        const native = Native.onChain(chainId);
        const orderId = hexlify(randomBytes(32));
        const orderbook = hexlify(randomBytes(20));
        const vaultId = hexlify(randomBytes(32));
        const poolCodeMap = new Map([
            [
                poolAddress,
                new ConstantProductPoolCode(
                    new ConstantProductRPool(
                        poolAddress,
                        WNATIVE[chainId],
                        fromToken,
                        0.003,
                        100000000000000000000000n,
                        100000000000000000000000n,
                    ),
                    "QuickSwap",
                    "QuickSwap 0.3%",
                ),
            ],
            [
                WNATIVE_ADDRESS[chainId],
                new NativeWrapBridgePoolCode(
                    new BridgeUnlimited(
                        WNATIVE_ADDRESS[chainId],
                        {
                            address: "",
                            name: native.name,
                            symbol: native.symbol,
                            chainId: chainId,
                            decimals: 18,
                        },
                        WNATIVE[chainId],
                        0,
                        50_000,
                    ),
                    LiquidityProviders.NativeWrap,
                ),
            ],
        ]);
        const state = { gasPrice: 5n };
        const config = {
            chain: { id: chainId },
            mainAccount: {
                account: { address: wallet },
                BOUNTY: [fromToken],
                BALANCE: ethers.utils.parseUnits("1000"),
                getAddress: () => wallet,
                getGasPrice: async () => 5n,
                estimateGas: async () => 25n,
                getBalance: async () => 10000n,
                sendTransaction: async () => "0x1234",
                sendTx: async () => "0x1234",
                getTransactionCount: async () => 0,
                call: async () => ({ data: "0x00" }),
                waitForTransactionReceipt: async () => ({
                    status: "success",
                    effectiveGasPrice: ethers.BigNumber.from(50_000_000_000),
                    gasUsed: ethers.BigNumber.from(1_000_000_000),
                    logs: [],
                    events: [],
                }),
            },
            dataFetcher: {
                fetchedPairPools: [],
                fetchPoolsForToken: async () => {},
                getCurrentPoolCodeMap: () => poolCodeMap,
                web3Client: { getGasPrice: async () => 30_000_000n },
            },
            viemClient: {
                chain: { id: chainId },
                getGasPrice: async () => 5n,
                call: async () => ({ data: `0x${"1" + "0".repeat(18)}` }),
            },
            selfFundOrders: [
                {
                    token: fromToken.address,
                    vaultId,
                    threshold: "0.0001",
                    topupAmount: "1",
                },
            ],
        };
        const ownedOrders = [
            {
                id: orderId,
                vaultId,
                token: fromToken.address,
                symbol: fromToken.symbol,
                decimals: fromToken.decimals,
                orderbook,
                vaultBalance: ethers.BigNumber.from("0"),
            },
        ];

        const result = await fundOwnedOrders(ownedOrders, config, state);
        assert.deepEqual(result, []);
        assert.ok(
            // (balance - gasCost - gasCost - sent topup) >= current balance (a bit lower than right side because of pool fee)
            ethers.utils
                .parseUnits((1000 - 50 - 50 - 1).toString())
                .gte(config.mainAccount.BALANCE),
            `${ethers.utils.parseUnits(
                (1000 - 100 - 1).toString(),
            )} not gte to ${config.mainAccount.BALANCE.toString()}`,
        );
    });
});
