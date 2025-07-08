/* eslint-disable no-console */
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, assert, expect } from "vitest";
import { PreAssembledSpan, RainSolverLogger, extendObjectWithHeader } from ".";

describe("Test RainSolverLogger", async function () {
    it("should successfully collect data and logs and export to otel channel", async function () {
        // hook to stdout for test
        let stdoutText = "";
        const orgStdout = process.stdout.write;
        process.stdout.write = (function (write) {
            return function (string: any) {
                stdoutText += string;
                // eslint-disable-next-line prefer-rest-params
                write.apply(process.stdout, arguments);
            };
        })(process.stdout.write) as any;

        // init logger
        const logger = new RainSolverLogger();
        const { span: testSpan } = logger.startSpan("span-test");

        // do some otel spans
        testSpan.setAttribute("some-attr", JSON.stringify({ someProp: "some-val" }));

        // do some normal logs
        console.log({ someObj: 123 });
        console.log("some text");

        // end otel span
        testSpan.end();

        // should not include any errors
        assert.notInclude(stdoutText.toLowerCase(), "maximum call stack size exceeded");
        assert.notInclude(stdoutText.toLowerCase(), "error");

        try {
            // for a colored console
            assert.include(stdoutText, "{ someObj: \u001b[33m123\u001b[39m }");
        } catch (e1) {
            try {
                // for a non colored console
                assert.include(stdoutText, "{ someObj: 123 }");
            } catch (e2) {
                throw stdoutText + "does not include { someObj: 123 }";
            }
        }

        // clear stdout text
        stdoutText = "";

        // setup a pre assembled span
        const now = Date.now();
        const preAssembledSpan = {
            name: "test-span",
            startTime: now,
            endTime: now + 200,
            attributes: {
                "test-attr": "test-value",
                "another-attr": 42,
            },
            events: [
                { name: "event1", startTime: now + 25, attributes: { key: "value" } },
                { name: "event2", startTime: now + 50, attributes: { foo: "bar" } },
            ],
            status: { code: SpanStatusCode.OK, message: "ok" },
            exception: {
                exception: "some error",
                time: now + 100,
            },
            children: [],
        };

        // export the pre assembled span
        logger.exportPreAssembledSpan(preAssembledSpan as any);

        // parse export result as obj from stdout text
        const result = JSON.parse(
            stdoutText
                .trim()
                .replaceAll("'", '"')
                .replaceAll(/(\[\],)/g, "[]")
                .replaceAll(/(},\s*})/g, "}}")
                .replaceAll(/(},\s*])/g, "}]")
                .replaceAll(/(\w+):/g, '"$1":')
                .replaceAll("undefined", "null")
                .replaceAll(/(,\s*}\s*,)/g, "},"),
        );

        const nowSeconds = Math.floor(now / 1000);
        const expected = {
            name: preAssembledSpan.name,
            timestamp: (preAssembledSpan.startTime as number) * 1000,
            duration:
                ((preAssembledSpan.endTime as number) - (preAssembledSpan.startTime as number)) *
                1000,
            attributes: preAssembledSpan.attributes,
            status: preAssembledSpan.status,
            events: [
                {
                    name: "event1",
                    attributes: preAssembledSpan.events?.[0].attributes,
                    time: [nowSeconds, Number(((now + 25) / 1000 - nowSeconds).toFixed(9)) * 1e9],
                },
                {
                    name: "event2",
                    attributes: preAssembledSpan.events?.[1].attributes,
                    time: [nowSeconds, Number(((now + 50) / 1000 - nowSeconds).toFixed(9)) * 1e9],
                },
                {
                    name: "exception",
                    attributes: { "exception.message": preAssembledSpan.exception?.exception },
                    time: [nowSeconds, Number(((now + 100) / 1000 - nowSeconds).toFixed(9)) * 1e9],
                },
            ],
        };
        assert.equal(result.name, expected.name);
        assert.equal(result.timestamp, expected.timestamp);
        assert.equal(result.duration, expected.duration);
        assert.deepEqual(result.attributes, expected.attributes);
        assert.deepEqual(result.status, expected.status);
        for (let i = 0; i < expected.events.length; i++) {
            assert.equal(result.events[i].name, expected.events[i].name);
            assert.deepEqual(result.events[i].attributes, expected.events[i].attributes);
            assert.closeTo(result.events[i].time[0], expected.events[i].time[0], 1); // assert closeTo due to js precision loss with number operations
            assert.closeTo(result.events[i].time[1], expected.events[i].time[1], 1000); // assert closeTo due to js precision loss with number operations
        }

        // set original stdout write fn back
        process.stdout.write = orgStdout;
    });
});

describe("Test PreAssembledSpan", async function () {
    it("should correctly initialize and gather data by testing all setters", async function () {
        const now = Date.now();
        const expected = {
            name: "test-span",
            startTime: now,
            endTime: undefined,
            options: undefined,
            attributes: {},
            events: [],
            status: undefined,
            exception: undefined,
            children: [],
        } as any;

        const span = new PreAssembledSpan("test-span", now);
        assert.deepEqual(span, expected);

        span.addEvent("event1", { key: "value" }, now + 25);
        expected.events.push({ name: "event1", startTime: now + 25, attributes: { key: "value" } });
        assert.deepEqual(span, expected);

        span.setAttr("test-attr", "test-value");
        expected.attributes["test-attr"] = "test-value";
        assert.deepEqual(span, expected);

        span.extendAttrs({ "another-attr": 42 });
        expected.attributes["another-attr"] = 42;
        assert.deepEqual(span, expected);

        span.setStatus({ code: SpanStatusCode.ERROR, message: "error" });
        expected.status = { code: SpanStatusCode.ERROR, message: "error" };
        assert.deepEqual(span, expected);

        span.recordException("error", now + 100);
        expected.exception = { exception: "error", time: now + 100 };
        assert.deepEqual(span, expected);

        span.addChild(new PreAssembledSpan("child-span", now + 200));
        const expectedChild = {
            name: "child-span",
            startTime: now + 200,
            endTime: undefined,
            options: undefined,
            attributes: {},
            events: [],
            status: undefined,
            exception: undefined,
            children: [],
        };
        expected.children.push(expectedChild);
        assert.deepEqual(span, expected);

        span.end(now + 500);
        expected.endTime = now + 500;
        assert.deepEqual(span, expected);
    });
});

describe("Test extendObjectWithHeader", () => {
    it("should add keys with header prefix", () => {
        const target = {};
        const source = { foo: 1, bar: 2 };
        extendObjectWithHeader(target, source, "test");
        expect(target).toEqual({
            "test.foo": 1,
            "test.bar": 2,
        });
    });

    it("should exclude keys from header prefix if specified", () => {
        const target = {};
        const source = { foo: 1, bar: 2, baz: 3 };
        extendObjectWithHeader(target, source, "head", ["bar"]);
        expect(target).toEqual({
            "head.foo": 1,
            bar: 2,
            "head.baz": 3,
        });
    });
});
