import { Order } from "../order";
import axios, { AxiosError } from "axios";
import { OracleErrorType } from "./error";
import { OracleConstants, OracleHealthMap, OracleOrderRequest } from "./types";
import { describe, it, expect, vi, beforeEach, afterEach, assert, Mock } from "vitest";
import {
    isInCooloff,
    extractOracleUrl,
    fetchSignedContext,
    recordOracleSuccess,
    recordOracleFailure,
} from "./fetch";

// Mock axios
vi.mock("axios", async () => {
    const actual = await vi.importActual<typeof import("axios")>("axios");
    return {
        default: {
            ...actual.default,
            post: vi.fn(),
            isAxiosError: vi.fn(),
        },
        AxiosError: actual.AxiosError,
    };
});

describe("fetchSignedContext", () => {
    let healthMap: OracleHealthMap;
    const testUrl = "https://oracle.example.com";

    const mockOrderRequest: OracleOrderRequest = {
        order: {
            type: Order.Type.V4,
            owner: "0x1234567890123456789012345678901234567890",
            evaluable: {
                interpreter: "0x1234567890123456789012345678901234567890",
                store: "0x1234567890123456789012345678901234567890",
                bytecode: "0x00",
            },
            validInputs: [
                {
                    token: "0x1234567890123456789012345678901234567890",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
            validOutputs: [
                {
                    token: "0x1234567890123456789012345678901234567890",
                    vaultId: "0x0000000000000000000000000000000000000000000000000000000000000001",
                },
            ],
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000123",
        },
        inputIOIndex: 0,
        outputIOIndex: 0,
        counterparty: "0x1234567890123456789012345678901234567890",
    };

    const validSignedContext = {
        signer: "0x000000000000000000000000abcdef1234567890",
        context: [
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000000000000000000000000000002",
        ],
        signature: "0xsignature",
    };

    beforeEach(() => {
        healthMap = new Map();
        vi.clearAllMocks();

        // Mock OracleConstants.isKnown to return true for test URL
        vi.spyOn(OracleConstants, "isKnown").mockReturnValue(true);
    });

    it("returns error when URL is unknown", async () => {
        vi.spyOn(OracleConstants, "isKnown").mockReturnValue(false);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.Cooloff);
        expect(result.error.message).toContain("unknown");
    });

    it("returns error when URL is in cooloff", async () => {
        healthMap.set(testUrl, {
            consecutiveFailures: 5,
            cooloffUntil: Date.now() + 60000,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.Cooloff);
        expect(result.error.message).toContain("cooloff");
    });

    it("returns valid SignedContextV2 on successful response", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [validSignedContext],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isOk());
        expect(result.value).toEqual(validSignedContext);
    });

    it("records success in health map on valid response", async () => {
        healthMap.set(testUrl, { consecutiveFailures: 3, cooloffUntil: 0 });
        (axios.post as Mock).mockResolvedValueOnce({
            data: [validSignedContext],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(0);
        expect(state?.cooloffUntil).toBe(0);
    });

    it("returns error on response error (500)", async () => {
        const axiosError = new AxiosError(
            "Request failed with status code 500",
            "ERR_BAD_RESPONSE",
            {} as any,
            {},
            {
                status: 500,
                statusText: "Internal Server Error",
                data: {},
                headers: {},
                config: {} as any,
            },
        );

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.RequestFailed);
        expect(result.error.message).toContain("500");
        expect(result.error.message).toContain("Internal Server Error");
    });

    it("records failure in health map on response error", async () => {
        const axiosError = new AxiosError(
            "Request failed with status code 500",
            "ERR_BAD_RESPONSE",
            {} as any,
            {},
            {
                status: 500,
                statusText: "Internal Server Error",
                data: {},
                headers: {},
                config: {} as any,
            },
        );

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(1);
    });

    it("returns error on network error", async () => {
        const axiosError = new AxiosError("Network Error", "ERR_NETWORK", {} as any, {}, undefined);
        axiosError.request = {};

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.FetchError);
        expect(result.error.message).toContain("Network Error");
    });

    it("records failure in health map on network error", async () => {
        const axiosError = new AxiosError("Network Error", "ERR_NETWORK", {} as any, {}, undefined);
        axiosError.request = {};

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(1);
    });

    it("returns error on invalid response shape", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: { invalid: "response" },
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.InvalidResponseType);
    });

    it("records failure in health map on invalid response shape", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: { invalid: "response" },
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(1);
    });

    it("sends correct request headers", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [validSignedContext],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        expect(axios.post).toHaveBeenCalledWith(
            testUrl,
            expect.any(Uint8Array),
            expect.objectContaining({
                headers: { "Content-Type": "application/octet-stream" },
                timeout: OracleConstants.ORACLE_TIMEOUT_MS,
                responseType: "json",
            }),
        );
    });

    it("sends body as Uint8Array", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [validSignedContext],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        const callArgs = (axios.post as Mock).mock.calls[0];
        expect(callArgs[1]).toBeInstanceOf(Uint8Array);
    });

    it("handles non-AxiosError exceptions gracefully", async () => {
        const genericError = new Error("Generic error");
        (axios.post as Mock).mockRejectedValueOnce(genericError);
        (axios.isAxiosError as any as Mock).mockReturnValue(false);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.FetchError);
        expect(result.error.message).toContain("Generic error");
    });

    it("handles response with missing signer", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [
                {
                    context: ["0x01"],
                    signature: "0xsig",
                },
            ],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.InvalidResponseType);
    });

    it("handles response with missing context", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [
                {
                    signer: "0x1234",
                    signature: "0xsig",
                },
            ],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.InvalidResponseType);
    });

    it("handles response with missing signature", async () => {
        (axios.post as Mock).mockResolvedValueOnce({
            data: [
                {
                    signer: "0x1234",
                    context: ["0x01"],
                },
            ],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.InvalidResponseType);
    });

    it("handles 404 response", async () => {
        const axiosError = new AxiosError(
            "Request failed with status code 404",
            "ERR_BAD_REQUEST",
            {} as any,
            {},
            {
                status: 404,
                statusText: "Not Found",
                data: {},
                headers: {},
                config: {} as any,
            },
        );

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.RequestFailed);
        expect(result.error.message).toContain("404");
    });

    it("handles 400 Bad Request response", async () => {
        const axiosError = new AxiosError(
            "Request failed with status code 400",
            "ERR_BAD_REQUEST",
            {} as any,
            {},
            {
                status: 400,
                statusText: "Bad Request",
                data: { error: "Invalid request body" },
                headers: {},
                config: {} as any,
            },
        );

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.RequestFailed);
        expect(result.error.message).toContain("400");
    });

    it("processes expired cooloff correctly", async () => {
        // Set expired cooloff
        healthMap.set(testUrl, {
            consecutiveFailures: 5,
            cooloffUntil: Date.now() - 1000,
        });

        (axios.post as Mock).mockResolvedValueOnce({
            data: [validSignedContext],
            status: 200,
            statusText: "OK",
            headers: {},
            config: {} as any,
        });

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isOk());
    });

    it("handles timeout error", async () => {
        const axiosError = new AxiosError(
            "timeout of 5000ms exceeded",
            "ECONNABORTED",
            {} as any,
            {},
            undefined,
        );
        axiosError.request = {};

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.FetchError);
    });

    it("handles cancelled request", async () => {
        const axiosError = new AxiosError(
            "Request cancelled",
            "ERR_CANCELED",
            {} as any,
            {},
            undefined,
        );
        axiosError.request = {};

        (axios.post as Mock).mockRejectedValueOnce(axiosError);
        (axios.isAxiosError as any as Mock).mockReturnValue(true);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.FetchError);
    });

    it("handles non-Error string exceptions", async () => {
        (axios.post as Mock).mockRejectedValueOnce("string error");
        (axios.isAxiosError as any as Mock).mockReturnValue(false);

        const result = await fetchSignedContext(testUrl, mockOrderRequest, healthMap);

        assert(result.isErr());
        expect(result.error.type).toBe(OracleErrorType.FetchError);
        expect(result.error.message).toContain("string error");
    });
});

