import { Command, OptionValues } from "commander";
const { version } = require("../../package.json");

/**
 * Command-line interface for the Rain Solver using `commander` lib
 * @param argv - The cli arguments.
 */
export async function cmd(argv: any): Promise<OptionValues> {
    return new Command("node rain-solver")
        .option(
            "-c, --config <path>",
            "Path to config yaml file, can be set in 'CONFIG' env var instead, if none is given, looks for ./config.yaml in curent directory",
            process.env.CONFIG || "./config.yaml", // defaults to CONFIG env var or./config.yaml
        )
        .description(
            [
                "Node.js app that solves (clears) Rain Orderbook orders against onchain liquidity (DEXes, other Rain Orderbooks and orders), requires Node.js v22 or higher.",
            ].join("\n"),
        )
        .alias("rain-solver")
        .version(version)
        .parse(argv)
        .opts();
}
