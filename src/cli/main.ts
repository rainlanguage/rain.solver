import { RainSolverCmd } from "./commands";

/**
 * Main entry point for the rain solver cli app
 * @param argv - command line arguments
 */
export async function main(argv: any) {
    await RainSolverCmd.parseAsync(argv);
}
