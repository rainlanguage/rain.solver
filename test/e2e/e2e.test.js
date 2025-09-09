require("dotenv").config();
const { assert } = require("chai");
const testData = require("./data");
const { RainSolver } = require("../../src/core");
const { ABI, Result, toFloat, normalizeFloat } = require("../../src/common");
const { RpcState } = require("../../src/rpc");
const mockServer = require("mockttp").getLocal();
const { sendTx, waitUntilFree, estimateGasCost } = require("../../src/signer/actions");
const { ethers, viem, network } = require("hardhat");
const { ChainKey, RainDataFetcher, ChainId } = require("sushi");
const { publicClientConfig } = require("sushi/config");
const { Resource } = require("@opentelemetry/resources");
const { getChainConfig } = require("../../src/state/chain");
const { rainSolverTransport } = require("../../src/rpc");
const { ProcessOrderStatus } = require("../../src/core/types");
const ERC20Artifact = require("../abis/ERC20Upgradeable.json");
const { abi: orderbookAbi } = require("../abis/OrderBook.json");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { publicActions, walletActions, createPublicClient } = require("viem");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { SEMRESATTRS_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");
const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OrderManager } = require("../../src/order");
const {
    arbDeploy,
    encodeMeta,
    getEventArgs,
    randomUint256,
    mockSgFromEvent,
    genericArbrbDeploy,
    deployOrderBookNPE2,
    rainterpreterNPE2Deploy,
    rainterpreterStoreNPE2Deploy,
    rainterpreterParserNPE2Deploy,
    rainterpreterExpressionDeployerNPE2Deploy,
    balancerArbDeploy,
} = require("../utils");
const { SharedState } = require("../../src/state");
const balancerHelpers = require("../../src/router/balancer");
const { maxFloat } = require("../../src/math");

