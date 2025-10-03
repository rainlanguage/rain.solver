import { SweepCmd } from "./sweep";
import { describe, it, expect } from "vitest";

describe("Test sweep cli options", () => {
    it("should get sweep cli options", async function () {
        // overwrite the action for testing
        SweepCmd.action(function () {});

        const expected: Record<string, any> = {
            mnemonic: "phrase",
            subgraph: ["http://sg1.com"],
            rpc: ["http://rpc.com"],
            length: 100,
            token: [
                { address: "0x123", symbol: "SYM", decimals: 18 },
                { address: "0x456", symbol: "SYM2", decimals: 6 },
            ],
            gasConversion: false,
        };
        const result = SweepCmd.parse([
            "",
            "",
            "--mnemonic",
            "phrase",
            "--subgraph",
            "http://sg1.com",
            "--rpc",
            "http://rpc.com",
            "--length",
            "100",
            "--token",
            "0x123,SYM,18",
            "-t",
            "0x456,SYM2,6",
            "--no-gas-conversion",
        ]).opts();
        expect(result).toEqual(expected);

        // unknown flag should throw
        expect(() => SweepCmd.parse(["", "", "-a"]).opts()).toThrow(
            'process.exit unexpectedly called with "1"',
        );
    });
});
