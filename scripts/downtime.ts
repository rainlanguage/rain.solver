/* eslint-disable no-console */
import axios from "axios";
import { config } from "dotenv";
import { Result } from "../src/common";
import { errorSnapshot } from "../src/error";
import { headers, SgTrade, SgTransaction } from "../src/subgraph";
import { DEFAULT_PAGE_SIZE, getTxsQuery } from "../src/subgraph/query";

config();

const DURATION = process.env.DURATION ? parseInt(process.env.DURATION) : 7; // 7 days default
const THRESHOLD = (process.env.THRESHOLD ? parseInt(process.env.THRESHOLD) : 60) * 60 * 1000; // 60 minutes default

const subgraphs = JSON.parse(process.env.SUBGRAPHS ?? "{}") as Record<string, string>;
const subgraphList = Object.keys(subgraphs);

// set start and end timestamps
const endTimestamp = Math.floor(Date.now() / 1000) * 1000; // round to nearest second
const startTimestamp = endTimestamp - DURATION * 24 * 60 * 60 * 1000;

type ErrResponse = { error: any; url: string; chain: string };
type OkResponse = { events: SgTransaction[]; url: string; chain: string };

// query orderbook tx events from subgraph
async function queryEvents() {
    // convert to seconds timestamp for subgraph query
    const startTimeSec = Math.floor(startTimestamp / 1000);
    const endTimeSec = Math.floor(endTimestamp / 1000);

    // concurrently fetch events from all subgraphs
    const promises = subgraphList.map(async (url) => {
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
                return Result.err({ error: err, url, chain: subgraphs[url] }) as Result<
                    OkResponse,
                    ErrResponse
                >;
            }
        }
        return Result.ok({ events, url, chain: subgraphs[url] }) as Result<OkResponse, ErrResponse>;
    });

    return await Promise.all(promises);
}

// process trade events to capture downtime
function captureDowntime(subgraphEvents: SgTransaction[]) {
    let totalDowntime = 0;
    let downtimeOccurrences = 0;

    const length = Math.floor((endTimestamp - startTimestamp) / THRESHOLD);
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

    // process trade events into cycles
    for (const { event, timestamp } of iterEvents()) {
        if (event.__typename === "Clear" || event.__typename === "TakeOrder") {
            event?.trades?.forEach((trade) => {
                const index = Math.floor((timestamp - startTimestamp) / THRESHOLD);
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
            const cycleGapTime = nextCycleWithTradeIndex * THRESHOLD;
            const offsetTime =
                (cycles[nextCycleWithTradeIndex + i + 1][0].timestamp - startTimestamp) % THRESHOLD;
            totalDowntime += cycleGapTime + offsetTime;
        } else {
            // if there are no trades after this cycle, assume full downtime from start of the next cycle to the end of the period
            totalDowntime += endTimestamp - ((i + 1) * THRESHOLD + startTimestamp);
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
) {
    const fromDate = new Date(startTimestamp).toUTCString();
    const toDate = new Date(endTimestamp).toUTCString();

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
        `🔴 <b>${DURATION === 7 ? "Weekly" : ""} Downtime Report</b>`,
        "",
        `📅 <b>Period:</b> ${fromDate}  to  ${toDate} (${DURATION} days)`,
        `🔗 <b>Chain:</b> ${chain}`,
        `⏳ <b>Downtime Threshold:</b> ${THRESHOLD / 60_000} minutes`,
        `⏱️ <b>Total Downtime Duration:</b> ${formattedDowntime}`,
        `🔁 <b>Downtime Occurrences:</b> ${downtimeOccurrences}`,
        `📊 <b>Downtime Percentage:</b> ${((totalDowntime / (endTimestamp - startTimestamp - THRESHOLD)) * 100).toFixed(2)}%`,
        `🌐 <b>Subgraph URL:</b> ${url}`,
    ];

    return msg.join("\n").trim();
}

// send report to Telegram
async function sendToTelegram(text: string) {
    const url = `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`;
    await axios.post(url, {
        text,
        parse_mode: "HTML",
        chat_id: process.env.TG_CHAT_ID,
    });
}

// main entrypoint
async function main() {
    const results = await queryEvents();
    for (const result of results) {
        if (result.isOk()) {
            const { totalDowntime, downtimeOccurrences } = captureDowntime(result.value.events);
            await sendToTelegram(
                buildReport(
                    result.value.url,
                    result.value.chain,
                    totalDowntime,
                    downtimeOccurrences,
                ),
            );
        } else {
            await sendToTelegram(
                [
                    `Downtime report failed for chain "${result.error.chain}" with subgraph url ${result.error.url}, reason:`,
                    `${result.error.error}`,
                ].join("\n"),
            );
        }
    }
}

// run the main function
main()
    .then(() => console.log("\x1b[32m%s\x1b[0m", "Downtime report process completed successfully!"))
    .catch((error) =>
        console.error(
            "\x1b[31m%s\x1b[0m",
            "An error occurred during downtime report process:",
            error,
        ),
    );
