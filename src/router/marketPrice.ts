import { SharedState } from "../state";
import { Token } from "sushi/currency";
import { ChainId, Router } from "sushi";
import { scaleTo18, ONE18 } from "../math";
import { PoolBlackList, RPoolFilter } from ".";
import { formatUnits, parseUnits, maxUint256 } from "viem";

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
            // try balancer
            if (this.balancerRouter) {
                const balancerPriceResult = await this.balancerRouter.getMarketPrice(
                    {
                        tokenIn: fromToken,
                        tokenOut: toToken,
                        swapAmount: amountIn,
                    },
                    this.client,
                );
                if (balancerPriceResult.isOk()) {
                    const price = scaleTo18(balancerPriceResult.value.amountOut, toToken.decimals);
                    return {
                        price: formatUnits(price, 18),
                        amountOut: formatUnits(
                            balancerPriceResult.value.amountOut,
                            toToken.decimals,
                        ),
                    };
                }
            }
            return;
        } else {
            const price = scaleTo18(route.amountOutBI, toToken.decimals);
            return {
                price: formatUnits(price, 18),
                amountOut: formatUnits(route.amountOutBI, toToken.decimals),
            };
        }
    } catch (error) {
        return;
    }
}

/**
 * Calculates the fallback price of a token pair input token to ETH from the order and counterparty order
 * ratios and known output token to ETH price when there is no route in sushi router to get the output token
 * to ETH price directly.
 * Thi is done by assuming the min of the two order and counterparty order ratios as a price path to calculate
 * the pair's input token to ETH price, for calculating a pair output token to ETH price, just pass the ratios
 * in place of eachother.
 *
 * @example
 * pair A/B, where A is the input token and B is the output token
 * we already know the price of B to ETH (oEthPrice), and we want to calculate the price of A to ETH
 * we have the following ratios from order and counterparty order:
 * - oiRatio: ratio of the order, which is OI, output token to input token, ie A/B
 * - ioRatio: ratio of the counterparty order, which is IO, input token to output token, ie B/A
 * by inversing the oiRatio, and getting min of that and ioRatio, we now have a path from
 * A to B to ETH, which we can use to calculate the price of A to ETH:
 * - if B to ETH price is 0.5
 * - oiRatio is 2 (2 A for 1 B) and inveresed is 0.5 (0.5 B for 1 A)
 * - ioRatio is 1 (1 B for 1 A)
 * - A to ETH is: min(0.5, 1) * 0.5 = 0.25 ie for 1 A, we get 0.25 ETH
 *
 * @param oiRatio - The ratio of the order, ie output token to input token - OI ratio
 * @param ioRatio - The ratio of the counterparty order, ie input token to output token - IO ratio
 * @param oEthPrice - The output token price to ETH
 */
export function fallbackEthPrice(oiRatio: bigint, ioRatio: bigint, oEthPrice: string): string {
    const oiRatioInverese = oiRatio === 0n ? maxUint256 : ONE18 ** 2n / oiRatio;
    const minRatio = oiRatioInverese < ioRatio ? oiRatioInverese : ioRatio;
    return formatUnits((minRatio * parseUnits(oEthPrice, 18)) / ONE18, 18);
}
