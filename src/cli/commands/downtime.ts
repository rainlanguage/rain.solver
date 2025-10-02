/* eslint-disable no-console */
import axios from "axios";
import assert from "assert";
import { Result } from "../../common";
import { Command, Option } from "commander";
import { errorSnapshot } from "../../error";
import { headers, SgTrade, SgTransaction } from "../../subgraph";
import { DEFAULT_PAGE_SIZE, getTxsQuery } from "../../subgraph/query";

export type DowntimeOptions = {
    duration: number; // in days
    threshold: number; // in milliseconds
    subgraphs: Record<string, string>;
    output: "telegram" | "console" | "both";
    telegramChatId?: string;
    telegramApiToken?: string;
};

/** Command-line interface for the downtime script */
export const DowntimeCmd = new Command("downtime")
    .addOption(
        new Option(
            "-s, --subgraphs <chain=url...>",
            "List of subgraph URLs paired with their chain names as cli arg or json object via env var",
        )
            .env("SUBGRAPHS")
            .argParser(
                (
                    chainSg: string,
                    previous: Record<string, string> = {},
                ): Record<string, string> => {
                    try {
                        return JSON.parse(chainSg);
                    } catch {}
                    const parts = chainSg.split("=");
                    assert(
                        parts.length === 2,
                        "Subgraph details must be in the format of: chain=url",
                    );
                    const [chain, url] = parts;
                    return { ...previous, [url]: chain };
                },
            ),
    )
    .addOption(
        new Option("-d, --duration <integer>", "Timespan (in days) to prepare downtime report for")
            .env("DURATION")
            .argParser((val: string) => parseInteger(val, "--duration"))
            .default(7, "7 days"),
    )
    .addOption(
        new Option(
            "-t, --threshold <integer>",
            "Downtime threshold in minutes, any period without trades longer than this will be counted as downtime",
        )
            .env("THRESHOLD")
            .argParser((val: string) => parseInteger(val, "--threshold") * 60 * 1000)
            .default(60 * 60 * 1000, "60 minutes"),
    )
    .addOption(
        new Option("--telegram-chat-id <id>", "Telegram chat ID to send the report to")
            .env("TG_CHAT_ID")
            .implies({ output: "both" }),
    )
    .addOption(
        new Option("--telegram-api-token <key>", "Telegram API token")
            .env("TG_TOKEN")
            .implies({ output: "both" }),
    )
    .addOption(
        new Option("--no-console", "Disable logging the report in console").implies({
            output: "telegram",
        }),
    )
    .description(
        "Calculates and reports downtime based on trades recorded in the given subgraphs over the specified duration and threshold",
    )
    .action(async (options) => {
        await main(options);
        console.log("\n");
        console.log("\x1b[32m%s\x1b[0m", "Downtime report process completed successfully!");
    });

export type DowntimeOptionsExtended = DowntimeOptions & {
    endTimestamp: number;
    startTimestamp: number;
    subgraphList: string[];
};

type ErrResponse = { error: any; url: string; chain: string };
type OkResponse = { events: SgTransaction[]; url: string; chain: string };

// query orderbook tx events from subgraph
async function queryEvents(options: DowntimeOptionsExtended) {
    // convert to seconds timestamp for subgraph query
    const startTimeSec = Math.floor(options.startTimestamp / 1000);
    const endTimeSec = Math.floor(options.endTimestamp / 1000);

    // concurrently fetch events from all subgraphs
    const promises = options.subgraphList.map(async (url) => {
        let skip = 0;
        const events: SgTransaction[] = [];
        for (;;) {
            try {
                const res = await axios.post(
                    url,
                    { query: getTxsQuery(startTimeSec, skip, endTimeSec) },
                    { headers },
                );
                if (typeof res?.data?.data?.transactions !== "undefined") {
                    const txs = res.data.data.transactions;
                    skip += txs.length;
                    events.push(...txs);
                    if (txs.length < DEFAULT_PAGE_SIZE) {
                        break;
                    }
                } else {
                    throw "Received invalid response from subgraph";
                }
            } catch (error: any) {
                const err = await errorSnapshot("Failed to fetch events", error);
                return Result.err({ error: err, url, chain: options.subgraphs[url] }) as Result<
                    OkResponse,
                    ErrResponse
                >;
            }
        }
        return Result.ok({ events, url, chain: options.subgraphs[url] }) as Result<
            OkResponse,
            ErrResponse
        >;
    });

    return await Promise.all(promises);
}

