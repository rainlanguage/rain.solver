import { ChainId } from "sushi";
import { Result } from "../common";
import { ChainConfig } from "../state/chain";
import { BaseError, PublicClient } from "viem";
import { publicActionsL2 } from "viem/op-stack";

// default gas price for bsc chain, 1 gwei,
// BSC doesnt accept lower gas price for txs, but some RPCs
// at times report lower values which can cause reverted txs
export const BSC_DEFAULT_GAS_PRICE = 1_000_000_000n as const;

export type GasPriceResult = {
    gasPrice: Result<bigint, BaseError>;
    l1GasPrice: Result<bigint, BaseError>;
};

/**
 * Fetches the gas price (L1 gas price as well if chain is special L2)
 */
export async function getGasPrice(
    client: PublicClient,
    chainConfig: ChainConfig,
    gasPriceMultiplier = 100,
): Promise<GasPriceResult> {
    let gasPrice: Result<bigint, BaseError>;
    let l1GasPrice: Result<bigint, BaseError>;

    // try to fetch gas prices concurrently
    const promises = [client.getGasPrice()];
    if (chainConfig.isSpecialL2) {
        const l2Client = client.extend(publicActionsL2());
        promises.push(l2Client.getL1BaseFee());
    }
    const [gasPriceResult, l1GasPriceResult = undefined] = await Promise.allSettled(promises);

    // handle gas price
    if (gasPriceResult.status === "fulfilled") {
        let value = gasPriceResult.value;
        if (chainConfig.id === ChainId.BSC && value < BSC_DEFAULT_GAS_PRICE) {
            value = BSC_DEFAULT_GAS_PRICE;
        }
        gasPrice = Result.ok((value * BigInt(gasPriceMultiplier)) / 100n) as Result<
            bigint,
            BaseError
        >;
    } else {
        gasPrice = Result.err(gasPriceResult.reason);
    }

    // handle l1 gas price
    if (l1GasPriceResult === undefined) {
        l1GasPrice = Result.ok(0n);
    } else if (l1GasPriceResult?.status === "fulfilled") {
        l1GasPrice = Result.ok(l1GasPriceResult.value);
    } else {
        l1GasPrice = Result.err(l1GasPriceResult.reason);
    }

    return { gasPrice, l1GasPrice };
}
