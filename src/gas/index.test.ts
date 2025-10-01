import { GasManager } from ".";
import { getGasPrice } from "./price";
import { Result, sleep } from "../common";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./price", () => ({
    getGasPrice: vi.fn(),
}));

describe("Test GasManager", () => {
    let config: any;
    let gasManager: GasManager;

    beforeEach(() => {
        vi.clearAllMocks();
        config = {
            chainConfig: { id: 1, isSpecialL2: false },
            client: { name: "mockClient" } as any,
            baseGasPriceMultiplier: 107,
            maxGasPriceMultiplier: 150,
            gasIncreasePointsPerStep: 3,
            gasIncreaseStepTime: 60 * 60 * 1000,
            txTimeThreshold: 30_000,
        };
        gasManager = new GasManager(config);
    });

    describe("Test init static method", () => {
        it("should init with expected values and call watchGasPrice", () => {
            const manager = GasManager.init(config);
            expect(manager.baseGasPriceMultiplier).toBe(107);
            expect(manager.maxGasPriceMultiplier).toBe(150);
            expect(manager.gasIncreasePointsPerStep).toBe(3);
            expect(manager.gasIncreaseStepTime).toBe(60 * 60 * 1000);
            expect(manager.txTimeThreshold).toBe(30_000);
            expect(manager.gasPriceMultiplier).toBe(107);
            expect(manager.isWatchingGasPrice).toBe(true);
            expect(manager.deadline).toBeUndefined();
            expect(manager.gasPrice).toBe(0n);
            expect(manager.l1GasPrice).toBe(0n);
            expect(manager.client).toBe(config.client);
            expect(manager.chainConfig).toBe(config.chainConfig);
        });
    });

    describe("Test record method", () => {
        it("should record new tx mining record when its under threshold without reset", () => {
            gasManager.recordTxMineRecord({
                didMine: true,
                length: 20_000,
            });
            expect(gasManager.deadline).toBeUndefined();
            expect(gasManager.gasPriceMultiplier).toBe(107);
        });

        it("should record new tx mining record when its under threshold and reset", () => {
            gasManager.deadline = Date.now() - 1000; // set deadline in the past to trigger reset
            gasManager.gasPriceMultiplier = 120; // set a higher multiplier to see if it resets
            gasManager.recordTxMineRecord({
                didMine: true,
                length: 20_000,
            });
            expect(gasManager.deadline).toBeUndefined();
            expect(gasManager.gasPriceMultiplier).toBe(107);
        });

        it("should record new tx mining record when its over threshold", () => {
            gasManager.recordTxMineRecord({
                didMine: true,
                length: 40_000,
            });
            expect(gasManager.deadline).toBeDefined();
            expect(gasManager.gasPriceMultiplier).toBe(110); // increased by 3 points
        });

        it("should not increase the multiplier over the max value", () => {
            gasManager.gasPriceMultiplier = 149; // set close to max
            gasManager.recordTxMineRecord({
                didMine: true,
                length: 40_000,
            });
            expect(gasManager.deadline).toBeDefined();
            expect(gasManager.gasPriceMultiplier).toBe(150); // increased only to max value
        });
    });

    describe("Test watchGasPrice method", () => {
        it("should start watching gas price", () => {
            gasManager.watchGasPrice();
            expect(gasManager.isWatchingGasPrice).toBe(true);
            gasManager.unwatchGasPrice();
            expect(gasManager.isWatchingGasPrice).toBe(false);
        });

        it("should update gas prices on interval if getGasPrices resolve", async () => {
            // patch getGasPrice to return new values
            (getGasPrice as any).mockResolvedValue({
                gasPrice: Result.ok(5555n),
                l1GasPrice: Result.ok(8888n),
            });
            // watchGasPrice with a short interval for test
            gasManager.unwatchGasPrice();
            gasManager.watchGasPrice(10);
            await sleep(100); // wait for new gas prices to be fetched

            expect(gasManager.gasPrice).toBe(5555n);
            expect(gasManager.l1GasPrice).toBe(8888n);

            gasManager.unwatchGasPrice();
        });
    });
});
