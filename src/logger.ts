import { sleep } from "./utils";
import { Resource } from "@opentelemetry/resources";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
    BasicTracerProvider,
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
    Span,
    diag,
    trace,
    Tracer,
    context,
    Context,
    SpanOptions,
    DiagLogLevel,
    DiagConsoleLogger,
} from "@opentelemetry/api";

/**
 * Represents a container for an OpenTelemetry span and its associated context.
 * This class is useful for passing both the span and its context together, which
 * is often required when working with OpenTelemetry tracing APIs.
 */
export type SpanWithContext = {
    readonly span: Span;
    readonly context: Context;
};

/**
 * RainSolverLogger sets up OpenTelemetry tracing for the RainSolver service.
 *
 * This class configures a tracer provider with either a remote OTLP exporter
 * or a console exporter for local development. It exposes a method to start
 * new spans for tracing operations within the application.
 *
 * @remarks
 * - Uses OpenTelemetry SDK for Node.js.
 * - Supports exporting traces to HyperDX if the API key is provided.
 * - Automatically configures the service name from the `TRACER_SERVICE_NAME`
 * environment variable or defaults to "rain-solver".
 */
export class RainSolverLogger {
    tracer: Tracer;
    exporter: OTLPTraceExporter | ConsoleSpanExporter;

    constructor() {
        // enable diag
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

        const provider = new BasicTracerProvider({
            resource: new Resource({
                [SEMRESATTRS_SERVICE_NAME]: process?.env?.TRACER_SERVICE_NAME ?? "rain-solver",
            }),
        });

        if (process.env.HYPERDX_API_KEY) {
            const exporter = new OTLPTraceExporter({
                url: "https://in-otel.hyperdx.io/v1/traces",
                headers: {
                    authorization: process?.env?.HYPERDX_API_KEY,
                },
                compression: CompressionAlgorithm.GZIP,
            });
            this.exporter = exporter;
            provider.addSpanProcessor(new BatchSpanProcessor(exporter));
        } else {
            const consoleExporter = new ConsoleSpanExporter();
            this.exporter = consoleExporter;
            provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));
        }

        // register the tracer
        provider.register();
        this.tracer = provider.getTracer("rain-solver-tracer");
    }

    /**
     * A wrapper for otel startSpan that starts a new otel span that collects scoped
     * data during runtime that makes it easy to work with otel api as part of this class
     * @param name - The span name
     * @param options - Span initial options
     * @param ctx - Context to set this span on
     */
    startSpan(name: string, options?: SpanOptions, ctx?: Context): SpanWithContext {
        return this.setSpanContext(this.tracer.startSpan(name, options, ctx));
    }

    /**
     * A wrapper for otel setSapn which sets the given span on the active context and returns
     * SpanWithContext instance, this makes it easy to work with otel api as part of this class
     * @param span - The span
     */
    setSpanContext(span: Span): SpanWithContext {
        return { span, context: trace.setSpan(context.active(), span) };
    }

    /**
     * Closes the OTEL exporter connection.
     * This is not generally needed, it is just for graceful connection close
     */
    async shutdown() {
        // flush and close the connection
        await this.exporter.shutdown();
        await sleep(10000);
    }
}
