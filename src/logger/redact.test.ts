import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../rpc/helpers";
import { HttpRequestError, SocketClosedError } from "viem";
import { redactException, redactUrl, redactUrls } from "./redact";

describe("Test redactUrl", () => {
    it("should mask the path, query and credentials and keep the scheme and host", () => {
        for (const url of [
            "https://base-mainnet.g.alchemy.com/v2/secretkey",
            "https://lb.drpc.org/ogrpc?network=base&dkey=secretkey",
            "https://user:secretkey@rpc.example.com",
            "wss://base-mainnet.g.alchemy.com/v2/secretkey",
        ]) {
            const redacted = redactUrl(url);
            const { protocol, host } = new URL(url);
            expect(redacted).toMatch(
                new RegExp(
                    `^${protocol}//${host.replace(/\./g, "\\.")}/\\[redacted:[0-9a-f]{8}\\]$`,
                ),
            );
            expect(redacted).not.toContain("secretkey");
        }
    });

    it("should keep different urls of one host distinguishable and the same url stable", () => {
        const a = redactUrl("https://base-mainnet.g.alchemy.com/v2/key-a");
        const b = redactUrl("https://base-mainnet.g.alchemy.com/v2/key-b");
        expect(a).not.toBe(b);
        expect(redactUrl("https://base-mainnet.g.alchemy.com/v2/key-a")).toBe(a);
    });

    it("should leave a url that is masked already as is, so masking twice keeps the hash", () => {
        for (const url of [
            "https://base-mainnet.g.alchemy.com/v2/secretkey",
            "https://lb.drpc.org/ogrpc?network=base&dkey=secretkey",
            "wss://user:secretkey@rpc.example.com/ws",
        ]) {
            const once = redactUrl(url);
            expect(redactUrl(once)).toBe(once);
        }
        const text = "failed at https://rpc.example.com/v2/secretkey, see https://viem.sh/docs";
        expect(redactUrls(redactUrls(text))).toBe(redactUrls(text));
    });

    it("should give a url and its normalized form the same hash", () => {
        // the rpc metrics keep the urls normalized, the config and the errors do not
        for (const url of [
            "https://base-mainnet.g.alchemy.com/v2/secretkey",
            "https://lb.drpc.org/ogrpc?network=base&dkey=secretkey",
            "wss://base-mainnet.g.alchemy.com/v2/secretkey",
        ]) {
            expect(redactUrl(normalizeUrl(url))).toBe(redactUrl(url));
        }
    });

    it("should return a url with nothing past its host as is", () => {
        expect(redactUrl("https://mainnet.base.org")).toBe("https://mainnet.base.org");
        expect(redactUrl("https://mainnet.base.org/")).toBe("https://mainnet.base.org/");
    });

    it("should fully mask a value that is not a valid url", () => {
        expect(redactUrl("not a url secretkey")).toMatch(/^\[redacted:[0-9a-f]{8}\]$/);
    });
});

describe("Test redactUrls", () => {
    it("should mask every url in a text and keep the rest of it", () => {
        // a failed rpc call carries the rpc url in its message
        const error = new HttpRequestError({
            url: "https://base-mainnet.g.alchemy.com/v2/secretkey",
            body: { method: "eth_getLogs" },
            status: 429,
            details: "Too Many Requests",
        });
        expect(error.message).toContain("secretkey");
        const masked = redactUrls(error.message);
        expect(masked).not.toContain("secretkey");
        expect(masked).toContain("URL: https://base-mainnet.g.alchemy.com/[redacted:");
        expect(masked).toContain("HTTP request failed.");
        expect(masked).toContain("Too Many Requests");
    });

    it("should mask a url in any letter case, and with an apostrophe in its path", () => {
        const masked = redactUrls(
            "URL: HTTPS://rpc.example.com/v2/secretkey and https://rpc.example.com/v2/part'secretkey",
        );
        expect(masked).not.toContain("secretkey");
        expect(masked).toContain("URL: https://rpc.example.com/[redacted:");
    });

    it("should keep the punctuation after a url in the text and out of its hash", () => {
        const url = "https://rpc.example.com/v2/secretkey";
        const masked = redactUrls(`failed at ${url}, retrying (${url}). '${url}'`);
        const tag = redactUrl(url);
        expect(masked).toBe(`failed at ${tag}, retrying (${tag}). '${tag}'`);
        expect(redactUrls(masked)).toBe(masked);
    });

    it("should leave a text with no url as is", () => {
        expect(redactUrls("execution reverted")).toBe("execution reverted");
    });
});

describe("Test redactException", () => {
    it("should mask the urls in the message and the stack, and keep the name and code", () => {
        const error = new SocketClosedError({ url: "wss://base.example.com/ws/secretkey" });
        (error as any).code = 4000;
        const masked = redactException(error) as Error & { code?: number };
        expect(masked).not.toBe(error);
        expect(masked.message).not.toContain("secretkey");
        expect(masked.stack).not.toContain("secretkey");
        expect(masked.message).toContain("wss://base.example.com/[redacted:");
        expect(masked.name).toBe(error.name);
        expect(masked.code).toBe(4000);
    });

    it("should return an exception with no url as is, and mask a string", () => {
        const error = new Error("execution reverted");
        expect(redactException(error)).toBe(error);
        expect(redactException("failed at https://rpc.example.com/v2/secretkey")).not.toContain(
            "secretkey",
        );
    });

    it("should return a thrown value that is not an object as is", () => {
        expect(redactException(undefined as any)).toBeUndefined();
        expect(redactException(null as any)).toBeNull();
    });

    it("should leave out a stack that is not a string, and still mask the message", () => {
        for (const stack of [null, 42]) {
            const thrown = { message: "failed at https://rpc.example.com/v2/secretkey", stack };
            const masked = redactException(thrown as any) as Error;
            expect(masked.message).not.toContain("secretkey");
            expect(masked.stack).toBeUndefined();
        }
        // with no url in it, the thrown value stays as is
        const plain = { message: "execution reverted", stack: null };
        expect(() => redactException(plain as any)).not.toThrow();
    });
});
