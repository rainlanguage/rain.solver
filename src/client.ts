/* eslint-disable no-console */
import { SharedState } from "./state";
import { getSgOrderbooks } from "./sg";
import { sendTransaction } from "./tx";
import { RainDataFetcher } from "sushi/router";
import { ViemClient, BotConfig } from "./types";
import { ChainId, ChainKey } from "sushi/chain";
import { publicClientConfig } from "sushi/config";
import { errorSnapshot, shouldThrow } from "./error";
import { normalizeUrl, RpcMetrics, RpcState } from "./rpc";
import { rainSolverTransport, RainSolverTransportConfig } from "./transport";
import {
    HDAccount,
    publicActions,
    walletActions,
    PrivateKeyAccount,
    createWalletClient,
} from "viem";

/**
 * Creates a viem client
 * @param chainId - The chain id
 * @param rpcState - rpc state
 * @param account - If fallback RPCs should be used as well or not
 * @param configuration - The rain solver transport configurations
 */
export async function createViemClient(
    chainId: ChainId,
    rpcState: RpcState,
    account?: HDAccount | PrivateKeyAccount,
    configuration?: RainSolverTransportConfig,
    testClient?: any,
): Promise<ViemClient> {
    const transport = rainSolverTransport(rpcState, configuration);

    const client = testClient
        ? ((await testClient({ account }))
              .extend(publicActions)
              .extend(walletActions) as any as ViemClient)
        : (createWalletClient({
              account,
              chain: publicClientConfig[chainId]?.chain,
              transport,
          }).extend(publicActions) as any as ViemClient);

    // set injected properties
    client.BUSY = false;
    client.sendTx = async (tx) => {
        return await sendTransaction(client, tx);
    };

    return client;
}

/**
 * Keeps record of http fetch requests for a http viem client
 */
export function onFetchRequest(this: RpcState, request: Request) {
    const url = normalizeUrl(request.url);
    let record = this.metrics[url];
    if (!record) {
        record = this.metrics[url] = new RpcMetrics();
    }
    record.recordRequest();
}

/**
 * Keeps record of http fetch responses for a http viem client
 */
export async function onFetchResponse(this: RpcState, response: Response) {
    const _response = response.clone();
    const url = normalizeUrl(_response.url);
    let record = this.metrics[url];
    if (!record) {
        // this cannot really happen, but just to be sure,
        // initialize this rpc record if its not already
        record = this.metrics[url] = new RpcMetrics();
        record.recordRequest();
    }

    if (!_response.ok) {
        record.recordFailure();
        return;
    }

    const handleResponse = (res: any) => {
        if ("result" in res) {
            record.recordSuccess();
            return;
        } else if ("error" in res) {
            if (shouldThrow(res.error)) {
                record.recordSuccess();
                return;
            }
        }
        record.recordFailure();
    };
    if (_response.headers.get("Content-Type")?.startsWith("application/json")) {
        await _response
            .json()
            .then((res: any) => {
                handleResponse(res);
            })
            .catch(() => {
                record.recordFailure();
            });
    } else {
        await _response
            .text()
            .then((text) => {
                try {
                    const res = JSON.parse(text || "{}");
                    handleResponse(res);
                } catch (err) {
                    record.recordFailure();
                }
            })
            .catch(() => {
                record.recordFailure();
            });
    }
}

/**
 * Instantiates a RainDataFetcher
 * @param state - Instance of Sharedstate
 */
export async function getDataFetcher(state: SharedState): Promise<RainDataFetcher> {
    try {
        const dataFetcher = await RainDataFetcher.init(
            state.chainConfig.id as ChainId,
            state.client,
            state.liquidityProviders,
        );
        return dataFetcher as RainDataFetcher;
    } catch (error) {
        throw errorSnapshot("cannot instantiate RainDataFetcher for this network", error);
    }
}

/**
 * Get meta info for a bot to post on otel
 */
export async function getMetaInfo(config: BotConfig, sg: string[]): Promise<Record<string, any>> {
    const obs: string[] = [];
    for (const s of sg) {
        try {
            obs.push(...(await getSgOrderbooks(s)));
        } catch {
            /**/
        }
    }
    try {
        return {
            "meta.chain": ChainKey[config.chain.id as ChainId],
            "meta.chainId": config.chain.id,
            "meta.sg": sg,
            "meta.rpArb": config.arbAddress,
            "meta.genericArb": config.genericArbAddress,
            "meta.orderbooks": obs,
        };
    } catch (e) {
        return {};
    }
}

/**
 * Chain specific public rpcs
 */
