/* eslint-disable no-console */
import assert from "assert";
import { ChainId } from "sushi";
import { GasManager } from "../../gas";
import { createPublicClient } from "viem";
import { AppOptions } from "../../config";
import { Command, Option } from "commander";
import { sleep, TokenDetails } from "../../common";
import { getChainConfig } from "../../state/chain";
import { RainSolverRouter } from "../../router/router";
import { SolverContracts } from "../../state/contracts";
import { rainSolverTransport, RpcState } from "../../rpc";
import { WalletConfig, WalletManager } from "../../wallet";
import { SharedState, SharedStateConfig } from "../../state";
import { OrderManager, OrderManagerConfig } from "../../order";
import { SubgraphConfig, SubgraphManager } from "../../subgraph";

export type SweepOptions = {
    mnemonic: string;
    subgraph: string[];
    rpc: string[];
    length: number;
    token: TokenDetails[];
    gasConversion: boolean;
};

/** Command-line interface for the sweep script */
export const SweepCmd = new Command("sweep")
    .addOption(
        new Option("-m, --mnemonic <mnemonic phrase>", "Mnemonic phrase of the wallet").env(
            "MNEMONIC",
        ),
    )
    .addOption(
        new Option(
            "-s, --subgraph <url...>",
            "Subgraph URL(s) to fetch token list from for sweeping, the list should comma delimited when passed as env variable",
        )
            .env("SUBGRAPH")
            .argParser(parseList),
    )
    .addOption(
        new Option(
            "-r, --rpc <url...>",
            "RPC URL(s) used to perform transactions, the list should comma delimited when passed as env variable",
        )
            .env("RPC")
            .argParser(parseList),
    )
    .addOption(
        new Option("-l, --length <integer>", "Wallet count to derive and sweep")
            .env("LENGTH")
            .argParser((val: string) => {
                const parsed = parseInt(val);
                assert(!isNaN(parsed), "Wallet length must be an integer greater than 1");
                assert(parsed > 1, "Wallet length must be an integer greater than 1");
                return parsed;
            }),
    )
    .addOption(
        new Option(
            "-t, --token <address,symbol,decimals...>",
            "Additional tokens to sweep",
        ).argParser((tokenStr: string, previous: TokenDetails[] = []): TokenDetails[] => {
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
        }),
    )
    .option("--no-gas-conversion", "Skip converting all holdings to gas at the end of the sweep")
    .description(
        "Sweeps funds from multiple wallets derived from a mnemonic to the main address of the wallet (index 0) and optionally converts all of them to gas",
    )
    .action(async (options: SweepOptions) => {
        await sweepFunds(options);
        console.log("\x1b[32m%s\x1b[0m", "Sweep process finished successfully!\n");
    });

/**
 * A script to sweep tokens from multiple wallets derived from a mnemonic to the main wallet and convert all of them to gas.
 * Main wallet is the first wallet derived from the mnemonic (index 0). other wallets start from index 1 to length-1 are the ones that will be swept to main wallet.
 * @param mnemonic - The mnemonic to derive wallets from
 * @param subgraph - The subgraph urls to fetch token lists from
 * @param rpc - The RPC url(s) to use
 * @param length - The number of wallets to derive and sweep their funds, starts from index 1, index 0 is the main wallet and is the one that the funds are swept to
 * @param tokens - Additional token details to sweep, it wont duplicate if already fetched from subgraph
 */
export async function sweepFunds(opts: SweepOptions) {
    const { mnemonic, subgraph, rpc, length, token: tokens = [] } = opts;

    // build app options, not all fields are used
    const options: AppOptions = {
        rpc: rpc.map((v) => ({ url: v })),
        mnemonic,
        walletCount: length,
        subgraph,
        gasLimitMultiplier: 100,
        gasPriceMultiplier: 107,

        // unused fields but need to be defined
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
        contracts: {},
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
        contracts: await SolverContracts.fromAppOptions(client, options),
        walletConfig: WalletConfig.tryFromAppOptions(options),
        subgraphConfig: SubgraphConfig.tryFromAppOptions(options),
        orderManagerConfig: OrderManagerConfig.tryFromAppOptions(options),
        gasManager: await GasManager.init({
            client,
            chainConfig,
            baseGasPriceMultiplier: options.gasPriceMultiplier,
        }),
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

    if (opts.gasConversion) {
        // convert all holdings of the main wallet to gas
        // some token swaps in this process might fail due to normal onchain tx failures,
        // so we repeat the process until all tokens are converted or max attempts reached
        // the logged report will show if there are any failures
        const convertHoldingsToGasReport = await walletManager.convertHoldingsToGas();
        console.log(convertHoldingsToGasReport);
    }
}

function parseList(list: string, previous: string[] = []) {
    if (list.includes(",")) {
        const parts = list.split(",");
        return [...previous, ...parts.map((p) => p.trim()).filter((p) => p.length > 0)];
    } else {
        return [...previous, list];
    }
}
