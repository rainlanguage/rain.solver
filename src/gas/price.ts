import { Result } from "../common";
import { ChainConfig } from "../state/chain";
import { BaseError, BlockTag, PublicClient } from "viem";
import { publicActionsL2 } from "viem/op-stack";

export type GasPriceResult = {
    gasPrice: Result<bigint, BaseError>;
    l1GasPrice: Result<bigint, BaseError>;
};

/**
 * Fetches the gas price of the operating chain and the L1 gas price, if the
 * chain is a special L2, at once, see getChainGasPrice and getL1GasPrice
 * @param client - The client to read through
 * @param chainConfig - The operating chain's config
 */
export async function getGasPrice(
    client: PublicClient,
    chainConfig: ChainConfig,
): Promise<GasPriceResult> {
    const [gasPrice, l1GasPrice] = await Promise.all([
        getChainGasPrice(client),
        getL1GasPrice(client, chainConfig),
    ]);
    return { gasPrice, l1GasPrice };
}

/**
 * Fetches the gas price of the operating chain, the node's own suggestion
 * @param client - The client to read through
 */
export async function getChainGasPrice(client: PublicClient): Promise<Result<bigint, BaseError>> {
    try {
        return Result.ok(await client.getGasPrice());
    } catch (error) {
        return Result.err(error as BaseError);
    }
}

/**
 * Fetches the L1 gas price if the chain is a special L2, 0 otherwise with no
 * read at all
 * @param client - The client to read through
 * @param chainConfig - The operating chain's config
 */
export async function getL1GasPrice(
    client: PublicClient,
    chainConfig: ChainConfig,
): Promise<Result<bigint, BaseError>> {
    if (!chainConfig.isSpecialL2) return Result.ok(0n);
    try {
        return Result.ok(await client.extend(publicActionsL2()).getL1BaseFee());
    } catch (error) {
        return Result.err(error as BaseError);
    }
}

/** The eip1559 fees a fee history gives, see getFeeHistoryFees */
export type FeeHistoryFees = {
    /**
     * The tip, the mean of each block's priority fees at all the asked
     * percentiles, all of them together, the zero ones (of empty blocks) left
     * out, 0 when every block paid none, a chain with no tip market, undefined
     * when the history carries no rewards at all
     */
    tip?: bigint;
    /** The base fee of the block after the newest of the range, undefined when not given */
    nextBaseFee?: bigint;
};

/**
 * Fetches the fee history of the given number of blocks up to the given block
 * tag, and gives the tip, the mean of all the blocks' priority fees at all
 * the given percentiles together, 2 percentiles over 10 blocks give 20 values,
 * and the base fee of the next block
 * @param client - The client to read through
 * @param blockCount - The number of blocks of the history
 * @param percentiles - The percentiles of each block's priority fees
 * @param blockTag - (optional) The newest block of the history, latest when unset
 */
export async function getFeeHistoryFees(
    client: PublicClient,
    blockCount: number,
    percentiles: number[],
    blockTag?: BlockTag,
): Promise<Result<FeeHistoryFees, BaseError>> {
    try {
        const history = await client.getFeeHistory({
            blockCount,
            blockTag: blockTag ?? "latest",
            rewardPercentiles: percentiles,
        });
        const rewards = (history.reward ?? [])
            .flat()
            .filter((tip): tip is bigint => typeof tip === "bigint");
        const tips = rewards.filter((tip) => tip > 0n);
        // blocks that all paid nothing are a read too, the chain has no tip
        // market and its tip is 0, a history with no rewards at all read none
        const tip = tips.length ? mean(tips) : rewards.length ? 0n : undefined;
        return Result.ok({
            tip,
            nextBaseFee: history.baseFeePerGas[history.baseFeePerGas.length - 1],
        });
    } catch (error) {
        return Result.err(error as BaseError);
    }
}

/**
 * The mean of the given values, rounded down, undefined for none
 * @param values - The values
 */
export function mean(values: bigint[]): bigint | undefined {
    if (!values.length) return undefined;
    return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}
