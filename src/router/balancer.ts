/* eslint-disable no-console */
import {
    // Swap,
    Token,
    ChainId,
    // Slippage,
    SwapKind,
    TokenAmount,
    BalancerApi,
    // SwapBuildCallInput,
    // ExactInQueryOutput,
    // SwapBuildOutputExactIn,
    Path,
    PathWithAmount,
    AddressProvider,
    batchRouterAbi_V3,
} from "@balancer/sdk";
import { Token as SushiToken } from "sushi/currency";
import { Result } from "../common";
import { SharedState } from "../state";
import { RainSolverSigner } from "../signer";

export const BALANCER_API_URL = "https://api-v3.balancer.fi/" as const;
export type BalancerRouterStep = {
    pool: `0x${string}`;
    tokenOut: `0x${string}`;
    isBuffer: boolean;
};

export type BalancerRouterPath = {
    tokenIn: `0x${string}`;
    exactAmountIn: bigint;
    minAmountOut: bigint;
    steps: BalancerRouterStep[];
};
export type GetBestBalancerPriceParams = {
    tokenIn: SushiToken;
    tokenOut: SushiToken;
    swapAmount: bigint;
    wethIsEth?: boolean;
    deadline?: bigint;
    slippage?: `${number}`;
};

export async function getBalancerSortedRoutes(
    this: SharedState,
    params: GetBestBalancerPriceParams,
): Promise<Result<BalancerRouterPath[], Error>> {
    const { tokenIn: _tokenIn, tokenOut: _tokenOut, swapAmount: _swapAmount } = params;

    console.log(ChainId[this.chainConfig.id]);
    if (typeof ChainId[this.chainConfig.id] !== "string") {
        return Result.err(new Error(`Unsupported chain with id: ${this.chainConfig.id}`));
    }

    const chainId = this.chainConfig.id as ChainId;
    const tokenIn = new Token(chainId, _tokenIn.address, _tokenIn.decimals, _tokenIn.symbol);
    const tokenOut = new Token(chainId, _tokenOut.address, _tokenOut.decimals, _tokenOut.symbol);
    const swapAmount = TokenAmount.fromRawAmount(tokenIn, _swapAmount);
    const swapKind = SwapKind.GivenIn;

    // API is used to fetch best swap paths from available liquidity across v2 and v3
    const balancerApi = new BalancerApi(BALANCER_API_URL, chainId);

    const sorPaths = await balancerApi.sorSwapPaths.fetchSorSwapPaths({
        chainId,
        tokenIn: tokenIn.address.toLowerCase() as `0x${string}`,
        tokenOut: tokenOut.address.toLowerCase() as `0x${string}`,
        swapKind,
        swapAmount,
        useProtocolVersion: 3,
    });
    console.log("sorted", sorPaths);

    if (sorPaths.length === 0) {
        return Result.err(new Error("no balancer route for given token pair"));
    }

    const bestRoute = convertToSwapRoute(sorPaths);
    return Result.ok(bestRoute);
}

export async function getBestBalancerRoute(
    this: SharedState,
    params: GetBestBalancerPriceParams,
): Promise<Result<BalancerRouterPath[], Error>> {
    const balancerSortedRoutes = await getBalancerSortedRoutes.call(this, params);
    if (balancerSortedRoutes.isErr()) {
        return Result.err(balancerSortedRoutes.error);
    }

    const bestRoute = { ...balancerSortedRoutes.value[0] };
    bestRoute.exactAmountIn = params.swapAmount;

    return Result.ok([bestRoute]);
}

export async function getBalancerMarketPrice(
    this: SharedState,
    route: BalancerRouterPath[],
    signer: RainSolverSigner,
): Promise<Result<bigint, Error>> {
    const balancerRouter = AddressProvider.BatchRouter(this.chainConfig.id);

    try {
        const result = await this.client.simulateContract({
            address: balancerRouter,
            abi: batchRouterAbi_V3,
            functionName: "querySwapExactIn",
            args: [route, signer.account.address, "0x"],
        });
        return Result.ok(result.result[2][0]);
    } catch (e: any) {
        return Result.err(e);
    }
}

export function convertToSwapRoute(paths: Path[]): BalancerRouterPath[] {
    const pathsWithAmounts = paths.map(
        (p) =>
            new PathWithAmount(
                ChainId.MAINNET,
                p.tokens,
                p.pools,
                p.inputAmountRaw,
                p.outputAmountRaw,
                p.isBuffer,
            ),
    );
    const swaps = pathsWithAmounts.map((p) => {
        return {
            tokenIn: p.inputAmount.token.address,
            exactAmountIn: p.inputAmount.amount,
            minAmountOut: p.outputAmount.amount,
            steps: p.pools.map((pool, i) => {
                return {
                    pool,
                    tokenOut: p.tokens[i + 1].address,
                    isBuffer: p.isBuffer[i],
                };
            }),
        };
    });
    return swaps;
}
