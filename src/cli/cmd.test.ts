import { cmd } from "./cmd";
import { describe, it, expect } from "vitest";

describe("Test cli options", () => {
    it("should get cli options", async function () {
        const expected: Record<string, any> = {
            config: "./config.yaml",
        };

        // default
        let result = await cmd(["", ""]);
        expect(result).toStrictEqual(expected);

        // default from env
        process.env.CONFIG = "path/to/env.config.yaml";
        result = await cmd(["", ""]);
        expected.config = "path/to/env.config.yaml";
        expect(result).toStrictEqual(expected);
        delete process.env.CONFIG;

        // -c flag
        result = await cmd(["", "", "-c", "path/to/config.yaml"]);
        expected.config = "path/to/config.yaml";
        expect(result).toStrictEqual(expected);

        // --config flag
        result = await cmd(["", "", "--config", "path/to/config.yaml"]);
        expected.config = "path/to/config.yaml";
        expect(result).toStrictEqual(expected);

        // unknown flag should throw
        await expect(() => cmd(["", "", "-a"])).rejects.toThrow(
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
            await cmd(["", "", "-h"]);
        } catch {
            expect(stdoutText).toContain(
                "Node.js app that solves (clears) Rain Orderbook orders against onchain",
            );
            stdoutText = "";
        }

        // should log app version
        try {
            await cmd(["", "", "-V"]);
        } catch {
            expect(stdoutText).toContain(require("../../package.json").version);
        }

        // set original stdout write fn back
        process.stdout.write = orgStdout;
    });
});
