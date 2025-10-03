import axios from "axios";
import { queryEvents } from "./downtime";
import { errorSnapshot } from "../../error";
import { getTxsQuery } from "../../subgraph/query";
import { headers, SgTransaction } from "../../subgraph";
import { DowntimeCmd, captureDowntime } from "./downtime";
import { describe, it, expect, vi, beforeEach, assert, Mock } from "vitest";

// mock dependencies
vi.mock("axios");
vi.mock("../../error", () => ({
    errorSnapshot: vi.fn(),
}));
vi.mock("../../subgraph/query", async (importOriginal) => ({
    ...(await importOriginal()),
    getTxsQuery: vi.fn(),
}));

describe("Test downtime cli options", () => {
    it("should get downtime cli options with console only", async function () {
        // overwrite the action for testing
        DowntimeCmd.action(function () {});

        // with console only
        let expected: Record<string, any> = {
            duration: 3,
            threshold: 20 * 60 * 1000,
            subgraphs: {
                "http://sg1.com": "flare",
                "http://sg2.com": "base",
                "http://sg3.com": "eth",
            },
            console: true,
        };
        let result = DowntimeCmd.parse([
            "",
            "",
            "--subgraphs",
            "flare=http://sg1.com",
            "-s",
            "base=http://sg2.com",
            "-s",
            "eth=http://sg3.com",
            "-d",
            "3",
            "-t",
            "20",
        ]).opts();
        expect(result).toEqual(expected);

        // with telegram only
        expected = {
            duration: 3,
            threshold: 20 * 60 * 1000,
            subgraphs: {
                "http://sg1.com": "flare",
                "http://sg2.com": "base",
                "http://sg3.com": "eth",
            },
            telegram: true,
            telegramChatId: "ID",
            telegramApiToken: "TOKEN",
            console: false,
        };
        result = DowntimeCmd.parse([
            "",
            "",
            "--subgraphs",
            "flare=http://sg1.com",
            "-s",
            "base=http://sg2.com",
            "-s",
            "eth=http://sg3.com",
            "-d",
            "3",
            "--threshold",
            "20",
            "--telegram-chat-id",
            "ID",
            "--telegram-api-token",
            "TOKEN",
            "--no-console",
        ]).opts();

        // unknown flag should throw
        expect(() => DowntimeCmd.parse(["", "", "-a"]).opts()).toThrow(
            'process.exit unexpectedly called with "1"',
        );
    });
});

describe("queryEvents", () => {
    const mockOptions = {
        duration: 7,
        threshold: 60 * 60 * 1000,
        subgraphs: {
            "https://subgraph1.com": "chain1",
            "https://subgraph2.com": "chain2",
        },
        console: true,
        endTimestamp: 1000000000, // 1 billion ms
        startTimestamp: 900000000, // 900 million ms
        subgraphList: ["https://subgraph1.com", "https://subgraph2.com"],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        (getTxsQuery as Mock).mockReturnValue("mock query");
    });

    it("should call axios.post with correct parameters for each subgraph", async () => {
        const mockTransactions = [{ id: "tx1" }, { id: "tx2" }];
        (axios.post as Mock).mockResolvedValue({
            data: {
                data: {
                    transactions: mockTransactions,
                },
            },
        });

        await queryEvents(mockOptions);

        expect(axios.post).toHaveBeenCalledTimes(2);
        expect(axios.post).toHaveBeenNthCalledWith(
            1,
            "https://subgraph1.com",
            { query: "mock query" },
            { headers },
        );
        expect(axios.post).toHaveBeenNthCalledWith(
            2,
            "https://subgraph2.com",
            { query: "mock query" },
            { headers },
        );
    });

    it("should call getTxsQuery with correct timestamp parameters", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: { transactions: [] } },
        });

        await queryEvents(mockOptions);

        const expectedStartSec = Math.floor(mockOptions.startTimestamp / 1000);
        const expectedEndSec = Math.floor(mockOptions.endTimestamp / 1000);
        expect(getTxsQuery).toHaveBeenCalledWith(expectedStartSec, 0, expectedEndSec);
    });

    it("should return Ok result with events when request succeeds", async () => {
        const mockTransactions = [{ id: "tx1" }, { id: "tx2" }];
        (axios.post as Mock).mockResolvedValue({
            data: { data: { transactions: mockTransactions } },
        });

        const results = await queryEvents({
            ...mockOptions,
            subgraphList: ["https://subgraph1.com"],
        });

        expect(results).toHaveLength(1);
        assert(results[0].isOk());
        expect(results[0].value).toEqual({
            events: mockTransactions,
            url: "https://subgraph1.com",
            chain: "chain1",
        });
    });

    it("should return Err result when axios request fails", async () => {
        const mockError = new Error("Network error");
        (axios.post as Mock).mockRejectedValue(mockError);
        (errorSnapshot as Mock).mockResolvedValue("error snapshot");

        const results = await queryEvents({
            ...mockOptions,
            subgraphList: ["https://subgraph1.com"],
        });

        expect(results).toHaveLength(1);
        assert(results[0].isErr());
        expect(results[0].error).toEqual({
            error: "error snapshot",
            url: "https://subgraph1.com",
            chain: "chain1",
        });
    });

    it("should return Err result when response has invalid data structure", async () => {
        (axios.post as Mock).mockResolvedValue({
            data: { data: {} }, // Missing transactions field
        });
        (errorSnapshot as Mock).mockResolvedValue("error snapshot");

        const results = await queryEvents({
            ...mockOptions,
            subgraphList: ["https://subgraph1.com"],
        });

        expect(results[0].isOk()).toBe(false);
        expect(errorSnapshot).toHaveBeenCalledWith(
            "Failed to fetch events",
            "Received invalid response from subgraph",
        );
    });
});

