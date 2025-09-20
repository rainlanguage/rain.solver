import { parseUnits } from "viem";
import { dryrun, fallbackEthPrice } from "./dryrun";
import { containsNodeError, errorSnapshot } from "../../error";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

// Mocks
vi.mock("../../signer", () => ({
    RainSolverSigner: class {},
}));
vi.mock("../../common", async (importOriginal) => ({
    ...(await importOriginal()),
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

describe("Test fallbackEthPrice", () => {
    it("should calculate fallback price when oiRatio is less than ioRatio", () => {
        const oiRatio = parseUnits("0.5", 18); // 0.5 output per input
        const ioRatio = parseUnits("3", 18); // 3 input per output
        const inputPrice = "2000"; // $2000 ETH price for input token
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 5e17 = 2e18 (2 input per output)
        // minRatio = min(2e18, 3e18) = 2e18
        // result = (2e18 * 2000e18) / 1e18 = 4000
        expect(result).toBe("4000");
    });

    it("should calculate fallback price when ioRatio is less than oiRatio", () => {
        const oiRatio = parseUnits("0.1", 18); // 0.1 output per input
        const ioRatio = parseUnits("5", 18); // 5 input per output
        const inputPrice = "1500"; // $1500 ETH price for input token
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 1e17 = 1e19 (10 input per output)
        // minRatio = min(1e19, 5e18) = 5e18
        // result = (5e18 * 1500e18) / 1e18 = 7500
        expect(result).toBe("7500");
    });

    it("should handle zero oiRatio", () => {
        const oiRatio = 0n;
        const ioRatio = parseUnits("2", 18);
        const inputPrice = "3000";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = maxUint256 (very large number)
        // minRatio = min(maxUint256, 2e18) = 2e18
        // result = (2e18 * 3000e18) / 1e18 = 6000
        expect(result).toBe("6000");
    });

    it("should handle equal ratios", () => {
        const oiRatio = parseUnits("0.5", 18);
        const ioRatio = parseUnits("2", 18); // Inverse of oiRatio
        const inputPrice = "2500";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 5e17 = 2e18
        // minRatio = min(2e18, 2e18) = 2e18
        // result = (2e18 * 2500e18) / 1e18 = 5000
        expect(result).toBe("5000");
    });

    it("should handle decimal input prices", () => {
        const oiRatio = parseUnits("0.25", 18);
        const ioRatio = parseUnits("5", 18);
        const inputPrice = "1234.56789";
        const result = fallbackEthPrice(oiRatio, ioRatio, inputPrice);

        // oiRatioInverse = 1e36 / 25e16 = 4e18
        // minRatio = min(4e18, 5e18) = 4e18
        // result = (4e18 * 1234.56789e18) / 1e18 = 4938.27156
        expect(result).toBe("4938.27156");
    });
});