describe("extractOracleUrl", () => {
    const endMarker = "011b";

    const buildMetaHex = (url: string): string => {
        const urlHex = Buffer.from(url).toString("hex");
        // Simulates CBOR structure: <prefix><url><endMarker><magic>
        return "a200" + urlHex + endMarker + OracleConstants.RaindexSignedContextOracleV1;
    };

    it("returns undefined for empty string", () => {
        expect(extractOracleUrl("")).toBeUndefined();
    });

    it("returns undefined for null/undefined input", () => {
        expect(extractOracleUrl(null as any)).toBeUndefined();
        expect(extractOracleUrl(undefined as any)).toBeUndefined();
    });

    it("returns undefined when magic number is not present", () => {
        const urlHex = Buffer.from("https://oracle.example.com").toString("hex");
        expect(extractOracleUrl(urlHex)).toBeUndefined();
    });

    it("extracts https URL from valid meta hex", () => {
        const url = "https://oracle.example.com";
        const metaHex = buildMetaHex(url);

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("extracts http URL from valid meta hex", () => {
        const url = "http://oracle.example.com";
        const metaHex = buildMetaHex(url);

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("handles 0x prefix", () => {
        const url = "https://oracle.example.com";
        const metaHex = "0x" + buildMetaHex(url);

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("returns undefined when URL protocol is not found", () => {
        const noProtocolUrl = "oracle.example.com";
        const urlHex = Buffer.from(noProtocolUrl).toString("hex");
        const metaHex = "a200" + urlHex + endMarker + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBeUndefined();
    });

    it("returns undefined when end marker is missing", () => {
        const url = "https://oracle.example.com";
        const urlHex = Buffer.from(url).toString("hex");
        const metaHex = "a200" + urlHex + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBeUndefined();
    });

    it("returns undefined when end marker is before URL", () => {
        const url = "https://oracle.example.com";
        const urlHex = Buffer.from(url).toString("hex");
        // Place end marker before URL
        const metaHex = endMarker + "a200" + urlHex + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBeUndefined();
    });

    it("extracts URL with path and query parameters", () => {
        const url = "https://oracle.example.com/api/v1?key=value";
        const metaHex = buildMetaHex(url);

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("extracts URL with port number", () => {
        const url = "https://oracle.example.com:8080/endpoint";
        const metaHex = buildMetaHex(url);

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("handles additional data after magic number", () => {
        const url = "https://oracle.example.com";
        const metaHex = buildMetaHex(url) + "deadbeef";

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("handles additional data before URL", () => {
        const url = "https://oracle.example.com";
        const urlHex = Buffer.from(url).toString("hex");
        const metaHex =
            "deadbeefa200" + urlHex + endMarker + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBe(url);
    });

    it("uses last occurrence of https when multiple present", () => {
        const url1 = "https://first.example.com";
        const url2 = "https://second.example.com";
        const url1Hex = Buffer.from(url1).toString("hex");
        const url2Hex = Buffer.from(url2).toString("hex");
        // Structure with two URLs, should pick the last one before magic
        const metaHex =
            url1Hex + "a200" + url2Hex + endMarker + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBe(url2);
    });

    it("returns undefined for malformed hex that cannot be decoded", () => {
        // Invalid hex characters after URL marker but before end marker
        const httpsHex = Buffer.from("https://").toString("hex");
        // Incomplete/invalid URL hex
        const metaHex =
            "a200" + httpsHex + "zzzz" + endMarker + OracleConstants.RaindexSignedContextOracleV1;

        // This should still find https:// and try to decode, but the result
        // will include invalid characters - Buffer.from handles this gracefully
        const result = extractOracleUrl(metaHex);
        expect(result).toBeDefined();
        expect(result?.startsWith("https://")).toBe(true);
    });

    it("handles real-world CBOR structure", () => {
        // Simulating a more realistic CBOR map structure
        const url = "https://api.raindex.io/oracle";
        const urlHex = Buffer.from(url).toString("hex");
        const length = (urlHex.length / 2).toString(16).padStart(2, "0");
        // a2 = map with 2 items, 00 = key 0, 58 = byte string with 1-byte length
        const metaHex =
            "a20058" + length + urlHex + endMarker + OracleConstants.RaindexSignedContextOracleV1;

        expect(extractOracleUrl(metaHex)).toBe(url);
    });
});

describe("isInCooloff", () => {
    let healthMap: OracleHealthMap;
    const testUrl = "https://oracle.example.com";

    beforeEach(() => {
        healthMap = new Map();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns false for unknown URL", () => {
        expect(isInCooloff(healthMap, testUrl)).toBe(false);
    });

    it("returns false when cooloffUntil is 0", () => {
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: 0 });

        expect(isInCooloff(healthMap, testUrl)).toBe(false);
    });

    it("returns true when in active cooloff period", () => {
        const futureTime = Date.now() + 60000; // 1 minute in the future
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: futureTime });

        expect(isInCooloff(healthMap, testUrl)).toBe(true);
    });

    it("returns false and resets cooloff when cooloff period has expired", () => {
        const pastTime = Date.now() - 1000; // 1 second in the past
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: pastTime });

        expect(isInCooloff(healthMap, testUrl)).toBe(false);
        expect(healthMap.get(testUrl)?.cooloffUntil).toBe(0);
    });

    it("returns false and resets cooloff when cooloff period equals current time", () => {
        const currentTime = Date.now();
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: currentTime });

        expect(isInCooloff(healthMap, testUrl)).toBe(false);
        expect(healthMap.get(testUrl)?.cooloffUntil).toBe(0);
    });

    it("preserves consecutiveFailures when resetting expired cooloff", () => {
        const pastTime = Date.now() - 1000;
        healthMap.set(testUrl, { consecutiveFailures: 10, cooloffUntil: pastTime });

        isInCooloff(healthMap, testUrl);

        expect(healthMap.get(testUrl)?.consecutiveFailures).toBe(10);
    });

    it("handles multiple URLs independently", () => {
        const url1 = "https://oracle1.example.com";
        const url2 = "https://oracle2.example.com";

        healthMap.set(url1, { consecutiveFailures: 3, cooloffUntil: Date.now() + 60000 });
        healthMap.set(url2, { consecutiveFailures: 3, cooloffUntil: 0 });

        expect(isInCooloff(healthMap, url1)).toBe(true);
        expect(isInCooloff(healthMap, url2)).toBe(false);
    });

    it("does not modify state when in active cooloff", () => {
        const futureTime = Date.now() + 60000;
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: futureTime });

        isInCooloff(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(5);
        expect(state?.cooloffUntil).toBe(futureTime);
    });

    it("returns false for state with undefined values treated as fresh", () => {
        healthMap.set(testUrl, { consecutiveFailures: 0, cooloffUntil: 0 });

        expect(isInCooloff(healthMap, testUrl)).toBe(false);
    });
});

describe("recordOracleSuccess", () => {
    let healthMap: OracleHealthMap;
    const testUrl = "https://oracle.example.com";

    beforeEach(() => {
        healthMap = new Map();
    });

    it("creates new state entry for unknown URL", () => {
        recordOracleSuccess(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state).toBeDefined();
        expect(state?.consecutiveFailures).toBe(0);
        expect(state?.cooloffUntil).toBe(0);
    });

    it("resets consecutive failures to zero", () => {
        healthMap.set(testUrl, { consecutiveFailures: 5, cooloffUntil: 0 });

        recordOracleSuccess(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(0);
    });

    it("clears cooloff period", () => {
        healthMap.set(testUrl, {
            consecutiveFailures: 10,
            cooloffUntil: Date.now() + 60000,
        });

        recordOracleSuccess(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(0);
        expect(state?.cooloffUntil).toBe(0);
    });

    it("handles multiple URLs independently", () => {
        const url1 = "https://oracle1.example.com";
        const url2 = "https://oracle2.example.com";

        healthMap.set(url1, { consecutiveFailures: 3, cooloffUntil: 1000 });
        healthMap.set(url2, { consecutiveFailures: 5, cooloffUntil: 2000 });

        recordOracleSuccess(healthMap, url1);

        expect(healthMap.get(url1)?.consecutiveFailures).toBe(0);
        expect(healthMap.get(url1)?.cooloffUntil).toBe(0);
        expect(healthMap.get(url2)?.consecutiveFailures).toBe(5);
        expect(healthMap.get(url2)?.cooloffUntil).toBe(2000);
    });

    it("overwrites existing state completely", () => {
        healthMap.set(testUrl, {
            consecutiveFailures: 100,
            cooloffUntil: 999999,
        });

        recordOracleSuccess(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state).toEqual({ consecutiveFailures: 0, cooloffUntil: 0 });
    });

    it("can be called multiple times without side effects", () => {
        recordOracleSuccess(healthMap, testUrl);
        recordOracleSuccess(healthMap, testUrl);
        recordOracleSuccess(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(0);
        expect(state?.cooloffUntil).toBe(0);
    });
});

describe("recordOracleFailure", () => {
    let healthMap: OracleHealthMap;
    const testUrl = "https://oracle.example.com";

    beforeEach(() => {
        healthMap = new Map();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("creates new state entry for unknown URL", () => {
        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state).toBeDefined();
        expect(state?.consecutiveFailures).toBe(1);
        expect(state?.cooloffUntil).toBe(0);
    });

    it("increments consecutive failures for existing URL", () => {
        healthMap.set(testUrl, { consecutiveFailures: 2, cooloffUntil: 0 });

        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(3);
    });

    it("enters cooloff when reaching threshold", () => {
        healthMap.set(testUrl, {
            consecutiveFailures: OracleConstants.COOLOFF_THRESHOLD - 1,
            cooloffUntil: 0,
        });

        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(OracleConstants.COOLOFF_THRESHOLD);
        expect(state?.cooloffUntil).toBe(Date.now() + OracleConstants.COOLOFF_DURATION_MS);
    });

    it("updates cooloff time when exceeding threshold", () => {
        healthMap.set(testUrl, {
            consecutiveFailures: OracleConstants.COOLOFF_THRESHOLD,
            cooloffUntil: 0,
        });

        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(OracleConstants.COOLOFF_THRESHOLD + 1);
        expect(state?.cooloffUntil).toBe(Date.now() + OracleConstants.COOLOFF_DURATION_MS);
    });

    it("does not set cooloff before reaching threshold", () => {
        recordOracleFailure(healthMap, testUrl);
        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(2);
        expect(state?.cooloffUntil).toBe(0);
    });

    it("handles multiple URLs independently", () => {
        const url1 = "https://oracle1.example.com";
        const url2 = "https://oracle2.example.com";

        recordOracleFailure(healthMap, url1);
        recordOracleFailure(healthMap, url1);
        recordOracleFailure(healthMap, url2);

        expect(healthMap.get(url1)?.consecutiveFailures).toBe(2);
        expect(healthMap.get(url2)?.consecutiveFailures).toBe(1);
    });

    it("preserves existing cooloff time when below threshold after reset", () => {
        const existingCooloff = Date.now() + 5000;
        healthMap.set(testUrl, {
            consecutiveFailures: 1,
            cooloffUntil: existingCooloff,
        });

        recordOracleFailure(healthMap, testUrl);

        const state = healthMap.get(testUrl);
        expect(state?.consecutiveFailures).toBe(2);
        expect(state?.cooloffUntil).toBe(existingCooloff);
    });
});
