import { RpcMetrics, RpcState } from "./rpc";
import { normalizeUrl, shouldThrow } from "./helpers";
import { onFetchRequest, onFetchResponse } from "./hooks";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("./helpers", () => ({
    normalizeUrl: vi.fn(),
    shouldThrow: vi.fn(),
}));

vi.mock("./rpc", () => ({
    RpcState: vi.fn(),
    RpcMetrics: vi.fn(),
}));

describe("Test RPC hooks", () => {
    let mockRpcState: RpcState;
    let mockRpcMetrics: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRpcMetrics = {
            recordRequest: vi.fn(),
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };

        (RpcMetrics as Mock).mockImplementation(() => mockRpcMetrics);

        mockRpcState = {
            metrics: {},
        } as RpcState;
    });

    describe("Test onFetchRequest", () => {
        it("should record request for new URL", () => {
            const mockRequest = new Request("https://api.example.com/rpc");
            (normalizeUrl as Mock).mockReturnValue("https://api.example.com/rpc");

            onFetchRequest.call(mockRpcState, mockRequest);

            expect(normalizeUrl).toHaveBeenCalledWith(mockRequest.url);
            expect(RpcMetrics).toHaveBeenCalledOnce();
            expect(mockRpcMetrics.recordRequest).toHaveBeenCalledOnce();
            expect(mockRpcState.metrics["https://api.example.com/rpc"]).toBe(mockRpcMetrics);
        });

        it("should record request for existing URL", () => {
            const mockRequest = new Request("https://api.example.com/rpc");
            const existingMetrics = {
                recordRequest: vi.fn(),
                recordSuccess: vi.fn(),
                recordFailure: vi.fn(),
            } as any;

            (normalizeUrl as Mock).mockReturnValue("https://api.example.com/rpc");
            mockRpcState.metrics["https://api.example.com/rpc"] = existingMetrics;

            onFetchRequest.call(mockRpcState, mockRequest);

            expect(existingMetrics.recordRequest).toHaveBeenCalledOnce();
            expect(RpcMetrics).not.toHaveBeenCalled();
        });
    });

    describe("Test onFetchResponse", () => {
        let mockResponse: Response;

        beforeEach(() => {
            mockResponse = {
                clone: vi.fn().mockReturnThis(),
                url: "https://api.example.com/rpc",
                ok: true,
                headers: {
                    get: vi.fn(),
                },
                json: vi.fn(),
                text: vi.fn(),
            } as any;

            (normalizeUrl as Mock).mockReturnValue("https://api.example.com/rpc");
            mockRpcState.metrics["https://api.example.com/rpc"] = mockRpcMetrics;
        });

        it("should record failure for non-ok response", async () => {
            (mockResponse as any).ok = false;

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordFailure).toHaveBeenCalledOnce();
        });

        it("should record success for JSON response with result", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("application/json");
            mockResponse.json = vi.fn().mockResolvedValue({ result: "success" });

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordSuccess).toHaveBeenCalledOnce();
        });

        it("should record success for JSON response with throwable error", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("application/json");
            mockResponse.json = vi.fn().mockResolvedValue({ error: { code: -32000 } });
            (shouldThrow as Mock).mockReturnValue(true);

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(shouldThrow).toHaveBeenCalledWith({ code: -32000 });
            expect(mockRpcMetrics.recordSuccess).toHaveBeenCalledOnce();
        });

        it("should record failure for JSON response with non-throwable error", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("application/json");
            mockResponse.json = vi.fn().mockResolvedValue({ error: { code: -32001 } });
            (shouldThrow as Mock).mockReturnValue(false);

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordFailure).toHaveBeenCalledOnce();
        });

        it("should record failure for invalid JSON response", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("application/json");
            mockResponse.json = vi.fn().mockRejectedValue(new Error("Invalid JSON"));

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordFailure).toHaveBeenCalledOnce();
        });

        it("should handle text response with valid JSON", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("text/plain");
            mockResponse.text = vi.fn().mockResolvedValue('{"result": "success"}');

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordSuccess).toHaveBeenCalledOnce();
        });

        it("should record failure for text response with invalid JSON", async () => {
            mockResponse.headers.get = vi.fn().mockReturnValue("text/plain");
            mockResponse.text = vi.fn().mockResolvedValue("invalid json");

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(mockRpcMetrics.recordFailure).toHaveBeenCalledOnce();
        });

        it("should create new metrics if not found", async () => {
            delete mockRpcState.metrics["https://api.example.com/rpc"];
            mockResponse.headers.get = vi.fn().mockReturnValue("application/json");
            mockResponse.json = vi.fn().mockResolvedValue({ result: "success" });

            await onFetchResponse.call(mockRpcState, mockResponse);

            expect(RpcMetrics).toHaveBeenCalledOnce();
            expect(mockRpcMetrics.recordRequest).toHaveBeenCalledOnce();
            expect(mockRpcMetrics.recordSuccess).toHaveBeenCalledOnce();
        });
    });
});
