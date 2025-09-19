import { describe, it, expect, vi, beforeEach } from "vitest";
import { getIncome, getActualClearAmount, getActualPrice, getTotalIncome } from "./log";
import { parseEventLogs, parseUnits } from "viem";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    parseEventLogs: vi.fn(),
    formatUnits: vi.fn((value, decimals) => `${value.toString()}_${decimals}`),
    parseUnits: vi.fn((value, decimals) => BigInt(Number(value) * 10 ** decimals)),
}));

describe("Test log functions", () => {
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
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any);
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
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any);
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
            const result = getActualClearAmount("0xOb", "0xOb", { logs: [] } as any);
            expect(result).toBe(999n);
        });

        it("should return undefined if parseEventLogs throws", () => {
            vi.mocked(parseEventLogs).mockImplementation(() => {
                throw new Error("fail");
            });
            const result = getActualClearAmount("0xTo", "0xOb", { logs: [] } as any);
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
        });

        it("should calculate total income for output only", () => {
            const result = getTotalIncome(undefined, 3n, "1", "3", 18, 18);
            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
        });

        it("should calculate total income for both input and output", () => {
            const result = getTotalIncome(2n, 3n, "2", "3", 18, 18);
            expect(typeof result).toBe("bigint");
            expect(result).toBeGreaterThan(0n);
        });
    });
});
