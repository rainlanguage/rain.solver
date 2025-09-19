import { scale18 } from "../math";
import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { ChainId, Router } from "sushi";
import { formatUnits, parseUnits } from "viem";
import { PoolBlackList, RPoolFilter } from ".";

/**
 * Get market price for 1 unit of token for a token pair
 * @param fromToken - The sell token
 * @param toToken - The buy token
 * @param blockNumber - Optional block number to fetch the pools data at a specific block height
 */
export async function getMarketPrice(
    this: SharedState,
    fromToken: Token,
    toToken: Token,
    blockNumber?: bigint,
): Promise<{ price: string; amountOut: string } | undefined> {
    // return early if from and to tokens are the same
    if (fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
        return {
            price: "1",
            amountOut: "1",
        };
    }

    const amountIn = parseUnits("1", fromToken.decimals);
    try {
        await this.dataFetcher.fetchPoolsForToken(fromToken, toToken, PoolBlackList, {
            blockNumber,
        });
        const pcMap = this.dataFetcher.getCurrentPoolCodeMap(fromToken, toToken);
        const route = Router.findBestRoute(
            pcMap,
            this.chainConfig.id as ChainId,
            fromToken,
            amountIn,
            toToken,
            Number(this.gasPrice),
            undefined,
            RPoolFilter,
        );
        if (route.status == "NoWay") {
            return;
        } else {
            const price = scale18(route.amountOutBI, toToken.decimals);
            return {
                price: formatUnits(price, 18),
                amountOut: formatUnits(route.amountOutBI, toToken.decimals),
            };
        }
    } catch (error) {
        return;
    }
}
