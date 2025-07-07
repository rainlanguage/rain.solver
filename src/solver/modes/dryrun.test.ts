import { dryrun } from "./dryrun";
import { containsNodeError, errorSnapshot } from "../../error";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// Mocks
vi.mock("../../signer", () => ({
    RainSolverSigner: class {},
}));
vi.mock("../../utils", () => ({
    withBigintSerializer: (_: string, value: any) =>
        typeof value === "bigint" ? value.toString() : value,
}));
vi.mock("../../error", () => ({
    containsNodeError: vi.fn(),
    errorSnapshot: vi.fn(),
}));

describe("Test dryrun", () => {
    let signer: any;
    let rawtx: any;
    let gasPrice: bigint;
    let gasLimitMultiplier: number;

    beforeEach(() => {
        vi.clearAllMocks();
        signer = {
            estimateGasCost: vi.fn(),
            account: { address: "0xabc" },
        };
        rawtx = { to: "0xdef", data: "0x123" };
        gasPrice = 2n;
        gasLimitMultiplier = 120;
    });

    it("should return ok result with correct fields on success", async () => {
        (signer.estimateGasCost as Mock).mockResolvedValue({
            gas: 100n,
            l1Cost: 5n,
        });

        const result = await dryrun(signer, rawtx, gasPrice, gasLimitMultiplier);

        assert(result.isOk());
        const val = result.value;
        expect(val).toHaveProperty("spanAttributes");
        expect(val).toHaveProperty("estimatedGasCost");
        expect(val).toHaveProperty("estimation");
        // gasLimit = (100 * 120) / 100 = 120
        // gasCost = 120 * 2 + 5 = 245
        expect(val.estimatedGasCost).toBe(245n);
        expect(val.estimation.gas).toBe(100n);
        expect(val.estimation.l1Cost).toBe(5n);
    });

    it("should throw and return err result if gasLimit is 0", async () => {
        (signer.estimateGasCost as Mock).mockResolvedValue({
            gas: 0n,
            l1Cost: 0n,
        });
        (errorSnapshot as Mock).mockResolvedValue("0 gas limit");

        const result = await dryrun(signer, rawtx, gasPrice, gasLimitMultiplier);
        assert(result.isErr());
        const err = result.error;
        expect(err).toHaveProperty("spanAttributes");
        expect(err.spanAttributes.isNodeError).toBe(undefined);
        expect(err.spanAttributes.error).toBe("0 gas limit");
        expect(err.noneNodeError).toBe("0 gas limit");
        expect(err.spanAttributes.rawtx).toMatch(
            JSON.stringify({
                to: "0xdef",
                data: "0x123",
                from: "0xabc",
            }),
        );
    });

    it("should return err result with node error", async () => {
        const error = new Error("node error");
        (signer.estimateGasCost as Mock).mockRejectedValue(error);
        (containsNodeError as Mock).mockResolvedValue(true);
        (errorSnapshot as Mock).mockResolvedValue("node error snapshot");

        const result = await dryrun(signer, rawtx, gasPrice, gasLimitMultiplier);

        assert(result.isErr());
        const err = result.error;
        expect(err).toHaveProperty("spanAttributes");
        expect(err.spanAttributes.isNodeError).toBe(true);
        expect(err.spanAttributes.error).toBe("node error snapshot");
        expect(err.spanAttributes.rawtx).toContain("0xabc");
        expect(err).not.toHaveProperty("noneNodeError");
    });

    it("should return err result with noneNodeError if not a node error", async () => {
        const error = new Error("other error");
        (signer.estimateGasCost as Mock).mockRejectedValue(error);
        (containsNodeError as Mock).mockResolvedValue(false);
        (errorSnapshot as Mock).mockResolvedValue("other error snapshot");

        const result = await dryrun(signer, rawtx, gasPrice, gasLimitMultiplier);

        assert(result.isErr());
        const err = result.error;
        expect(err).toHaveProperty("spanAttributes");
        expect(err.spanAttributes.isNodeError).toBe(false);
        expect(err.spanAttributes.error).toBe("other error snapshot");
        expect(err.spanAttributes.rawtx).toContain("0xabc");
        expect(err).toHaveProperty("noneNodeError", "other error snapshot");
    });
});
