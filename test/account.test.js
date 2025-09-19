const { assert } = require("chai");
const { ethers, viem } = require("hardhat");
const { sendTransaction } = require("../src/tx");
const { publicActions, walletActions } = require("viem");
const { BridgeUnlimited, ConstantProductRPool } = require("sushi/tines");
const { WNATIVE, WNATIVE_ADDRESS, Native, DAI } = require("sushi/currency");
const { NativeWrapBridgePoolCode, LiquidityProviders, ConstantProductPoolCode } = require("sushi");
const {
    initAccounts,
    manageAccounts,
    rotateAccounts,
    getBatchEthBalance,
    getBatchTokenBalanceForAccount,
    sweepToEth,
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

    it("should initiate accounts successfully with mnemonic", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10000n, 0n, 0n],
            getGasPrice: async () => 3000000n,
        };
        const config = {
            chain: { id: 31337 },
            rpc: ["test"],
            watchedTokens: [],
            viemClient,
            testClientViem: viem.getTestClient,
        };
        const options = {
            walletCount: 2,
            topupAmount: "0.0000000000000001",
        };
        const mnemonic = "test test test test test test test test test test test junk";
        const { mainAccount, accounts } = await initAccounts(
            mnemonic,
            config,
            { watchedTokens: new Map(), client: viemClient },
            options,
        );

        const expected = [
            { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
            { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
            { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
        ];
        assert.equal(mainAccount.account.address, expected[0].address);
        assert.equal(accounts[0].account.address, expected[1].address);
        assert.equal(accounts[1].account.address, expected[2].address);
    });

    it("should initiate accounts successfully with private key", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10000n],
        };
        const config = {
            chain: { id: 31337 },
            rpc: ["test"],
            watchedTokens: [],
            viemClient,
            testClientViem: viem.getTestClient,
        };
        const options = {
            walletCount: 2,
            topupAmount: "100",
        };
        const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const { mainAccount, accounts } = await initAccounts(
            key,
            config,
            { watchedTokens: new Map(), client: viemClient },
            options,
        );

        const expected = [
            { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", BALANCE: "10000" },
        ];
        assert.isEmpty(accounts);
        assert.equal(mainAccount.account.address, expected[0].address);
        assert.equal(mainAccount.BALANCE.toString(), expected[0].BALANCE);
    });

    it("should manage accounts successfully", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10n, 0n],
            getGasPrice: async () => 3000000n,
        };
        const mnemonic = "test test test test test test test test test test test junk";

        const mainAccount = (
            await viem.getTestClient({ account: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" })
        )
            .extend(publicActions)
            .extend(walletActions);
        const acc1 = (
            await viem.getTestClient({ account: "0xdF906eA18C6537C6379aC83157047F507FB37263" })
        )
            .extend(publicActions)
            .extend(walletActions);
        const acc2 = (
            await viem.getTestClient({ account: "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245" })
        )
            .extend(publicActions)
            .extend(walletActions);
        await network.provider.send("hardhat_setBalance", [
            mainAccount.account.address,
            "0x4563918244F40000",
        ]);
        await network.provider.send("hardhat_setBalance", [
            acc1.account.address,
            "0x4563918244F40000",
        ]);
        await network.provider.send("hardhat_setBalance", [
            acc2.account.address,
            "0x4563918244F40000",
        ]);
        acc1.BOUNTY = ["0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"];
        acc2.BOUNTY = ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];
        mainAccount.sendTx = async (tx) => {
            return await sendTransaction(mainAccount, tx);
        };
        acc1.sendTx = async (tx) => {
            return await sendTransaction(acc1, tx);
        };
        acc2.sendTx = async (tx) => {
            return await sendTransaction(acc2, tx);
        };

        mainAccount.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
        acc1.BALANCE = ethers.BigNumber.from("10");
        acc2.BALANCE = ethers.BigNumber.from("0");

        const accounts = [acc1, acc2];
        const config = {
            chain: { id: 31337 },
            rpc: ["test"],
            watchedTokens: [],
            viemClient,
            accounts,
            mainAccount,
            testClientViem: viem.getTestClient,
        };
        const options = {
            walletCount: 2,
            topupAmount: "0.00000000001",
            mnemonic,
        };
        const result = await manageAccounts(config, options, ethers.BigNumber.from("100"), 20, [], {
            watchedTokens: new Map(),
            client: viemClient,
        });
        const expectedAccounts = [
            { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
            { address: "0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D" },
            { address: "0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE" },
        ];

        assert.equal(result, 27);
        assert.equal(mainAccount.account.address, expectedAccounts[0].address);
    });

    it("should rotate accounts", async function () {
        const accounts = ["account1", "account2", "account3"];
        rotateAccounts(accounts);

        const expected = ["account2", "account3", "account1"];
        assert.deepEqual(accounts, expected);
    });

    it("should sweep to eth", async function () {
        const { hexlify, randomBytes } = ethers.utils;
        const chainId = 137;
        const wallet = hexlify(randomBytes(20));
        const poolAddress = hexlify(randomBytes(20));
        const fromToken = DAI[chainId];
        const native = Native.onChain(chainId);
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
                    "QuickSwapV2",
                    "QuickSwapV2 0.3%",
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
                BALANCE: ethers.BigNumber.from("10000"),
                getAddress: () => wallet,
                getGasPrice: async () => 5n,
                estimateGas: async () => 25n,
                getBalance: async () => 10000n,
                sendTransaction: async () => "0x1234",
                sendTx: async () => "0x1234",
                getTransactionCount: async () => 0,
                waitForTransactionReceipt: async () => ({
                    status: "success",
                    effectiveGasPrice: ethers.BigNumber.from(5),
                    gasUsed: ethers.BigNumber.from(10),
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
                call: async () => ({ data: `0x${"1" + "0".repeat(18)}` }),
                getTransactionCount: async () => 0,
            },
        };

        await sweepToEth(config, state);
        assert.deepEqual(config.mainAccount.BOUNTY, []);
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
