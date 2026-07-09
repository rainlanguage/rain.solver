import { parseEventLogs, parseUnits } from "viem";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getIncome, getActualClearAmount, getActualPrice, getTotalIncome } from "./log";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    parseEventLogs: vi.fn(),
    formatUnits: vi.fn((value, decimals) => `${value.toString()}_${decimals}`),
    parseUnits: vi.fn((value, decimals) => BigInt(Number(value) * 10 ** decimals)),
}));

describe("Test log functions", async () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("Test getIncome", () => {
        it("should return value when matching Transfer log is found", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    address: "0xToken",
                    args: {
                        to: "0xMe",
                        value: 123n,
                    },
                } as any,
            ]);
            const result = getIncome("0xMe", { logs: [] } as any, "0xToken");
            expect(result).toBe(123n);
        });

        it("should return undefined if no matching log", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    address: "0xOtherToken",
                    args: {
                        to: "0xOther",
                        value: 123n,
                    },
                } as any,
            ]);
            const result = getIncome("0xMe", { logs: [] } as any, "0xToken");
            expect(result).toBeUndefined();
        });

        it("should return undefined if parseEventLogs throws", () => {
            vi.mocked(parseEventLogs).mockImplementation(() => {
                throw new Error("fail");
            });
            const result = getIncome("0xMe", { logs: [] } as any, "0xToken");
            expect(result).toBeUndefined();
        });
    });

    describe("Test getActualClearAmount", () => {
        it("should return value from Transfer log when to != ob", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    args: {
                        to: "0xTo",
                        from: "0xOb",
                        value: 555n,
                    },
                } as any,
            ]);
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any, 18);
            expect(result).toBe(555n);
        });

        it("should return undefined if no matching Transfer log", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    args: {
                        to: "0xOther",
                        from: "0xOb",
                        value: 555n,
                    },
                } as any,
            ]);
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any, 18);
            expect(result).toBeUndefined();
        });

        it("should return value from AfterClear log when to == ob", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "AfterClear",
                    args: {
                        clearStateChange: {
                            aliceOutput: 999n,
                        },
                    },
                } as any,
            ]);
            const result = getActualClearAmount("0xOb", "0xOb", { logs: [] } as any, 18);
            expect(result).toBe(999n);
        });

        it("should return value from AfterClearV2 log when to == ob", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "AfterClearV2",
                    args: {
                        clearStateChange: {
                            aliceOutput:
                                "0xffffffee000000000000000000000000000000000000000000000000000003e7",
                        },
                    },
                } as any,
            ]);
            const result = getActualClearAmount("0xOb", "0xOb", { logs: [] } as any, 18);
            expect(result).toBe(999n);
        });

        it("should return undefined when AfterClearV2 aliceOutput cannot be normalized", () => {
            // an unparsable float hex makes normalizeFloat return an Err,
            // so the normalize-failure branch is taken and undefined is returned
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "AfterClearV2",
                    args: {
                        clearStateChange: {
                            aliceOutput: "0x00",
                        },
                    },
                } as any,
            ]);
            const result = getActualClearAmount("0xOb", "0xOb", { logs: [] } as any, 18);
            expect(result).toBeUndefined();
        });

        it("should return undefined if parseEventLogs throws", () => {
            vi.mocked(parseEventLogs).mockImplementation(() => {
                throw new Error("fail");
            });
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any, 18);
            expect(result).toBeUndefined();
        });
    });

    describe("Test getActualPrice", () => {
        it("should return formatted price if matching Transfer log found", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    args: {
                        to: "0xArb",
                        from: "0xOther",
                        value: 1000n,
                    },
                } as any,
            ]);
            const result = getActualPrice({ logs: [] } as any, "0xOrderbook", "0xArb", "10", 18);
            expect(result).toContain("_18");
            // price = (scaleTo18(1000n, 18) * ONE18) / 10n, formatted at 18 decimals
            // = (1000n * 1e18) / 10n = 1e20 -> mocked formatUnits => "1e20_18"
            expect(result).toBe("100000000000000000000_18");
        });

        it("should scale the transferred value by the token decimals when computing price", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    args: {
                        to: "0xArb",
                        from: "0xOther",
                        value: 1000n,
                    },
                } as any,
            ]);
            // tokenDecimals = 6 (non-18) so the scaleTo18 decimals arg is exercised:
            // price = (scaleTo18(1000n, 6) * ONE18) / 10n
            //       = (1000n * 1e12 * 1e18) / 10n = 1e33 / 10n = 1e32
            // -> mocked formatUnits => "1e32_18"; a value that ignores tokenDecimals differs
            const result = getActualPrice({ logs: [] } as any, "0xOrderbook", "0xArb", "10", 6);
            expect(result).toBe("100000000000000000000000000000000_18");
        });

        it("should return undefined if no matching log", () => {
            vi.mocked(parseEventLogs).mockReturnValue([
                {
                    eventName: "Transfer",
                    args: {
                        to: "0xOther",
                        from: "0xOrderbook",
                        value: 1000n,
                    },
                } as any,
            ]);
            const result = getActualPrice({ logs: [] } as any, "0xOrderbook", "0xArb", "10", 18);
            expect(result).toBeUndefined();
        });

        it("should return undefined if parseEventLogs throws", () => {
            vi.mocked(parseEventLogs).mockImplementation(() => {
                throw new Error("fail");
            });
            const result = getActualPrice({ logs: [] } as any, "0xOrderbook", "0xArb", "10", 18);
            expect(result).toBeUndefined();
        });
    });

    describe("Test getTotalIncome", () => {
        beforeEach(() => {
            vi.mocked(parseUnits).mockImplementation((value, decimals) =>
                BigInt(Number(value) * 10 ** decimals),
            );
        });

        it("should return undefined if both incomes are undefined", () => {
            expect(getTotalIncome(undefined, undefined, "1", "1", 18, 18)).toBeUndefined();
        });

        it("should calculate total income for input only", () => {
            const result = getTotalIncome(2n, undefined, "2", "1", 18, 18);
            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
            // input only: (parseUnits("2",18) * scaleTo18(2n,18)) / ONE18
            // = (2e18 * 2n) / 1e18 = 4n; output branch contributes 0
            expect(result).toBe(4n);
        });

        it("should calculate total income for output only", () => {
            const result = getTotalIncome(undefined, 3n, "1", "3", 18, 18);
            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
            // output only: (parseUnits("3",18) * scaleTo18(3n,18)) / ONE18
            // = (3e18 * 3n) / 1e18 = 9n; input branch contributes 0
            expect(result).toBe(9n);
        });

        it("should calculate total income for both input and output", () => {
            const result = getTotalIncome(2n, 3n, "2", "3", 18, 18);
            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
            // input: (2e18 * 2n)/1e18 = 4n ; output: (3e18 * 3n)/1e18 = 9n ; sum = 13n
            expect(result).toBe(13n);
        });

        it("should pair each income with its own token price (not swapped)", () => {
            // distinct prices AND distinct incomes so a swap of price<->income
            // between the input and output branches changes the exact result.
            // input: (parseUnits("2",18) * scaleTo18(2n,18)) / ONE18 = (2e18 * 2n)/1e18 = 4n
            // output: (parseUnits("5",18) * scaleTo18(3n,18)) / ONE18 = (5e18 * 3n)/1e18 = 15n
            // sum = 19n ; pairing the input income with the output price instead yields 25n
            const result = getTotalIncome(2n, 3n, "2", "5", 18, 18);
            expect(result).toBe(19n);
        });
    });
});
