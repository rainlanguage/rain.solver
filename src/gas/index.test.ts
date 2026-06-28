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
        it("should init with expected values and call watchGasPrice", async () => {
            (getGasPrice as any).mockResolvedValueOnce({
                gasPrice: Result.ok(123n),
                l1GasPrice: Result.ok(456n),
            });
            const manager = await GasManager.init(config);
            expect(manager.baseGasPriceMultiplier).toBe(107);
            expect(manager.maxGasPriceMultiplier).toBe(150);
            expect(manager.gasIncreasePointsPerStep).toBe(3);
            expect(manager.gasIncreaseStepTime).toBe(60 * 60 * 1000);
            expect(manager.txTimeThreshold).toBe(30_000);
            expect(manager.gasPriceMultiplier).toBe(107);
            expect(manager.isWatchingGasPrice).toBe(true);
            expect(manager.deadline).toBeUndefined();
            expect(manager.gasPrice).toBe(123n);
            expect(manager.l1GasPrice).toBe(456n);
            expect(manager.client).toBe(config.client);
            expect(manager.chainConfig).toBe(config.chainConfig);
            expect(getGasPrice).toHaveBeenCalledTimes(1);
            expect(getGasPrice).toHaveBeenCalledWith(
                config.client,
                config.chainConfig,
                config.baseGasPriceMultiplier,
            );
        });
    });

    describe("Test record method", () => {
        it("should record new tx mining record when its under threshold without reset", () => {
            gasManager.onTransactionMine({
                didMine: true,
                length: 20_000,
            });
            expect(gasManager.deadline).toBeUndefined();
            expect(gasManager.gasPriceMultiplier).toBe(107);
        });

        it("should record new tx mining record when its under threshold and reset", () => {
            gasManager.deadline = Date.now() - 1000; // set deadline in the past to trigger reset
            gasManager.gasPriceMultiplier = 120; // set a higher multiplier to see if it resets
            gasManager.onTransactionMine({
                didMine: true,
                length: 20_000,
            });
            expect(gasManager.deadline).toBeUndefined();
            expect(gasManager.gasPriceMultiplier).toBe(107);
        });

        it("should record new tx mining record when its over threshold", () => {
            gasManager.onTransactionMine({
                didMine: true,
                length: 40_000,
            });
            expect(gasManager.deadline).toBeDefined();
            expect(gasManager.gasPriceMultiplier).toBe(110); // increased by 3 points
        });

        it("should not increase the multiplier over the max value", () => {
            gasManager.gasPriceMultiplier = 149; // set close to max
            gasManager.onTransactionMine({
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

        it("should not start a second watcher when already watching", () => {
            // the active interval handle while watching
            gasManager.watchGasPrice();
            expect(gasManager.isWatchingGasPrice).toBe(true);
            const firstWatcher = (gasManager as any).gasPriceWatcher;

            // calling again while already watching keeps the same interval handle
            gasManager.watchGasPrice();
            expect((gasManager as any).gasPriceWatcher).toBe(firstWatcher);

            gasManager.unwatchGasPrice();
            expect(gasManager.isWatchingGasPrice).toBe(false);
        });
    });

    describe("Test constructor default values", () => {
        it("should apply class defaults when optional config fields are omitted", () => {
            // only the required fields are provided; optional fields take their defaults
            const manager = new GasManager({
                chainConfig: { id: 1, isSpecialL2: false } as any,
                client: { name: "mockClient" } as any,
                baseGasPriceMultiplier: 100,
            } as any);

            // class field defaults
            expect(manager.gasIncreasePointsPerStep).toBe(3);
            expect(manager.gasIncreaseStepTime).toBe(60 * 60 * 1000); // 3_600_000 ms
            expect(manager.txTimeThreshold).toBe(30_000);

            // maxGasPriceMultiplier defaults to base + 50 when not provided
            expect(manager.maxGasPriceMultiplier).toBe(150);

            // multiplier starts at the base value
            expect(manager.gasPriceMultiplier).toBe(100);
        });

        it("should use provided optional config values over the defaults", () => {
            // optional fields are provided with values distinct from the class defaults
            const manager = new GasManager({
                chainConfig: { id: 1, isSpecialL2: false } as any,
                client: { name: "mockClient" } as any,
                baseGasPriceMultiplier: 100,
                maxGasPriceMultiplier: 200,
                gasIncreasePointsPerStep: 7,
                gasIncreaseStepTime: 12_345,
                txTimeThreshold: 9_999,
            } as any);

            expect(manager.gasIncreasePointsPerStep).toBe(7);
            expect(manager.gasIncreaseStepTime).toBe(12_345);
            expect(manager.txTimeThreshold).toBe(9_999);
            // the provided maxGasPriceMultiplier is used directly
            expect(manager.maxGasPriceMultiplier).toBe(200);
        });
    });

    describe("Test onTransactionMine boundary and arithmetic", () => {
        it("should increase the multiplier when mine time equals the threshold exactly", () => {
            // a mine time equal to txTimeThreshold takes the increase branch
            gasManager.onTransactionMine({
                didMine: true,
                length: 30_000, // exactly the threshold
            });
            expect(gasManager.deadline).toBeDefined();
            expect(gasManager.gasPriceMultiplier).toBe(110); // 107 + 3
        });

        it("should set the deadline to now plus the step time when increasing", () => {
            const before = Date.now();
            gasManager.onTransactionMine({
                didMine: true,
                length: 40_000, // over threshold
            });
            const after = Date.now();
            // deadline is Date.now() + gasIncreaseStepTime, bracketed tightly
            expect(gasManager.deadline).toBeGreaterThanOrEqual(before + config.gasIncreaseStepTime);
            expect(gasManager.deadline).toBeLessThanOrEqual(after + config.gasIncreaseStepTime);
        });

        it("should not reset the multiplier when the deadline is still in the future", () => {
            // with the deadline in the future, an under-threshold mine leaves the
            // elevated multiplier in place because now < deadline
            gasManager.deadline = Date.now() + 100_000;
            gasManager.gasPriceMultiplier = 120;
            const futureDeadline = gasManager.deadline;
            gasManager.onTransactionMine({
                didMine: true,
                length: 20_000, // under threshold
            });
            expect(gasManager.gasPriceMultiplier).toBe(120); // unchanged
            expect(gasManager.deadline).toBe(futureDeadline); // unchanged
        });
    });
});
