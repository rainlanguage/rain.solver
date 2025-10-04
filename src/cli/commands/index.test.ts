import { RainSolverCmd } from ".";
import { describe, it, expect } from "vitest";

describe("Test cli options", () => {
    it("should get cli options", async function () {
        // overwrite the action for testing
        RainSolverCmd.action(function () {});

        const expected: Record<string, any> = {
            config: "./config.env.yaml",
        };

        // default
        let result = RainSolverCmd.parse(["", ""]).opts();
        expect(result).toStrictEqual(expected);

        // default from env
        process.env.CONFIG = "path/to/env.config.yaml";
        result = RainSolverCmd.parse(["", ""]).opts();
        expected.config = "path/to/env.config.yaml";
        expect(result).toStrictEqual(expected);
        delete process.env.CONFIG;

        // -c flag
        result = RainSolverCmd.parse(["", "", "-c", "path/to/config.yaml"]).opts();
        expected.config = "path/to/config.yaml";
        expect(result).toStrictEqual(expected);

        // --config flag
        result = RainSolverCmd.parse(["", "", "--config", "path/to/config.yaml"]).opts();
        expected.config = "path/to/config.yaml";
        expect(result).toStrictEqual(expected);

        // unknown flag should throw
        expect(() => RainSolverCmd.parse(["", "", "-a"]).opts()).toThrow(
            'process.exit unexpectedly called with "1"',
        );

        // hook to stdout
        let stdoutText = "";
        const orgStdout = process.stdout.write;
        process.stdout.write = (function (write: any) {
            return function (string: any) {
                stdoutText += string;
                // eslint-disable-next-line prefer-rest-params
                write.apply(process.stdout, arguments);
            };
        })(process.stdout.write) as any;

        // should log cli app help
        try {
            RainSolverCmd.parse(["", "", "-h"]).opts();
        } catch {
            expect(stdoutText).toContain(
                "Node.js app that solves (clears) Rain Orderbook orders against onchain",
            );
            stdoutText = "";
        }

        // should log app version
        try {
            RainSolverCmd.parse(["", "", "-V"]).opts();
        } catch {
            expect(stdoutText).toContain(require("../../../package.json").version);
        }

        // set original stdout write fn back
        process.stdout.write = orgStdout;
    });
});
