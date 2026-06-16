/* eslint-disable no-console */
import { Command, Option } from "commander";
import { formatUnits, parseUnits } from "viem";
import { estimateProfit } from "../../core/modes/raindex";

export type RaindexRouteLiveOptions = {
    orderInMax: string;
    orderInRatio: string;
    orderInInputToEthPrice: string;
    orderInOutputToEthPrice: string;
    orderOutMax: string;
    orderOutRatio: string;
    externalRoutePrice: string;
};

/** Command-line interface for the checking Raindex route script */
export const RaindexRouteCmd = new Command("raindex-route")
    .addOption(
        new Option("--order-in-max <number>", "The input order max output")
            .env("ORDER_IN_MAX")
            .makeOptionMandatory(),
    )
    .addOption(
        new Option("--order-in-ratio <number>", "The input order ratio")
            .env("ORDER_IN_RATIO")
            .makeOptionMandatory(),
    )
    .addOption(
        new Option(
            "--order-in-input-to-eth-price <number>",
            "The input order input token to eth price, optional, if not provided will be deriven from order's ratio and external price",
        ).env("ORDER_IN_INPUT_TO_ETH_PRICE"),
    )
    .addOption(
        new Option(
            "--order-in-output-to-eth-price <number>",
            "The input order output token to eth price",
        )
            .env("ORDER_IN_OUTPUT_TO_ETH_PRICE")
            .makeOptionMandatory(),
    )
    .addOption(
        new Option("--order-out-max <number>", "The output order max output")
            .env("ORDER_OUT_MAX")
            .makeOptionMandatory(),
    )
    .addOption(
        new Option("--order-out-ratio <number>", "The output order ratio")
            .env("ORDER_OUT_RATIO")
            .makeOptionMandatory(),
    )
    .addOption(
        new Option("--external-route-price <number>", "The external route price (sushi)")
            .env("EXTERNAL_PRICE")
            .makeOptionMandatory(),
    )
    .description(
        "Checks profitability of a Raindex routeed trade, this is the initial off-chain possible profitability check",
    )
    .action(async (options: RaindexRouteLiveOptions) => {
        await checkRaindexRoute(options);
        console.log("\x1b[32m%s\x1b[0m", "Checking Raindex route process finished successfully!\n");
    });

/**
 * A script to check profitability of the a raindex route
 * @param opts - RaindexRouteLiveOptions
 */
export async function checkRaindexRoute(opts: RaindexRouteLiveOptions) {
    const {
        orderInMax,
        orderInRatio,
        orderInInputToEthPrice,
        orderInOutputToEthPrice,
        orderOutMax,
        orderOutRatio,
        externalRoutePrice,
    } = opts;

    const orderIn = {
        takeOrder: {
            quote: {
                maxOutput: parseUnits(orderInMax, 18),
                ratio: parseUnits(orderInRatio, 18),
            },
        },
    } as any;
    const orderOut = {
        takeOrder: {
            quote: {
                maxOutput: parseUnits(orderOutMax, 18),
                ratio: parseUnits(orderOutRatio, 18),
            },
        },
    } as any;
    const result = estimateProfit(
        orderIn,
        orderOut,
        {
            price: parseUnits(externalRoutePrice, 18),
        } as any,
        orderInInputToEthPrice,
        orderInOutputToEthPrice,
    );

    console.log("\nCalculated profit:", formatUnits(result.profit, 18), "ETH\n");
}
