import { Result } from "./result";
import { describe, it, expect } from "vitest";

describe("Test Result", () => {
    describe("ok()", () => {
        it("should create Ok result correct value", () => {
            let value: any = { id: 1, name: "test" };
            let result = Result.ok<typeof value, Error>(value);

            expect(result.isOk() && result.value === value).toBe(true);
            expect(result.isErr()).toBe(false);

            // if ok value is undefined, it should still be Ok
            value = undefined;
            result = Result.ok<typeof value, Error>(value);

            expect(result.isOk() && result.value === value).toBe(true);
            expect(result.isErr()).toBe(false);
        });

        it("should have correct type guards for Ok result", () => {
            const result = Result.ok<string, Error>("test");

            if (result.isOk()) {
                // TypeScript should know this is Ok<string>
                expect(result.value).toBe("test");
                // @ts-expect-error - should not have error property in Ok type
                expect(result.error).toBeUndefined();
            }
        });
    });

    describe("err()", () => {
        it("should create Err result with object error", () => {
            let error: any = { code: 404, message: "Not found" };
            let result = Result.err<string, typeof error>(error);

            expect(result.isErr() && result.error).toEqual(error);
            expect(result.isOk()).toBe(false);

            // if error is undefined, it should still be Err
            error = undefined;
            result = Result.err<string, typeof error>(error);

            expect(result.isErr() && result.error).toEqual(error);
            expect(result.isOk()).toBe(false);
        });

        it("should have correct type guards for Err result", () => {
            const result = Result.err<string, Error>(new Error("test error"));

            if (result.isErr()) {
                // TypeScript should know this is Err<Error>
                expect(result.error).toBeInstanceOf(Error);
                // @ts-expect-error - should not have value property in Err type
                expect(result.value).toBeUndefined();
            }
        });
    });

    describe("type discrimination", () => {
        it("should correctly distinguish between Ok and Err results", () => {
            const okResult = Result.ok<string, Error>("success");
            const errResult = Result.err<string, Error>(new Error("failure"));

            expect(okResult.isOk()).toBe(true);
            expect(okResult.isErr()).toBe(false);
            expect(errResult.isOk()).toBe(false);
            expect(errResult.isErr()).toBe(true);
        });

        it("should work correctly in conditional statements", () => {
            const okResult = Result.ok<number, string>(42);
            const errResult = Result.err<number, string>("error");

            let okValue: number | undefined;
            let errValue: string | undefined;

            if (okResult.isOk()) {
                okValue = okResult.value;
            }

            if (errResult.isErr()) {
                errValue = errResult.error;
            }

            expect(okValue).toBe(42);
            expect(errValue).toBe("error");
        });
    });
});
