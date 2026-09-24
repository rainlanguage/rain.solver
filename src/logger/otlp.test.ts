import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { context, trace, propagation, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreAssembledSpan, RainSolverLogger } from ".";

describe("OTLP trace export", () => {
    beforeEach(() => {
        trace.disable();
        context.disable();
        propagation.disable();
        vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
        vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
        vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "");
        vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "");
        vi.stubEnv("TRACER_SERVICE_NAME", "base-bot");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        trace.disable();
        context.disable();
        propagation.disable();
    });

    it.each(["trace-specific", "generic"])(
        "exports queued diagnostics on shutdown using the %s endpoint",
        async (setting) => {
            const requests: { url?: string; encoding?: string; body: any }[] = [];
            const server = createServer(async (req, res) => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                requests.push({
                    url: req.url,
                    encoding: req.headers["content-encoding"],
                    body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()),
                });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end("{}");
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing server port");
            const base = `http://127.0.0.1:${address.port}/insert/opentelemetry`;
            if (setting === "trace-specific") {
                vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/unused");
                vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${base}/v1/traces`);
            } else {
                vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", base);
            }
            const logger = new RainSolverLogger();
            try {
                const child = new PreAssembledSpan("order")
                    .setAttr("order.id", "test-order")
                    .addEvent("quote", { duration: 12 })
                    .recordException("quote failed")
                    .setStatus({ code: SpanStatusCode.ERROR, message: "quote failed" })
                    .end();
                logger.exportPreAssembledSpan(new PreAssembledSpan("round").addChild(child).end());
                await logger.shutdown();
                expect(requests).toHaveLength(1);
                expect(requests[0].url).toBe("/insert/opentelemetry/v1/traces");
                expect(requests[0].encoding).toBe("gzip");
                const resource = requests[0].body.resourceSpans[0];
                expect(resource.resource.attributes).toContainEqual({
                    key: "service.name",
                    value: { stringValue: "base-bot" },
                });
                const spans = resource.scopeSpans[0].spans;
                const order = spans.find((span: any) => span.name === "order");
                const round = spans.find((span: any) => span.name === "round");
                expect(order.traceId).toBe(round.traceId);
                expect(order.parentSpanId).toBe(round.spanId);
                expect(order.attributes).toContainEqual({
                    key: "order.id",
                    value: { stringValue: "test-order" },
                });
                expect(order.events.map((event: any) => event.name)).toEqual([
                    "quote",
                    "exception",
                ]);
                expect(order.status.code).toBe(SpanStatusCode.ERROR);
            } finally {
                await logger.shutdown();
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
            }
        },
    );
});
