/* eslint-disable no-console */
import assert from "assert";
import { ChainId } from "sushi";
import { Command } from "commander";
import { createPublicClient } from "viem";
import { AppOptions } from "../src/config";
import { sleep, TokenDetails } from "../src/common";
import { getChainConfig } from "../src/state/chain";
import { rainSolverTransport, RpcState } from "../src/rpc";
import { WalletConfig, WalletManager } from "../src/wallet";
import { SharedState, SharedStateConfig } from "../src/state";
import { OrderManager, OrderManagerConfig } from "../src/order";
import { SubgraphConfig, SubgraphManager } from "../src/subgraph";
import { RainSolverRouter } from "../src/router/router";

/**
 * Command-line interface for the sweep script
 * @param argv - The cli arguments.
 */
export async function main(argv: any[]) {
    if (argv.length < 3) {
        throw new Error("Expected required arguments, use --help or -h to see usage");
    }
    const params = new Command("npm run sweep --")
        .option("-m, --mnemonic <mnemonic phrase>", "Mnemonic phrase of the wallet")
        .option("-s, --sg <url...>", "Subgraph URL(s) to fetch token list from for sweeping")
        .option("-r, --rpc <url>", "RPC URL used to perform transactions")
        .option("-l, --length <integer>", "Wallet count to derive and sweep", (val: string) => {
            const parsed = parseInt(val);
            assert(!isNaN(parsed), "Wallet length must be an integer greater than 1");
            assert(parsed > 1, "Wallet length must be an integer greater than 1");
            return parsed;
        })
        .option(
            "-t, --token <address,symbol,decimals...>",
            "Additional tokens to sweep",
            (tokenStr: string, previous: TokenDetails[] = []): TokenDetails[] => {
                const parts = tokenStr.split(",");
                assert(
                    parts.length === 3,
                    "Token details must be in the format of: address,symbol,decimals",
                );
                const [address, symbol, decimalsStr] = parts;
                const decimals = parseInt(decimalsStr);
                assert(
                    !isNaN(decimals) && decimals > 0,
                    `Invalid decimals value: ${decimalsStr} in token: ${tokenStr}, must be a positive integer`,
                );
                return [...previous, { address, symbol, decimals }];
            },
        )
        .description(
            "Sweep funds from multiple wallets derived from a mnemonic to the main wallet and convert all of them to gas",
        )
        .parse(argv)
        .opts();

    // run sweep with the given params
    await sweepFunds(params.mnemonic, params.subgraph, params.rpc, params.length, params.token);
}

/**
 * A script to sweep tokens from multiple wallets derived from a mnemonic to the main wallet and convert all of them to gas.
 * Main wallet is the first wallet derived from the mnemonic (index 0). other wallets start from index 1 to length-1 are the ones that will be swept to main wallet.
 * @param mnemonic - The mnemonic to derive wallets from
 * @param subgraph - The subgraph urls to fetch token lists from
 * @param rpc - The RPC url to use
 * @param length - The number of wallets to derive and sweep their funds, starts from index 1, index 0 is the main wallet and is the one that the funds are swept to
 * @param tokens - Additional token details to sweep, it wont duplicate if already fetched from subgraph
 */
export async function sweepFunds(
    mnemonic: string,
    subgraph: string[],
    rpc: string,
    length: number,
    tokens: TokenDetails[] = [],
) {
    // build app options, not all fields are used
    const options: AppOptions = {
        rpc: [{ url: rpc }],
        mnemonic,
        walletCount: length,
        subgraph,
        gasLimitMultiplier: 100,
        gasPriceMultiplier: 107,

        // unused fields but need to be defined
        arbAddress: "",
        maxRatio: false,
        rpOnly: false,
        sleep: 0,
        gasCoveragePercentage: "",
        timeout: 15,
        botMinBalance: "0",
        poolUpdateInterval: 0,
        route: "single",
        quoteGas: 0n,
        topupAmount: "0",
        dispair: "",
    };

    // prepare state config fields
    const rainSolverTransportConfig = { timeout: options.timeout };
    const rpcState = new RpcState(options.rpc);
    // use temp client to get chain id
    let client = createPublicClient({
        transport: rainSolverTransport(rpcState, rainSolverTransportConfig),
    }) as any;
    // get chain config
    const chainId = await client.getChainId();
    const chainConfigResult = getChainConfig(chainId as ChainId);
    if (chainConfigResult.isErr()) {
        throw chainConfigResult.error;
    }
    const chainConfig = chainConfigResult.value;
    client = createPublicClient({
        chain: chainConfig,
        transport: rainSolverTransport(rpcState, rainSolverTransportConfig),
    });
    const routerResult = await RainSolverRouter.create({
        chainId,
        client,
        sushiRouterConfig: {
            sushiRouteProcessor4Address: chainConfig.routeProcessors["4"] as `0x${string}`,
        },
    });
    if (routerResult.isErr()) {
        throw routerResult.error;
    }

    // start state
    const stateConfig: SharedStateConfig = {
        client,
        rpcState,
        chainConfig,
        router: routerResult.value,
        appOptions: options,
        rainSolverTransportConfig,
        transactionGas: options.txGas,
        gasPriceMultiplier: options.gasPriceMultiplier,
        walletConfig: WalletConfig.tryFromAppOptions(options),
        subgraphConfig: SubgraphConfig.tryFromAppOptions(options),
        orderManagerConfig: OrderManagerConfig.tryFromAppOptions(options),
        dispair: {
            interpreter: "0x",
            store: "0x",
            deployer: "0x",
        },
    };
    const state = new SharedState(stateConfig);

    // start sg and order managers to capture tokens list to sweep
    const subgraphManager = new SubgraphManager(stateConfig.subgraphConfig);
    await OrderManager.init(state, subgraphManager);

    // add additional tokens to sweep
    tokens.forEach((t) => state.watchToken(t));

    // start gas price watcher and wait a bit for initial gas price fetch
    state.unwatchGasPrice();
    state.watchGasPrice(5_000);
    await sleep(6_000);

    // start wallet manager and sweep wallets
    // failures here is unlikely because it is just a simple "send" tx
    // but sometimes it can happen, if so, repeat the process to sweep the
    // missing tokens, the logged report will show if there are any failures
    const walletManager: WalletManager = new (WalletManager as any)(state);
    let c = 1;
    for (const [, wallet] of walletManager.workers.signers) {
        const report = await walletManager.sweepWallet(wallet);
        console.log(report);
        console.log("done wallet count:", c++);
        await sleep(2000);
    }

    // convert all holdings of the main wallet to gas
    // some token swaps in this process might fail due to normal onchain tx failures,
    // so we repeat the process until all tokens are converted or max attempts reached
    // the logged report will show if there are any failures
    const convertHoldingsToGasReport = await walletManager.convertHoldingsToGas();
    console.log(convertHoldingsToGasReport);
}

// run main
main(process.argv)
    .then(() => {
        console.log("\x1b[32m%s\x1b[0m", "Sweep process finished successfully!");
        process.exit(0);
    })
    .catch((v) => {
        console.log("\x1b[31m%s\x1b[0m", "An error occured during execution: ");
        console.log(v);
        process.exit(1);
    });
