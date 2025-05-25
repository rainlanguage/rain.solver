/* eslint-disable no-console */
import { RainSolverLogger } from "./logger";
import { describe, it, assert } from "vitest";

describe("Test RainSolverLogger", async function () {
    it("should collect data and logs and export correctly", async function () {
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

        // set original stdout write fn back
        process.stdout.write = orgStdout;
    });
});
