/* eslint-disable no-console */
import { SweepCmd } from "./sweep";
import { RainSolverCli } from "..";
import { DowntimeCmd } from "./downtime";
import { Command, Option, OptionValues } from "commander";

export { sweepFunds, SweepOptions } from "./sweep";
export { main as downtimeReport, DowntimeOptions, DowntimeOptionsExtended } from "./downtime";

const { version } = require("../../../package.json");

/** Command-line interface for the Rain Solver using `commander` lib */
export const RainSolverCmd = new Command("node rain-solver")
    .version(version)
    .alias("rain-solver")
    .addCommand(SweepCmd) // add sweep subcommand
    .addCommand(DowntimeCmd) // add downtime subcommand
    .addOption(
        new Option(
            "-c, --config <path>",
            "Path to config yaml file, can be set in 'CONFIG' env var instead, if none is given, looks for ./config.yaml in curent directory",
        )
            .env("CONFIG")
            .default("./config.env.yaml"),
    )
    .description(
        [
            "Node.js app that solves (clears) Rain Orderbook orders against onchain liquidity (DEXes, other Rain Orderbooks and orders), requires Node.js v22 or higher.",
        ].join("\n"),
    )
    .action(async (options: OptionValues) => {
        const rainSolverCli = await RainSolverCli.init(options);
        await rainSolverCli.run();
        console.log("\x1b[32m%s\x1b[0m", "Rain Solver process finished successfully!\n");
    });
