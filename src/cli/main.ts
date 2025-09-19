import { RainSolverCli } from ".";

/**
 * Main entry point for the rain solver cli app
 * @param argv - command line arguments
 */
export async function main(argv: any) {
    const rainSolverCli = await RainSolverCli.init(argv);
    await rainSolverCli.run();
}