// process trade events to capture downtime
function captureDowntime(subgraphEvents: SgTransaction[], options: DowntimeOptionsExtended) {
    let totalDowntime = 0;
    let downtimeOccurrences = 0;

    const length = Math.floor((options.endTimestamp - options.startTimestamp) / options.threshold);
    const cycles: Array<{ trade: SgTrade; timestamp: number }[]> = [];
    for (let i = 0; i < length; i++) {
        cycles.push([]);
    }

    // helper fn to iterate over events
    const iterEvents = function* () {
        for (const res of subgraphEvents) {
            if (!res?.events?.length) continue;
            for (const event of res.events) {
                yield { event, timestamp: Number(res.timestamp) * 1000 };
            }
        }
    };

    // process trade events into threshold cycles by their timestamps
    // as each trade can only go into an specific cycle period
    for (const { event, timestamp } of iterEvents()) {
        if (event.__typename === "Clear" || event.__typename === "TakeOrder") {
            event?.trades?.forEach((trade) => {
                const index = Math.floor((timestamp - options.startTimestamp) / options.threshold);
                cycles[index]?.push({ trade, timestamp });
            });
        }
    }

    // capture downtime
    for (let i = 0; i < cycles.length; i++) {
        if (cycles[i].length > 0) continue; // skip cycles that has trades
        downtimeOccurrences++;
        if (i === cycles.length - 1) break;

        // calculate downtime until the very next trade
        const followingCycles = cycles.slice(i + 1);
        const nextCycleWithTradeIndex = followingCycles.findIndex((cycle) => cycle.length > 0);
        if (nextCycleWithTradeIndex > -1) {
            const fullCycleGapTime = nextCycleWithTradeIndex * options.threshold;
            const offsetTime =
                (cycles[nextCycleWithTradeIndex + i + 1][0].timestamp - options.startTimestamp) %
                options.threshold;
            totalDowntime += fullCycleGapTime + offsetTime;
            downtimeOccurrences += nextCycleWithTradeIndex; // count all cycles until the next trade as downtime occurrences
            i += nextCycleWithTradeIndex; // skip to the next cycle with trades
        } else {
            // if there are no trades after this cycle, assume full downtime from start of the next cycle to the end of the period
            totalDowntime +=
                options.endTimestamp - ((i + 1) * options.threshold + options.startTimestamp);
            downtimeOccurrences += cycles.length - i - 1; // count all remaining cycles as downtime occurrences
            break; // no need to check further cycles
        }
    }

    return { totalDowntime, downtimeOccurrences };
}