export const publicRpcs: Record<number, readonly string[]> = {
    [ChainId.ARBITRUM_NOVA]: ["https://nova.arbitrum.io/rpc"],
    [ChainId.ARBITRUM]: [
        "https://arbitrum.drpc.org",
        "https://arb-pokt.nodies.app",
        "https://1rpc.io/arb",
        "https://rpc.ankr.com/arbitrum",
        "https://arbitrum-one.public.blastapi.io",
        "https://endpoints.omniatech.io/v1/arbitrum/one/public",
        "https://arb1.croswap.com/rpc",
        "https://arbitrum.blockpi.network/v1/rpc/public",
        "https://arb-mainnet-public.unifra.io",
        "https://lb.drpc.org/ogrpc?network=arbitrum&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.AVALANCHE]: [
        "https://api.avax.network/ext/bc/C/rpc",
        "https://rpc.ankr.com/avalanche",
    ],
    [ChainId.BOBA]: ["https://mainnet.boba.network", "https://lightning-replica.boba.network"],
    [ChainId.BOBA_AVAX]: ["https://avax.boba.network", "https://replica.avax.boba.network"],
    [ChainId.BOBA_BNB]: ["https://bnb.boba.network", "https://replica.bnb.boba.network"],
    [ChainId.BSC]: [
        "https://rpc.ankr.com/bsc",
        "https://bsc.blockpi.network/v1/rpc/public",
        "https://bsc-pokt.nodies.app",
        "https://bscrpc.com",
        "https://1rpc.io/bnb",
        "https://bsc.drpc.org",
        "https://bsc.meowrpc.com",
        "https://binance.llamarpc.com",
        "https://bsc-dataseed.binance.org",
        "https://bsc-dataseed1.binance.org",
        "https://bsc-dataseed2.binance.org",
        "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.BTTC]: ["https://rpc.bittorrentchain.io"],
    [ChainId.CELO]: ["https://forno.celo.org"],
    [ChainId.ETHEREUM]: [
        "https://eth-pokt.nodies.app",
        "https://eth.drpc.org",
        "https://ethereum-rpc.publicnode.com",
        "https://eth.llamarpc.com",
        "https://1rpc.io/eth",
        "https://ethereum.publicnode.com",
        "https://cloudflare-eth.com",
        "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.FANTOM]: [
        "https://rpc.ankr.com/fantom",
        "https://rpc.fantom.network",
        "https://rpc2.fantom.network",
    ],
    [ChainId.FUSE]: ["https://rpc.fuse.io"],
    [ChainId.GNOSIS]: ["https://rpc.ankr.com/gnosis"],
    [ChainId.HARMONY]: ["https://api.harmony.one", "https://rpc.ankr.com/harmony"],
    [ChainId.KAVA]: ["https://evm.kava.io", "https://evm2.kava.io"],
    [ChainId.MOONBEAM]: ["https://rpc.api.moonbeam.network", "https://rpc.ankr.com/moonbeam"],
    [ChainId.MOONRIVER]: ["https://rpc.api.moonriver.moonbeam.network"],
    [ChainId.OPTIMISM]: [
        "https://rpc.ankr.com/optimism",
        "https://optimism-mainnet.public.blastapi.io",
        "https://1rpc.io/op",
        "https://optimism.blockpi.network/v1/rpc/public",
        "https://mainnet.optimism.io",
        "https://lb.drpc.org/ogrpc?network=optimism&dkey=Ak765fp4zUm6uVwKu4annC8M80dnCZkR7pAEsm6XXi_w",
    ],
    [ChainId.POLYGON]: [
        "https://polygon.meowrpc.com",
        "https://polygon-rpc.com",
        "https://polygon-pokt.nodies.app",
        "https://polygon-bor-rpc.publicnode.com",
        "https://1rpc.io/matic",
        "https://polygon-mainnet.public.blastapi.io",
        "https://polygon.blockpi.network/v1/rpc/public",
        "https://polygon.llamarpc.com",
        "https://polygon-rpc.com",
        "https://rpc.ankr.com/polygon",
        "https://matic-mainnet.chainstacklabs.com",
        "https://polygon-bor.publicnode.com",
        "https://rpc-mainnet.matic.quiknode.pro",
        "https://rpc-mainnet.maticvigil.com",
    ],
    [ChainId.POLYGON_ZKEVM]: [
        "https://zkevm-rpc.com",
        "https://rpc.ankr.com/polygon_zkevm",
        "https://rpc.polygon-zkevm.gateway.fm",
    ],
    [ChainId.THUNDERCORE]: [
        "https://mainnet-rpc.thundercore.com",
        "https://mainnet-rpc.thundercore.io",
        "https://mainnet-rpc.thundertoken.net",
    ],
    [ChainId.FLARE]: [
        "https://rpc.ankr.com/flare",
        "https://flare-api.flare.network/ext/C/rpc",
        "https://flare.rpc.thirdweb.com",
    ],
    [ChainId.LINEA]: [
        "https://linea.blockpi.network/v1/rpc/public",
        "https://rpc.linea.build",
        "https://linea-rpc.publicnode.com",
        "https://1rpc.io/linea",
        "https://linea.drpc.org",
    ],
    [ChainId.BASE]: [
        "https://base-rpc.publicnode.com",
        "https://base.blockpi.network/v1/rpc/public",
        "https://1rpc.io/base",
        "https://base-pokt.nodies.app",
        "https://mainnet.base.org",
        "https://base.meowrpc.com",
    ],
} as const;