// run tests on each network in the provided data
for (let i = 0; i < testData.length; i++) {
    const [
        chainId,
        rpc,
        blockNumber,
        tokens,
        addressesWithBalance,
        liquidityProviders,
        deposits,
        orderbookAddress,
        arbAddress,
        botAddress,
    ] = testData[i];

    // if rpc is not defined for a network go to next test
    if (!rpc) continue;

    describe(`Rain Arb Bot E2E Tests on "${ChainKey[chainId]}" Network`, async function () {
        before(() => mockServer.start(8080));
        after(() => mockServer.stop());

        // get config for the chain
        const configResult = getChainConfig(chainId);
        assert(configResult.isOk());
        const config = configResult.value;
        config.chain = publicClientConfig[chainId].chain;

        // get available route processor versions for the chain (only RP4)
        const rpVersions = Object.keys(config.routeProcessors).filter((v) => v === "4");
        if (rpVersions.length === 0)
            assert.fail(`Found no known RP4 contract address on ${ChainKey[chainId]} chain`);

        const exporter = new OTLPTraceExporter();
        const provider = new BasicTracerProvider({
            resource: new Resource({
                [SEMRESATTRS_SERVICE_NAME]: "rain-solver-test",
            }),
        });
        provider.addSpanProcessor(new BatchSpanProcessor(exporter));
        provider.register();
        const tracer = provider.getTracer("rain-solver-tracer");

        config.rpc = [rpc];
        const rpcState = new RpcState(config.rpc.map((v) => ({ url: v })));
        const balancerRouter = (() => {
            const balancerRouterInit = balancerHelpers.BalancerRouter.init(chainId);
            if (balancerRouterInit.isOk()) return balancerRouterInit.value;
            else return undefined;
        })();
        const state = new SharedState({
            chainConfig: config,
            client: {},
            dispair: {},
            rpcState,
            subgraphConfig: {
                subgraphs: [],
            },
            orderManagerConfig: {
                ownerLimits: {},
                quoteGas: 1_000_000n,
            },
            balancerRouter,
        });
        const client = createPublicClient({
            chain: publicClientConfig[chainId].chain,
            transport: rainSolverTransport(rpcState, {
                retryCountNext: 50,
                timeout: 600_000,
            }),
        });
        const dataFetcherPromise = RainDataFetcher.init(chainId, client, liquidityProviders);

        // run tests on each rp version
        for (let j = 0; j < rpVersions.length; j++) {
            const rpVersion = rpVersions[j];

            it(`should clear orders successfully using route processor v${rpVersion}`, async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                state.client = viemClient;
                const dataFetcher = await dataFetcherPromise;
                state.dataFetcher = dataFetcher;
                dataFetcher.web3Client.transport.retryCount = 3;
                const testSpan = tracer.startSpan("test-clearing");

                // reset network before each test
                await helpers.reset(rpc, blockNumber);
                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTx(bot, tx);
                };
                bot.waitUntilFree = async () => {
                    return await waitUntilFree(bot);
                };
                bot.estimateGasCost = async (tx) => {
                    return await estimateGasCost(bot, tx);
                };
                bot.asWriteSigner = () => bot;
                bot.state = state;
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);

                const arb = !arbAddress
                    ? await arbDeploy(orderbook.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(ABI.Orderbook.Primary.Arb, arbAddress);

                state.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    tokens[i].vaultId = randomUint256();
                    tokens[i].depositAmount = ethers.utils.parseUnits(
                        deposits[i] ?? "100",
                        tokens[i].decimals,
                    );
                    // owners.push(
                    //     (await viem.getTestClient({account: addressesWithBalance[i]})).extend(publicActions).extend(walletActions)
                    //     // await ethers.getImpersonatedSigner(addressesWithBalance[i])
                    // );
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook.address, depositConfigStruct.amount);
                    await orderbook
                        .connect(owners[i])
                        .deposit3(
                            depositConfigStruct.token,
                            depositConfigStruct.vaultId,
                            toFloat(depositConfigStruct.amount, tokens[i].decimals).value,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0 max; :;"
                    const ratio = "0".repeat(64); // 0
                    const maxOutput = maxFloat(18).substring(2).padStart(64, "0"); // max
                    const bytecode = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput}${ratio}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx = await orderbook.connect(owners[i]).addOrder3(addOrderConfig, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx, "AddOrderV3", orderbook),
                            orderbook,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );
                }

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.orderbookAddress = orderbook.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.testBlockNumberInc = BigInt(blockNumber); // increments during test updating to new block height
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 120;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                const orderManager = new OrderManager(state);
                for (const order of orders) {
                    const res = await orderManager.addOrder(order);
                    assert(res.isOk());
                }
                orders = orderManager.getNextRoundOrders(false);

                state.gasPrice = await bot.getGasPrice();
                orderManager.getNextRoundOrders = () => orders;
                const rainSolver = new RainSolver(
                    state,
                    config,
                    orderManager,
                    {
                        mainSigner: bot,
                        getRandomSigner: () => bot,
                    },
                    // config,
                );
                const { results: reports } = await rainSolver.processNextRound(undefined, false);

                // should have cleared correct number of orders
                assert.ok(reports.length == tokens.length - 1, "Failed to clear all given orders");

                // validate each cleared order
                let inputProfit = ethers.constants.Zero;
                let gasSpent = ethers.constants.Zero;
                for (let i = 0; i < reports.length; i++) {
                    const report = reports[i].value;
                    assert.equal(report.status, ProcessOrderStatus.FoundOpportunity);

                    const pair = `${tokens[0].symbol}/${tokens[i + 1].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(report.clearedAmount);
                    const outputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[i + 1].address,
                                tokens[i + 1].address,
                                tokens[i + 1].vaultId,
                            ),
                            tokens[i + 1].decimals,
                        ).value,
                    );
                    const inputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[0].address,
                                tokens[0].address,
                                tokens[0].vaultId,
                            ),
                            tokens[0].decimals,
                        ).value,
                    );
                    const botTokenBalance = await tokens[i + 1].contract.balanceOf(
                        bot.account.address,
                    );

                    assert.equal(report.tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[i + 1].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[i + 1].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);
                    assert.ok(
                        originalBotTokenBalances[i + 1].eq(botTokenBalance),
                        `Unexpected current bot ${tokens[i + 1].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(ethers.utils.parseUnits(report.inputTokenIncome));
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(report.gasCost.toString()));
                }

                testSpan.end();
            });

            it("should clear orders successfully using inter-orderbook", async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                state.client = viemClient;
                const dataFetcher = await dataFetcherPromise;
                state.dataFetcher = dataFetcher;
                dataFetcher.web3Client.transport.retryCount = 3;
                const testSpan = tracer.startSpan("test-clearing");

                // reset network before each test
                await helpers.reset(rpc, blockNumber);

                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTx(bot, tx);
                };
                bot.waitUntilFree = async () => {
                    return await waitUntilFree(bot);
                };
                bot.estimateGasCost = async (tx) => {
                    return await estimateGasCost(bot, tx);
                };
                bot.asWriteSigner = () => bot;
                bot.state = state;
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook1 = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);
                const orderbook2 = await deployOrderBookNPE2();
                const genericArb = await genericArbrbDeploy(orderbook2.address);
                const arb = !arbAddress
                    ? await arbDeploy(orderbook1.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(ABI.Orderbook.Primary.Arb, arbAddress);

                state.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    if (i === 0) {
                        tokens[0].vaultIds = [];
                        for (let j = 0; j < tokens.length - 1; j++) {
                            tokens[0].vaultIds.push(randomUint256());
                        }
                    }
                    tokens[i].vaultId = randomUint256();
                    i > 0
                        ? (tokens[i].depositAmount = ethers.utils.parseUnits(
                              deposits[i] ?? "100",
                              tokens[i].decimals,
                          ))
                        : (tokens[i].depositAmount = ethers.utils
                              .parseUnits(deposits[i] ?? "100", tokens[i].decimals)
                              .div(tokens.length - 1));
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct1 = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook1.address, depositConfigStruct1.amount);
                    await orderbook1
                        .connect(owners[i])
                        .deposit3(
                            depositConfigStruct1.token,
                            depositConfigStruct1.vaultId,
                            toFloat(depositConfigStruct1.amount, tokens[i].decimals).value,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0 max; :;"
                    const ratio = "0".repeat(64); // 0
                    const maxOutput = maxFloat(18).substring(2).padStart(64, "0"); // max
                    const bytecode = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput}${ratio}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig1 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx1 = await orderbook1.connect(owners[i]).addOrder3(addOrderConfig1, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx1, "AddOrderV3", orderbook1),
                            orderbook1,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );

                    // opposing orders
                    const depositConfigStruct2 = {
                        token: tokens[0].address,
                        vaultId: tokens[0].vaultIds[i - 1],
                        amount: tokens[0].depositAmount.toString(),
                    };
                    await tokens[0].contract
                        .connect(owners[0])
                        .approve(orderbook2.address, depositConfigStruct2.amount);
                    await orderbook2
                        .connect(owners[0])
                        .deposit3(
                            depositConfigStruct2.token,
                            depositConfigStruct2.vaultId,
                            toFloat(depositConfigStruct2.amount, tokens[0].decimals).value,
                            [],
                        );
                    const addOrderConfig2 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultIds[i - 1],
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx2 = await orderbook2.connect(owners[0]).addOrder3(addOrderConfig2, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx2, "AddOrderV3", orderbook2),
                            orderbook2,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );
                }

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.genericArbAddress = genericArb.address;
                config.orderbookAddress = orderbook1.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 120;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                const orderManager = new OrderManager(state);
                for (const order of orders) {
                    const res = await orderManager.addOrder(order);
                    assert(res.isOk());
                }
                orders = orderManager.getNextRoundOrders(false);

                // mock init quotes
                orders.forEach((pair) => {
                    pair.takeOrder.quote = {
                        ratio: ethers.constants.Zero.toBigInt(),
                        maxOutput: tokens
                            .find(
                                (t) =>
                                    t.contract.address.toLowerCase() ===
                                    pair.sellToken.toLowerCase(),
                            )
                            ?.depositAmount.mul("1" + "0".repeat(18 - pair.sellTokenDecimals))
                            .toBigInt(),
                    };
                });
                state.gasPrice = await bot.getGasPrice();
                orderManager.getNextRoundOrders = () => orders;
                const rainSolver = new RainSolver(
                    state,
                    config,
                    orderManager,
                    {
                        mainSigner: bot,
                        getRandomSigner: () => bot,
                    },
                    // config,
                );
                const { results: reports } = await rainSolver.processNextRound(undefined, false);

                // should have cleared correct number of orders
                assert.ok(
                    reports.length == (tokens.length - 1) * 2,
                    "Failed to clear all given orders",
                );

                // validate each cleared order
                let gasSpent = ethers.constants.Zero;
                let inputProfit = ethers.constants.Zero;
                for (let i = 0; i < reports.length / 2; i++) {
                    const report = reports[i].value;
                    assert.equal(report.status, ProcessOrderStatus.FoundOpportunity);

                    const pair = `${tokens[0].symbol}/${tokens[i + 1].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(report.clearedAmount);
                    const outputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook1.vaultBalance2(
                                owners[i + 1].address,
                                tokens[i + 1].address,
                                tokens[i + 1].vaultId,
                            ),
                            tokens[i + 1].decimals,
                        ).value,
                    );
                    const inputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook1.vaultBalance2(
                                owners[0].address,
                                tokens[0].address,
                                tokens[0].vaultId,
                            ),
                            tokens[0].decimals,
                        ).value,
                    );

                    assert.equal(report.tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[i + 1].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[i + 1].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(ethers.utils.parseUnits(report.inputTokenIncome));
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(report.gasCost.toString()));
                }

                // all input bounties (+ old balance) should be equal to current bot's balance
                assert.ok(
                    originalBotTokenBalances[0]
                        .add(inputProfit)
                        .eq(await tokens[0].contract.balanceOf(bot.account.address)),
                    "Unexpected bot bounty",
                );

                testSpan.end();
            });

            it("should clear orders successfully using intra-orderbook", async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                const dataFetcher = await dataFetcherPromise;
                state.client = viemClient;
                state.dataFetcher = dataFetcher;
                dataFetcher.web3Client.transport.retryCount = 3;
                const testSpan = tracer.startSpan("test-clearing");

                // reset network before each test
                await helpers.reset(rpc, blockNumber);

                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTx(bot, tx);
                };
                bot.waitUntilFree = async () => {
                    return await waitUntilFree(bot);
                };
                bot.estimateGasCost = async (tx) => {
                    return await estimateGasCost(bot, tx);
                };
                bot.asWriteSigner = () => bot;
                bot.state = state;
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);
                const arb = !arbAddress
                    ? await arbDeploy(orderbook.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(ABI.Orderbook.Primary.Arb, arbAddress);

                state.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    if (i === 0) {
                        tokens[0].vaultIds = [];
                        for (let j = 0; j < tokens.length - 1; j++) {
                            tokens[0].vaultIds.push(randomUint256());
                        }
                    }
                    tokens[i].vaultId = randomUint256();
                    i > 0
                        ? (tokens[i].depositAmount = ethers.utils.parseUnits(
                              deposits[i] ?? "100",
                              tokens[i].decimals,
                          ))
                        : (tokens[i].depositAmount = ethers.utils
                              .parseUnits(deposits[i] ?? "100", tokens[i].decimals)
                              .div(4));
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                const opposingOrders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct1 = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook.address, depositConfigStruct1.amount);
                    await orderbook
                        .connect(owners[i])
                        .deposit3(
                            depositConfigStruct1.token,
                            depositConfigStruct1.vaultId,
                            toFloat(depositConfigStruct1.amount, tokens[i].decimals).value,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0.5 max; :;"
                    const ratio1 = toFloat(500000000000000000n, 18)
                        .value.substring(2)
                        .padStart(64, "0"); // 0.5
                    const maxOutput1 = maxFloat(18).substring(2).padStart(64, "0"); // max
                    const bytecode1 = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput1}${ratio1}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig1 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode: bytecode1,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx1 = await orderbook.connect(owners[i]).addOrder3(addOrderConfig1, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx1, "AddOrderV3", orderbook),
                            orderbook,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );

                    // opposing orders
                    const depositConfigStruct2 = {
                        token: tokens[0].address,
                        vaultId: tokens[0].vaultIds[i - 1],
                        amount: tokens[0].depositAmount.toString(),
                    };
                    await tokens[0].contract
                        .connect(owners[0])
                        .approve(orderbook.address, depositConfigStruct2.amount);
                    await orderbook
                        .connect(owners[0])
                        .deposit3(
                            depositConfigStruct2.token,
                            depositConfigStruct2.vaultId,
                            toFloat(depositConfigStruct2.amount, tokens[0].decimals).value,
                            [],
                        );

                    // prebuild bytecode: "_ _: 1 max; :;"
                    const ratio2 = toFloat(1000000000000000000n, 18)
                        .value.substring(2)
                        .padStart(64, "0"); // 1
                    const maxOutput2 = maxFloat(18).substring(2).padStart(64, "0"); // max
                    const bytecode2 = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput2}${ratio2}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig2 = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode: bytecode2,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultIds[i - 1],
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx2 = await orderbook.connect(owners[0]).addOrder3(addOrderConfig2, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    opposingOrders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx2, "AddOrderV3", orderbook),
                            orderbook,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );
                }
                orders.push(...opposingOrders);

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.orderbookAddress = orderbook.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.gasCoveragePercentage =
                    chainId === ChainId.BASE || chainId == ChainId.MATCHAIN ? "0" : "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 120;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                const orderManager = new OrderManager(state);
                for (const order of orders) {
                    const res = await orderManager.addOrder(order);
                    assert(res.isOk());
                }
                orders = orderManager.getNextRoundOrders(false);

                // mock init quotes
                orders.forEach((pair) => {
                    pair.takeOrder.quote = {
                        ratio: ethers.constants.Zero.toBigInt(),
                        maxOutput: tokens
                            .find(
                                (t) =>
                                    t.contract.address.toLowerCase() ===
                                    pair.sellToken.toLowerCase(),
                            )
                            ?.depositAmount.mul("1" + "0".repeat(18 - pair.sellTokenDecimals))
                            .toBigInt(),
                    };
                });
                state.gasPrice = await bot.getGasPrice();
                orderManager.getNextRoundOrders = () => orders;
                const rainSolver = new RainSolver(
                    state,
                    config,
                    orderManager,
                    {
                        mainSigner: bot,
                        getRandomSigner: () => bot,
                    },
                    // config,
                );
                const { results: reports } = await rainSolver.processNextRound(undefined, false);

                // should have cleared correct number of orders
                assert.ok(
                    reports.length == (tokens.length - 1) * 2,
                    "Failed to clear all given orders",
                );

                // validate each cleared order
                let c = 1;
                let gasSpent = ethers.constants.Zero;
                for (let i = 0; i < reports.length; i++) {
                    const report = reports[i].value;
                    if (report.status !== ProcessOrderStatus.FoundOpportunity) continue;
                    assert.equal(report.status, ProcessOrderStatus.FoundOpportunity);

                    const pair = `${tokens[0].symbol}/${tokens[c].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(report.clearedAmount);
                    const outputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[c].address,
                                tokens[c].address,
                                tokens[c].vaultId,
                            ),
                            tokens[c].decimals,
                        ).value,
                    );
                    const inputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[0].address,
                                tokens[0].address,
                                tokens[0].vaultId,
                            ),
                            tokens[0].decimals,
                        ).value,
                    );
                    const botTokenBalance = await tokens[0].contract.balanceOf(bot.account.address);

                    assert.equal(report.tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[c].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[c].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);
                    assert.ok(
                        originalBotTokenBalances[0].eq(botTokenBalance),
                        `Unexpected current bot ${tokens[0].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(report.gasCost.toString()));

                    // check bounty
                    const outputProfit = ethers.utils.parseUnits(
                        report.outputTokenIncome,
                        tokens[c].decimals,
                    );
                    assert.ok(
                        originalBotTokenBalances[c]
                            .add(outputProfit)
                            .eq(await tokens[c].contract.balanceOf(bot.account.address)),
                        "Unexpected bot bounty",
                    );
                    c++;
                }

                testSpan.end();
            });

            it("should clear orders successfully using balancer router", async function () {
                config.rpc = [rpc];
                const viemClient = await viem.getPublicClient();
                state.client = viemClient;
                state.client.simulateContract = client.simulateContract;
                const dataFetcher = await dataFetcherPromise;
                state.dataFetcher = dataFetcher;
                dataFetcher.web3Client.transport.retryCount = 3;
                const testSpan = tracer.startSpan("test-clearing");

                // set as the route for POC
                balancerHelpers.BalancerRouter.prototype.tryQuote = async function (params) {
                    return Result.ok({
                        route: [
                            {
                                steps: [
                                    {
                                        pool: "0x88c044fb203b58b12252be7242926b1eeb113b4a",
                                        tokenOut: "0x4200000000000000000000000000000000000006",
                                        isBuffer: false,
                                    },
                                ],
                                tokenIn: params.tokenIn.address,
                                exactAmountIn: params.swapAmount,
                                minAmountOut: 0n,
                            },
                        ],
                        price: 100000000000000000000000n,
                        amountOut: 100000000000000000000000n,
                    });
                };

                // reset network before each test
                await helpers.reset(rpc, blockNumber);
                // get bot signer
                const bot = botAddress
                    ? (await viem.getTestClient({ account: botAddress }))
                          .extend(publicActions)
                          .extend(walletActions)
                    : (
                          await viem.getTestClient({
                              account: "0x22025257BeF969A81eDaC0b343ce82d777931327",
                          })
                      )
                          .extend(publicActions)
                          .extend(walletActions);
                bot.sendTx = async (tx) => {
                    return await sendTx(bot, tx);
                };
                bot.waitUntilFree = async () => {
                    return await waitUntilFree(bot);
                };
                bot.estimateGasCost = async (tx) => {
                    return await estimateGasCost(bot, tx);
                };
                bot.asWriteSigner = () => bot;
                bot.state = state;
                bot.impersonateAccount({
                    address: botAddress ?? "0x22025257BeF969A81eDaC0b343ce82d777931327",
                });
                await network.provider.send("hardhat_setBalance", [
                    bot.account.address,
                    "0x4563918244F40000",
                ]);
                bot.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
                bot.BOUNTY = [];

                // deploy contracts
                const interpreter = await rainterpreterNPE2Deploy();
                const store = await rainterpreterStoreNPE2Deploy();
                const parser = await rainterpreterParserNPE2Deploy();
                const deployer = await rainterpreterExpressionDeployerNPE2Deploy({
                    interpreter: interpreter.address,
                    store: store.address,
                    parser: parser.address,
                });
                const orderbook = !orderbookAddress
                    ? await deployOrderBookNPE2()
                    : await ethers.getContractAt(orderbookAbi, orderbookAddress);

                const arb = !arbAddress
                    ? await arbDeploy(orderbook.address, config.routeProcessors[rpVersion])
                    : await ethers.getContractAt(ABI.Orderbook.Primary.Arb, arbAddress);

                const balancerArb = await balancerArbDeploy(
                    orderbook.address,
                    config.routeProcessors[rpVersion],
                );

                state.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                // set up tokens contracts and impersonate owners
                const owners = [];
                for (let i = 0; i < tokens.length; i++) {
                    tokens[i].contract = await ethers.getContractAt(
                        ERC20Artifact.abi,
                        tokens[i].address,
                    );
                    tokens[i].vaultId = ethers.BigNumber.from(randomUint256());
                    tokens[i].depositAmount = ethers.utils.parseUnits(
                        deposits[i] ?? "100",
                        tokens[i].decimals,
                    );
                    // owners.push(
                    //     (await viem.getTestClient({account: addressesWithBalance[i]})).extend(publicActions).extend(walletActions)
                    //     // await ethers.getImpersonatedSigner(addressesWithBalance[i])
                    // );
                    owners.push(await ethers.getImpersonatedSigner(addressesWithBalance[i]));
                    await network.provider.send("hardhat_setBalance", [
                        addressesWithBalance[i],
                        "0x4563918244F40000",
                    ]);
                }

                // bot original token balances
                const originalBotTokenBalances = [];
                for (const t of tokens) {
                    originalBotTokenBalances.push(await t.contract.balanceOf(bot.account.address));
                }

                // dposit and add orders for each owner and return
                // the deployed orders in format of a sg query.
                // all orders have WETH as output and other specified
                // tokens as input
                let orders = [];
                for (let i = 1; i < tokens.length; i++) {
                    const depositConfigStruct = {
                        token: tokens[i].address,
                        vaultId: tokens[i].vaultId,
                        amount: tokens[i].depositAmount.toString(),
                    };
                    await tokens[i].contract
                        .connect(owners[i])
                        .approve(orderbook.address, depositConfigStruct.amount);
                    await orderbook
                        .connect(owners[i])
                        .deposit3(
                            depositConfigStruct.token,
                            depositConfigStruct.vaultId,
                            toFloat(depositConfigStruct.amount, tokens[i].decimals).value,
                            [],
                        );

                    // prebuild bytecode: "_ _: 0 max; :;"
                    const ratio = "0".repeat(64); // 0
                    const maxOutput = maxFloat(18).substring(2).padStart(64, "0"); // max
                    const bytecode = `0x0000000000000000000000000000000000000000000000000000000000000002${maxOutput}${ratio}0000000000000000000000000000000000000000000000000000000000000015020000000c02020002011000000110000100000000`;
                    const addOrderConfig = {
                        evaluable: {
                            interpreter: interpreter.address,
                            store: store.address,
                            bytecode,
                        },
                        nonce: "0x" + "0".repeat(63) + "1",
                        secret: "0x" + "0".repeat(63) + "1",
                        validInputs: [
                            {
                                token: tokens[0].address,
                                vaultId: tokens[0].vaultId,
                            },
                        ],
                        validOutputs: [
                            {
                                token: tokens[i].address,
                                vaultId: tokens[i].vaultId,
                            },
                        ],
                        meta: encodeMeta("some_order"),
                    };
                    const tx = await orderbook.connect(owners[i]).addOrder3(addOrderConfig, [
                        {
                            evaluable: {
                                interpreter: interpreter.address,
                                store: store.address,
                                bytecode:
                                    "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000701000000000000",
                            },
                            signedContext: [],
                        },
                    ]);
                    orders.push(
                        await mockSgFromEvent(
                            await getEventArgs(tx, "AddOrderV3", orderbook),
                            orderbook,
                            tokens.map((v) => ({
                                ...v.contract,
                                knownSymbol: v.symbol,
                                decimals: v.decimals,
                            })),
                        ),
                    );
                }

                // run the clearing process
                config.isTest = true;
                config.shuffle = false;
                config.signer = bot;
                config.hops = 2;
                config.retries = 1;
                config.lps = liquidityProviders;
                config.rpVersion = rpVersion;
                config.arbAddress = arb.address;
                config.balancerArbAddress = balancerArb.address;
                config.orderbookAddress = orderbook.address;
                config.testBlockNumber = BigInt(blockNumber);
                config.testBlockNumberInc = BigInt(blockNumber); // increments during test updating to new block height
                config.gasCoveragePercentage = "1";
                config.viemClient = viemClient;
                config.dataFetcher = dataFetcher;
                config.accounts = [];
                config.mainAccount = bot;
                config.gasPriceMultiplier = 107;
                config.gasLimitMultiplier = 120;
                config.dispair = {
                    interpreter: interpreter.address,
                    store: store.address,
                    deployer: deployer.address,
                };

                const orderManager = new OrderManager(state);
                for (const order of orders) {
                    const res = await orderManager.addOrder(order);
                    assert(res.isOk());
                }
                orders = orderManager.getNextRoundOrders(false);

                state.gasPrice = await bot.getGasPrice();
                orderManager.getNextRoundOrders = () => orders;
                const rainSolver = new RainSolver(
                    state,
                    config,
                    orderManager,
                    {
                        mainSigner: bot,
                        getRandomSigner: () => bot,
                    },
                    // config,
                );
                const { results: reports } = await rainSolver.processNextRound(undefined, false);

                // should have cleared correct number of orders
                assert.ok(reports.length == tokens.length - 1, "Failed to clear all given orders");

                // validate each cleared order
                let inputProfit = ethers.constants.Zero;
                let gasSpent = ethers.constants.Zero;
                for (let i = 0; i < reports.length; i++) {
                    const report = reports[i].value;
                    assert.equal(report.status, ProcessOrderStatus.FoundOpportunity);

                    const pair = `${tokens[0].symbol}/${tokens[i + 1].symbol}`;
                    const clearedAmount = ethers.BigNumber.from(report.clearedAmount);
                    const outputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[i + 1].address,
                                tokens[i + 1].address,
                                tokens[i + 1].vaultId,
                            ),
                            tokens[i + 1].decimals,
                        ).value,
                    );
                    const inputVault = ethers.BigNumber.from(
                        normalizeFloat(
                            await orderbook.vaultBalance2(
                                owners[0].address,
                                tokens[0].address,
                                tokens[0].vaultId,
                            ),
                            tokens[0].decimals,
                        ).value,
                    );
                    const botTokenBalance = await tokens[i + 1].contract.balanceOf(
                        bot.account.address,
                    );

                    assert.equal(report.tokenPair, pair);

                    // should have cleared equal to vault balance or lower
                    assert.ok(
                        tokens[i + 1].depositAmount.gte(clearedAmount),
                        `Did not clear expected amount for: ${pair}`,
                    );
                    assert.ok(
                        outputVault.eq(tokens[i + 1].depositAmount.sub(clearedAmount)),
                        `Unexpected current output vault balance: ${pair}`,
                    );
                    assert.ok(inputVault.eq(0), `Unexpected current input vault balance: ${pair}`);
                    assert.ok(
                        originalBotTokenBalances[i + 1].eq(botTokenBalance),
                        `Unexpected current bot ${tokens[i + 1].symbol} balance`,
                    );

                    // collect all bot's input income (bounty) and gas cost
                    inputProfit = inputProfit.add(ethers.utils.parseUnits(report.inputTokenIncome));
                    gasSpent = gasSpent.add(ethers.utils.parseUnits(report.gasCost.toString()));
                }

                testSpan.end();
            });
        }
    });
}
