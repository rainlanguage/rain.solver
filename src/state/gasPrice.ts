import { ChainId } from "sushi";
import { PublicClient } from "viem";
import { ChainConfig } from "./chain";
import { publicActionsL2 } from "viem/op-stack";

// default gas price for bsc chain, 1 gwei,
// BSC doesnt accept lower gas price for txs, but some RPCs
// at times report lower values which can cause reverted txs
export const BSC_DEFAULT_GAS_PRICE = 1_000_000_000n as const;

/**
 * Fetches the gas price (L1 gas price as well if chain is special L2)
 */
export async function getGasPrice(
    client: PublicClient,
    chainConfig: ChainConfig,
    gasPriceMultiplier = 100,
): Promise<{
    gasPrice: { value: bigint; error: undefined } | { value: undefined; error: Error };
    l1GasPrice: { value: bigint; error: undefined } | { value: undefined; error: Error };
}> {
    const result: any = {
        gasPrice: undefined,
        l1GasPrice: undefined,
    };

    // try to fetch gas prices concurrently
    const promises = [client.getGasPrice()];
    if (chainConfig.isSpecialL2) {
        const l2Client = client.extend(publicActionsL2());
        promises.push(l2Client.getL1BaseFee());
    }
    const [gasPriceResult, l1GasPriceResult = undefined] = await Promise.allSettled(promises);

    // handle gas price
    if (gasPriceResult.status === "fulfilled") {
        let gasPrice = gasPriceResult.value;
        if (chainConfig.id === ChainId.BSC && gasPrice < BSC_DEFAULT_GAS_PRICE) {
            gasPrice = BSC_DEFAULT_GAS_PRICE;
        }
        result.gasPrice = { value: (gasPrice * BigInt(gasPriceMultiplier)) / 100n };
    } else {
        result.gasPrice = { error: gasPriceResult.reason };
    }

    // handle l1 gas price
    if (l1GasPriceResult === undefined) {
        result.l1GasPrice = { value: 0n };
    } else if (l1GasPriceResult?.status === "fulfilled") {
        result.l1GasPrice = { value: l1GasPriceResult.value };
    } else {
        result.l1GasPrice = { error: l1GasPriceResult.reason };
    }

    if (result.gasPrice.error && result.l1GasPrice.error) throw result;
    else return result;
}
