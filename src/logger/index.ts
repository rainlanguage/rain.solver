import { sleep } from "../common";
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
    TimeInput,
    Exception,
    SpanStatus,
    Attributes,
    SpanOptions,
    DiagLogLevel,
    AttributeValue,
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
     * A wrapper for otel setSpan which sets the given span on the active context and returns
     * SpanWithContext instance, this makes it easy to work with otel api as part of this class
     * @param span - The span
     */
    setSpanContext(span: Span): SpanWithContext {
        return { span, context: trace.setSpan(context.active(), span) };
    }

    /**
     * Exports a span (and any of its child spans) with all the given pre-assembled data, the
     * pre-assembled span can be exported at any point during the runtime, which eliminates the
     * need to use otel API and functionalities inline throughout the codebase for instrumentation
     * @param preAssembledSpan - The span data to export.
     * @param ctx - (Optional) The parent context to associate with the new span.
     */
    exportPreAssembledSpan(preAssembledSpan: PreAssembledSpan, ctx?: Context) {
        const {
            name,
            events,
            status,
            options,
            endTime,
            startTime,
            exception,
            children,
            attributes,
        } = preAssembledSpan;

        // start the span
        const { span, context: spanCtx } = this.startSpan(name, { ...options, startTime }, ctx);

        // handle child span if exists
        if (children.length) {
            for (const child of children) {
                this.exportPreAssembledSpan(child, spanCtx);
            }
        }

        // handle attrs
        if (Object.keys(attributes).length) {
            span.setAttributes(attributes);
        }
        // handle events
        if (events) {
            for (const event of events) {
                span.addEvent(event.name, event.attributes, event.startTime);
            }
        }
        // handle exception
        if (exception) {
            span.recordException(exception.exception, exception.time);
        }
        // handle span status
        if (status) {
            span.setStatus(status);
        }
        // end the span with the given end time
        span.end(endTime);
    }

    /**
     * Closes the OTEL exporter connection.
     * This is not generally needed, it is just for graceful connection close
     */
    async shutdown() {
        // flush and close the connection
        await this.exporter.shutdown();
        await sleep(3000);
    }
}

/**
 * Represents a pre-assembled OpenTelemetry span, encapsulating all relevant span data
 * including name, timing, status, attributes, events, exceptions, and nested spans.
 * This type allows span information to be collected and stored independently of inline
 * instrumentation for app's functions, enabling deferred export to an otel channel at
 * any point during runtime.
 * That means we wont need to use otel API and functionalities directly in a function's
 * body to instrument it, but rather we just gather these data and info and just export
 * it to otel whenever we want.
 * This also helps with unit testing, as using the otel API inline makes it nearly
 * impossible or at least very difficult and ugly to test the gathered data as the data
 * goes directly into otel scope and exported right away once span ends, however, with
 * having this obj type, the collected data can be part of a function return and asserted
 * in unit tests, while exporting them can take place somewhere totally separate.
 */
export class PreAssembledSpan {
    /** Span's name */
    name: string;
    /** Initial span options */
    options?: Omit<SpanOptions, "startTime">;
    /** A manually specified start time for this span */
    startTime?: TimeInput;
    /** A manually specified end time for this span */
    endTime?: TimeInput;
    /** The status of this span */
    status?: SpanStatus;
    /** Attributes associated with this span */
    attributes: Attributes = {};
    /** Exception details for this span */
    exception?: {
        exception: Exception;
        /** A manually specified time for the exception occurrence */
        time?: TimeInput;
    };
    /** Recorded events for this span */
    events: {
        /** The name of the event */
        name: string;
        /** Attributes associated with this event */
        attributes?: Attributes;
        /** Start time of the event */
        startTime?: TimeInput;
    }[] = [];
    /** Child spans of this span */
    children: PreAssembledSpan[] = [];

    /**
     * Creates a new empty instance
     * @param name - The span name
     * @param startTime - (optional) Start time of this span, defaults to now
     * @param options - (optional) Initial options
     */
    constructor(
        name: string,
        startTime: TimeInput = performance.now(),
        options?: Omit<SpanOptions, "startTime">,
    ) {
        this.name = name;
        this.options = options;
        this.startTime = startTime;
    }

    /**
     * Adds a child span to this span
     * @param child - The child span
     */
    addChild(child: PreAssembledSpan): this {
        this.children.push(child);
        return this;
    }

    /**
     * Sets a single Attribute with the key and value passed as arguments.
     * @param key - the key for this attribute.
     * @param value - the value for this attribute. Setting a value to null or
     * undefined is invalid and will result in undefined behavior when exporting
     * to otel
     */
    setAttr(key: string, value: AttributeValue): this {
        this.attributes[key] = value;
        return this;
    }

    /**
     * Extends the attributes with the given key/value object.
     * @param attributes the attributes that will be added,
     * null or undefined attribute values are invalid and
     * will result in undefined behavior when exporting to otel
     */
    extendAttrs(attributes: Attributes): this {
        for (const key in attributes) {
            this.setAttr(key, attributes[key]!);
        }
        return this;
    }

    /**
     * Adds an event to the Span.
     * @param name the name of the event.
     * @param attributes - (optional) the attributes of the event, defaults to now
     * @param startTime - (optional) start time of the event
     */
    addEvent(name: string, attributes?: Attributes, startTime: TimeInput = Date.now()): this {
        this.events.push({ name, attributes, startTime });
        return this;
    }

    /**
     * Sets a status to the span
     * @param status the SpanStatus to set
     */
    setStatus(status: SpanStatus): this {
        this.status = status;
        return this;
    }

    /**
     * Marks the end of Span execution by setting its end time
     * @param endTime - (optional) the span's end time to set, defaults to now
     */
    end(endTime: TimeInput = performance.now()): this {
        this.endTime = endTime;
        return this;
    }

    /**
     * Sets exception for this span
     * @param exception the exception the only accepted values are string or Error
     * @param time - (optional) the time of the exception, defaults to now
     */
    recordException(exception: Exception, time: TimeInput = Date.now()): this {
        this.exception = { time, exception };
        return this;
    }
}

/**
 * Adds the given k/v pairs to the target object by prepending the key with given header
 */
export function extendObjectWithHeader(
    targetObj: Record<string, any>,
    sourceObj: Record<string, any>,
    header: string,
    excludeHeaderForKeys: string[] = [],
) {
    for (const attrKey in sourceObj) {
        if (!excludeHeaderForKeys.includes(attrKey)) {
            Object.assign(targetObj, { [header + "." + attrKey]: sourceObj[attrKey] });
        } else {
            Object.assign(targetObj, { [attrKey]: sourceObj[attrKey] });
        }
    }
}