describe("Test captureDowntime", () => {
    const baseOptions = {
        duration: 7,
        threshold: 60 * 60 * 1000, // 1 hour in ms
        subgraphs: { url1: "chain1" },
        console: true,
        endTimestamp: 1000000000, // 1 billion ms
        startTimestamp: 900000000, // 900 million ms (100 million ms duration)
        subgraphList: ["url1"],
    };

    it("should return zero downtime when there are trades in all cycles", () => {
        const opts = {
            ...baseOptions,
            endTimestamp: 1000000, // 1000 s
            startTimestamp: 900000, // 900 s
            threshold: 50 * 1000, // 50 seconds
        };
        const events: SgTransaction[] = [
            {
                timestamp: "900", // at 900 seconds
                events: [{ __typename: "Clear", trades: [{ id: "trade1" }] }],
            },
            {
                timestamp: "940", // at 940 seconds
                events: [{ __typename: "TakeOrder", trades: [{ id: "trade2" }] }],
            },
            {
                timestamp: "990", // at 990 seconds
                events: [{ __typename: "Clear", trades: [{ id: "trade3" }] }],
            },
        ] as any;

        const result = captureDowntime(events, opts);

        expect(result.totalDowntime).toBe(0);
        expect(result.downtimeOccurrences).toBe(0);
    });

    it("should calculate downtime correctly when there are no trades", () => {
        const events: SgTransaction[] = [];

        const result = captureDowntime(events, baseOptions);

        // Should count all cycles as downtime (100 million ms / 3.6 million ms per hour = ~27.77 cycles)
        const expectedCycles = Math.floor(
            (baseOptions.endTimestamp - baseOptions.startTimestamp) / baseOptions.threshold,
        );

        expect(result.downtimeOccurrences).toBe(expectedCycles);
        expect(result.totalDowntime).toBeGreaterThan(0);
    });

    it("should calculate downtime for gaps between trades", () => {
        const events: SgTransaction[] = [
            {
                timestamp: "900000", // Start of first cycle
                events: [{ __typename: "Clear", trades: [{ id: "trade1" }] }],
            },
            {
                timestamp: "970000", // Much later - creates gap
                events: [{ __typename: "TakeOrder", trades: [{ id: "trade2" }] }],
            },
        ] as any;

        const result = captureDowntime(events, baseOptions);

        expect(result.totalDowntime).toBeGreaterThan(0);
        expect(result.downtimeOccurrences).toBeGreaterThan(0);
    });

    it("should only process Clear and TakeOrder events", () => {
        const events: SgTransaction[] = [
            {
                timestamp: "900000",
                events: [{ __typename: "Clear", trades: [{ id: "trade1" }] }],
            },
            {
                timestamp: "950000",
                events: [{ __typename: "Withdraw" }],
            },
        ] as any;

        const result = captureDowntime(events, baseOptions);

        // Should only count the Clear event, not the other event type
        expect(result.downtimeOccurrences).toBeGreaterThan(0);
    });

    it("should handle multiple trades in single event correctly", () => {
        const events: SgTransaction[] = [
            {
                timestamp: "900000",
                events: [
                    {
                        __typename: "Clear",
                        trades: [{ id: "trade1" }, { id: "trade2" }, { id: "trade3" }],
                    },
                ],
            },
        ] as any;

        const result = captureDowntime(events, baseOptions);

        // Multiple trades in same cycle should still count as activity
        expect(result.totalDowntime).toBeGreaterThan(0); // Still downtime in other cycles
        expect(result.downtimeOccurrences).toBeGreaterThan(0);
    });
});