// build report msg
function buildReport(
    url: string,
    chain: string,
    totalDowntime: number,
    downtimeOccurrences: number,
    options: DowntimeOptionsExtended,
) {
    const fromDate = new Date(options.startTimestamp).toUTCString();
    const toDate = new Date(options.endTimestamp).toUTCString();

    // format total downtime duration
    const remainingAfterDays = totalDowntime % 86_400_000;
    const remainingAfterHours = remainingAfterDays % 3_600_000;
    const downtimeDays = Math.floor(totalDowntime / 86_400_000);
    const downtimeHours = Math.floor(remainingAfterDays / 3_600_000);
    const downtimeMinutes = Math.floor(remainingAfterHours / 60_000);
    const downtimeSeconds = Math.floor((remainingAfterHours % 60_000) / 1000);
    const formattedDowntimeDays =
        downtimeDays > 0 ? `${downtimeDays} ${downtimeDays === 1 ? "day" : "days"}` : "";
    const formattedDowntimeHours =
        downtimeHours > 0 ? `${downtimeHours} ${downtimeHours === 1 ? "hour" : "hours"}` : "";
    const formattedDowntimeSeconds =
        downtimeSeconds > 0
            ? `${downtimeSeconds} ${downtimeSeconds === 1 ? "second" : "seconds"}`
            : "";
    const formattedDowntimeMinutes =
        downtimeMinutes > 0
            ? `${downtimeMinutes} ${downtimeMinutes === 1 ? "minute" : "minutes"}`
            : "";
    const formattedDowntime = [
        formattedDowntimeDays,
        formattedDowntimeHours,
        formattedDowntimeMinutes,
        formattedDowntimeSeconds,
    ]
        .filter(Boolean)
        .join(" and ");

    const msg = [
        `🔴 <b>${options.duration === 7 ? "Weekly" : ""} Downtime Report</b>`,
        "",
        `📅 <b>Period:</b> ${fromDate}  to  ${toDate} (${options.duration} days)`,
        `🔗 <b>Chain:</b> ${chain}`,
        `⏳ <b>Downtime Threshold:</b> ${options.threshold / 60_000} minutes`,
        `⏱️ <b>Total Downtime Duration:</b> ${formattedDowntime || "0 seconds"}`,
        `🔁 <b>Downtime Occurrences:</b> ${downtimeOccurrences}`,
        `📊 <b>Downtime Percentage:</b> ${((totalDowntime / (options.endTimestamp - options.startTimestamp - options.threshold)) * 100).toFixed(2)}%`,
        `🌐 <b>Subgraph URL:</b> ${url}`,
    ];

    return msg.join("\n").trim();
}

// send report to Telegram
async function sendToTelegram(text: string, id: string, token: string) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
        text,
        parse_mode: "HTML",
        chat_id: id,
    });
}

function parseInteger(value: any, argName?: string): number {
    const parsed = parseInt(value);
    assert(
        !isNaN(parsed),
        `Expected integer value ${argName ? `for "${argName}"` : ""}, got: ${value}`,
    );
    return parsed;
}

// main entrypoint
export async function main(options: DowntimeOptions) {
    // set start and end timestamps
    const endTimestamp = Math.floor(Date.now() / 1000) * 1000; // round to nearest second
    const startTimestamp = endTimestamp - options.duration * 24 * 60 * 60 * 1000;
    const subgraphList = Object.keys(options.subgraphs);
    const extendedOptions: DowntimeOptionsExtended = {
        ...options,
        endTimestamp,
        startTimestamp,
        subgraphList,
    };

    if (options.output === "telegram" || options.output === "both") {
        assert(options.telegramChatId, "Telegram chat ID is required for Telegram output");
        assert(options.telegramApiToken, "Telegram API token is required for Telegram output");
    }

    if (subgraphList.length === 0) {
        throw new Error("No subgraphs provided, please provide at least one subgraph to proceed");
    }

    const results = await queryEvents(extendedOptions);
    for (const result of results) {
        if (result.isOk()) {
            const { totalDowntime, downtimeOccurrences } = captureDowntime(
                result.value.events,
                extendedOptions,
            );
            const report = buildReport(
                result.value.url,
                result.value.chain,
                totalDowntime,
                downtimeOccurrences,
                extendedOptions,
            );

            if (options.output === "console" || options.output === "both") {
                console.log(report.replaceAll("<b>", "").replaceAll("</b>", ""));
                console.log("-----------------------------------------------------\n");
            }
            if (options.output === "telegram" || options.output === "both") {
                await sendToTelegram(report, options.telegramChatId!, options.telegramApiToken!);
            }
        } else {
            const msg = [
                `Downtime report failed for chain "${result.error.chain}" with subgraph url ${result.error.url}, reason:`,
                `${result.error.error}`,
            ].join("\n");

            if (options.output === "console" || options.output === "both") {
                console.log(msg);
            }
            if (options.output === "telegram" || options.output === "both") {
                await sendToTelegram(msg, options.telegramChatId!, options.telegramApiToken!);
            }
        }
    }
}
