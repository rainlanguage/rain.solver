import { FEE_FETCH_TIMEOUT, GasManager } from ".";
import { TxType } from "../config";
import { Result, sleep } from "../common";
import { getChainGasPrice, getFeeHistoryFees, getGasPrice, getL1GasPrice } from "./price";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

vi.mock("./price", () => ({
    getGasPrice: vi.fn(),
    getL1GasPrice: vi.fn(),
    getChainGasPrice: vi.fn(),
    getFeeHistoryFees: vi.fn(),
}));

describe("Test GasManager", () => {
    let config: any;
    let gasManager: GasManager;

    beforeEach(() => {
        vi.clearAllMocks();
        config = {
            chainConfig: { id: 1, isSpecialL2: false },
            client: { name: "mockClient" } as any,
        };
        gasManager = new GasManager(config);
    });

    describe("Test init static method", () => {
        it("should init with expected values, and leave the fetches to the blocks", async () => {
            (getChainGasPrice as Mock).mockResolvedValueOnce(Result.ok(123n));
            (getL1GasPrice as Mock).mockResolvedValueOnce(Result.ok(456n));
            const manager = await GasManager.init(config);
            // the fees are fetched on new blocks, see onBlock, the timer is for the sweep command
            expect(manager.isWatchingGasPrice).toBe(false);
            expect(manager.txType).toBe(TxType.Legacy);
            expect(manager.txFees()).toEqual({ gasPrice: 123n });
            expect(manager.gasPrice).toBe(123n);
            expect(manager.l1GasPrice).toBe(456n);
            expect(manager.client).toBe(config.client);
            expect(manager.chainConfig).toBe(config.chainConfig);
            expect(getChainGasPrice).toHaveBeenCalledTimes(1);
            expect(getChainGasPrice).toHaveBeenCalledWith(config.client);
            expect(getL1GasPrice).toHaveBeenCalledWith(config.client, config.chainConfig);
            expect(getFeeHistoryFees).not.toHaveBeenCalled();
        });
    });

    describe("Test eip1559 fees", () => {
        let getBlock: Mock;

        beforeEach(() => {
            getBlock = vi.fn().mockResolvedValue({ baseFeePerGas: 5_000_000n });
            config.client = { getBlock };
            config.txType = TxType.Eip1559;
            config.gasFeeBlockInterval = 5;
            config.priorityFeePercentiles = [76, 90];
            config.maxFeeBaseFeeMultiplier = 1.5;
            config.feeHistoryBlockTag = "pending";
            (getChainGasPrice as Mock).mockResolvedValue(Result.ok(9_000_000n));
            (getL1GasPrice as Mock).mockResolvedValue(Result.ok(8n));
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 1_000_000n, nextBaseFee: 5_100_000n }),
            );
        });

        it("should init off the latest block's base fee and the fee history's tip", async () => {
            const manager = await GasManager.init(config);
            expect(getBlock).toHaveBeenCalledTimes(1);
            expect(getFeeHistoryFees).toHaveBeenCalledWith(config.client, 5, [76, 90], "pending");
            expect(manager.isEip1559).toBe(true);
            expect(manager.baseFeePerGas).toBe(5_000_000n);
            // the tip as the fee history gives it
            expect(manager.priorityFee).toBe(1_000_000n);
            // the expected gas price is the base fee plus the tip
            expect(manager.gasPrice).toBe(6_000_000n);
            // the L1 gas price is read once, the node's gas price not at all
            expect(manager.l1GasPrice).toBe(8n);
            expect(getL1GasPrice).toHaveBeenCalledTimes(1);
            expect(getChainGasPrice).not.toHaveBeenCalled();
            // the max fee is the base fee times the headroom plus the tip
            expect(manager.maxFeePerGas).toBe(7_500_000n + 1_000_000n);
            expect(manager.txFees()).toEqual({
                maxFeePerGas: 8_500_000n,
                maxPriorityFeePerGas: 1_000_000n,
            });
        });

        it("should send eip1559 txs with a tip of 0 on a chain whose blocks pay none", async () => {
            // the fee history read every reward as 0, the tip is known and it is 0
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 0n, nextBaseFee: 5_100_000n }),
            );
            const manager = await GasManager.init(config);
            expect(manager.isEip1559).toBe(true);
            expect(manager.priorityFee).toBe(0n);
            // the tx pays the base fee, the max fee keeps the headroom for it to rise
            expect(manager.gasPrice).toBe(5_000_000n);
            expect(manager.txFees()).toEqual({
                maxFeePerGas: 7_500_000n,
                maxPriorityFeePerGas: 0n,
            });
            expect(getChainGasPrice).not.toHaveBeenCalled();
            // each head's base fee goes straight into the fees
            manager.setBaseFee(6_000_000n);
            expect(manager.gasPrice).toBe(6_000_000n);
            expect(manager.maxFeePerGas).toBe(9_000_000n);
        });

        it("should read the L1 gas price alongside the fee history, not after it", async () => {
            // the fee history settles only once released, the L1 read has gone out by then
            let release: () => void = () => {};
            (getFeeHistoryFees as Mock).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = () =>
                            resolve(Result.ok({ tip: 1_000_000n, nextBaseFee: 5_000_000n }));
                    }),
            );
            const manager = new GasManager(config);
            const fetch = manager.updateFees();
            await sleep(0);
            expect(getFeeHistoryFees).toHaveBeenCalledTimes(1);
            expect(getL1GasPrice).toHaveBeenCalledTimes(1);
            release();
            await fetch;
            expect(manager.l1GasPrice).toBe(8n);
            expect(manager.isEip1559).toBe(true);
        });

        it("should send legacy txs on a chain with no base fee", async () => {
            getBlock.mockResolvedValue({ baseFeePerGas: null });
            const manager = await GasManager.init(config);
            expect(manager.isEip1559).toBe(false);
            expect(getFeeHistoryFees).not.toHaveBeenCalled();
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });
            expect(manager.l1GasPrice).toBe(8n);

            // the next fetches stay on the gas price
            (getChainGasPrice as Mock).mockResolvedValue(Result.ok(9_500_000n));
            await manager.updateFees();
            expect(getFeeHistoryFees).not.toHaveBeenCalled();
            expect(manager.txFees()).toEqual({ gasPrice: 9_500_000n });
        });

        it("should take the fee history's next base fee when no block gave one", async () => {
            getBlock.mockRejectedValue(new Error("rpc down"));
            const manager = await GasManager.init(config);
            expect(manager.baseFeePerGas).toBe(5_100_000n);
            expect(manager.gasPrice).toBe(5_100_000n + 1_000_000n);
        });

        it("should read the block again for the base fee while none is known, and never take 0 off the fee history", async () => {
            // the block read fails and the fee history gives a base fee of 0, what a
            // chain without one gives, so the chain is not taken for an eip1559 one
            getBlock.mockRejectedValue(new Error("rpc down"));
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 1_000_000n, nextBaseFee: 0n }),
            );
            const manager = await GasManager.init(config);
            expect(manager.baseFeePerGas).toBeUndefined();
            expect(manager.isEip1559).toBe(false);
            // the legacy gas price stands in
            expect(getChainGasPrice).toHaveBeenLastCalledWith(config.client);
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });
            // the tip is kept for when the base fee is known
            expect(manager.priorityFee).toBe(1_000_000n);

            // the next fetch reads the block again, a block tells the base fee
            getBlock.mockResolvedValue({ baseFeePerGas: 5_000_000n });
            await manager.updateFees();
            expect(getBlock).toHaveBeenCalledTimes(2);
            expect(manager.isEip1559).toBe(true);
            expect(manager.gasPrice).toBe(5_000_000n + 1_000_000n);

            // and not again once known
            await manager.updateFees();
            expect(getBlock).toHaveBeenCalledTimes(2);
        });

        it("should keep the legacy gas price, with the node's tip, until the tip is known", async () => {
            // the fee history has no tip, empty blocks only, so the legacy gas price
            // stands in
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: undefined, nextBaseFee: 5_000_000n }),
            );
            const manager = await GasManager.init(config);
            // the base fee is known, but a base fee alone makes no eip1559 fees
            expect(manager.baseFeePerGas).toBe(5_000_000n);
            expect(manager.isEip1559).toBe(false);
            expect(getChainGasPrice).toHaveBeenCalledWith(config.client);
            expect(manager.gasPrice).toBe(9_000_000n);
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });
            expect(manager.feeFetchFailures).toBe(0);

            // a new head's base fee does not replace the stand-in either
            manager.setBaseFee(6_000_000n);
            expect(manager.gasPrice).toBe(9_000_000n);
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });

            // once the tip is known the fees are eip1559 ones off the head's base fee
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 1_000_000n, nextBaseFee: 6_000_000n }),
            );
            await manager.updateFees();
            expect(manager.isEip1559).toBe(true);
            expect(manager.gasPrice).toBe(6_000_000n + 1_000_000n);
            expect(manager.txFees()).toEqual({
                maxFeePerGas: 9_000_000n + 1_000_000n,
                maxPriorityFeePerGas: 1_000_000n,
            });
            expect(manager.feeFetchFailures).toBe(0);
        });

        it("should not read the node's gas price twice when it failed as the tip's fallback", async () => {
            // before the first tip, the base fee is known, the fee history fails and
            // so does the node's gas price, the stand-in read is the same read
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("down")));
            (getChainGasPrice as Mock).mockResolvedValue(Result.err(new Error("down")));
            const manager = await GasManager.init(config);
            expect(getChainGasPrice).toHaveBeenCalledTimes(1);
            expect(getChainGasPrice).toHaveBeenCalledWith(config.client);
            expect(manager.isEip1559).toBe(false);
            expect(manager.gasPrice).toBe(0n);
            // the L1 gas price is read all the same
            expect(manager.l1GasPrice).toBe(8n);
            expect(manager.feeFetchFailures).toBe(1);
        });

        it("should fall to the legacy gas price while no base fee is known and the fee history fails", async () => {
            getBlock.mockRejectedValue(new Error("rpc down"));
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("unsupported")));
            const manager = await GasManager.init(config);
            expect(manager.isEip1559).toBe(false);
            expect(getChainGasPrice).toHaveBeenCalledWith(config.client);
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });
            expect(manager.l1GasPrice).toBe(8n);
            expect(manager.feeFetchFailures).toBe(1);
            expect(manager.lastFeeFetchError).toBe("unsupported");
        });

        it("should keep the previous tip when the fee history has no tip", async () => {
            const manager = await GasManager.init(config);
            (getFeeHistoryFees as Mock).mockResolvedValueOnce(Result.ok({ tip: undefined }));
            await manager.updateFees();
            expect(manager.priorityFee).toBe(1_000_000n);
            expect(manager.feeFetchFailures).toBe(0);
        });

        it("should take the tip off the node's gas price when the fee history fails, and count it", async () => {
            const manager = await GasManager.init(config);
            (getChainGasPrice as Mock).mockClear();
            (getL1GasPrice as Mock).mockClear();
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.err(Object.assign(new Error("long"), { shortMessage: "request timed out" })),
            );
            await manager.updateFees();
            // the gas price of 9,000,000 is 4,000,000 above the base fee
            expect(getChainGasPrice).toHaveBeenCalledTimes(1);
            expect(getChainGasPrice).toHaveBeenCalledWith(config.client);
            expect(manager.priorityFee).toBe(4_000_000n);
            expect(manager.gasPrice).toBe(5_000_000n + 4_000_000n);
            // the L1 gas price is read alongside as always
            expect(getL1GasPrice).toHaveBeenCalledTimes(1);
            expect(manager.l1GasPrice).toBe(8n);
            expect(manager.isEip1559).toBe(true);
            expect(manager.feeFetchFailures).toBe(1);
            expect(manager.lastFeeFetchError).toBe("request timed out");

            await manager.updateFees();
            expect(manager.feeFetchFailures).toBe(2);

            // a working fee history resets the count and takes the tip off it again
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 1_000_000n, nextBaseFee: 5_000_000n }),
            );
            await manager.updateFees();
            expect(manager.feeFetchFailures).toBe(0);
            expect(manager.lastFeeFetchError).toBeUndefined();
            expect(manager.priorityFee).toBe(1_000_000n);
        });

        it("should not leave the tip at nothing when the fee history fails from the start", async () => {
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("unsupported")));
            const manager = await GasManager.init(config);
            expect(manager.feeFetchFailures).toBe(1);
            expect(manager.lastFeeFetchError).toBe("unsupported");
            expect(manager.priorityFee).toBe(4_000_000n);
            expect(manager.txFees()).toEqual({
                maxFeePerGas: 7_500_000n + 4_000_000n,
                maxPriorityFeePerGas: 4_000_000n,
            });
        });

        it("should take a tip of 0 when the node's gas price is not above the base fee", async () => {
            const manager = await GasManager.init(config);
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("down")));
            (getChainGasPrice as Mock).mockResolvedValue(Result.ok(4_000_000n));
            await manager.updateFees();
            expect(manager.priorityFee).toBe(0n);
            expect(manager.gasPrice).toBe(5_000_000n);
        });

        it("should keep the previous tip and L1 gas price when every read fails", async () => {
            const manager = await GasManager.init(config);
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("down")));
            (getChainGasPrice as Mock).mockResolvedValue(Result.err(new Error("down")));
            (getL1GasPrice as Mock).mockResolvedValue(Result.err(new Error("down")));
            await manager.updateFees();
            expect(manager.priorityFee).toBe(1_000_000n);
            expect(manager.gasPrice).toBe(6_000_000n);
            expect(manager.l1GasPrice).toBe(8n);
            expect(manager.feeFetchFailures).toBe(1);
        });

        it("should follow each head's base fee in the gas price and the max fee", async () => {
            const manager = await GasManager.init(config);
            manager.setBaseFee(6_000_000n);
            expect(manager.gasPrice).toBe(6_000_000n + 1_000_000n);
            expect(manager.maxFeePerGas).toBe(9_000_000n + 1_000_000n);
            // a head with no base fee field changes nothing
            manager.setBaseFee(undefined);
            expect(manager.baseFeePerGas).toBe(6_000_000n);
            // a head of a chain with no base fee makes the txs legacy ones
            manager.setBaseFee(null);
            expect(manager.isEip1559).toBe(false);
            expect(manager.txFees()).toEqual({ gasPrice: 7_000_000n });
        });

        it("should send legacy txs when the type says so, even with a base fee", async () => {
            config.txType = TxType.Legacy;
            const manager = await GasManager.init(config);
            expect(getBlock).not.toHaveBeenCalled();
            manager.setBaseFee(5_000_000n);
            expect(manager.isEip1559).toBe(false);
            expect(manager.txFees()).toEqual({ gasPrice: 9_000_000n });
        });

        it("should apply the priority fee multiplier to the tip at its fetch, off the fee history and off the fallback alike", async () => {
            config.priorityFeeMultiplier = 1.07;
            const manager = await GasManager.init(config);
            expect(manager.priorityFee).toBe(1_070_000n);
            expect(manager.gasPrice).toBe(5_000_000n + 1_070_000n);
            expect(manager.txFees()).toEqual({
                maxFeePerGas: 7_500_000n + 1_070_000n,
                maxPriorityFeePerGas: 1_070_000n,
            });
            // the fallback tip of 4,000,000 off the node's gas price takes it too
            (getFeeHistoryFees as Mock).mockResolvedValue(Result.err(new Error("down")));
            await manager.updateFees();
            expect(manager.priorityFee).toBe(4_280_000n);
        });

        it("should take the fee history's tip anew at each fetch", async () => {
            const manager = await GasManager.init(config);
            (getFeeHistoryFees as Mock).mockResolvedValue(
                Result.ok({ tip: 2_000_000n, nextBaseFee: 5_000_000n }),
            );
            expect(manager.priorityFee).toBe(1_000_000n);
            await manager.updateFees();
            expect(manager.priorityFee).toBe(2_000_000n);
            expect(manager.gasPrice).toBe(7_000_000n);
        });
    });

    describe("Test onBlock method", () => {
        beforeEach(() => {
            config.gasFeeBlockInterval = 3;
            (getChainGasPrice as Mock).mockResolvedValue(Result.ok(123n));
            (getL1GasPrice as Mock).mockResolvedValue(Result.ok(0n));
        });

        it("should fetch the fees on the first block and then every interval of blocks", async () => {
            const manager = new GasManager(config);
            const fetchedAt: bigint[] = [];
            for (const block of [100n, 101n, 102n, 103n, 104n, 106n]) {
                const before = (getChainGasPrice as Mock).mock.calls.length;
                manager.onBlock(block);
                await sleep(0);
                if ((getChainGasPrice as Mock).mock.calls.length > before) fetchedAt.push(block);
            }
            expect(fetchedAt).toEqual([100n, 103n, 106n]);
            expect(manager.gasPrice).toBe(123n);
        });

        it("should not start another fetch while one is in flight", async () => {
            let release: () => void = () => {};
            (getChainGasPrice as Mock).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = () => resolve(Result.ok(1n));
                    }),
            );
            const manager = new GasManager(config);
            manager.onBlock(100n);
            manager.onBlock(103n);
            expect(getChainGasPrice).toHaveBeenCalledTimes(1);
            release();
            await sleep(0);
            manager.onBlock(106n);
            await sleep(0);
            expect(getChainGasPrice).toHaveBeenCalledTimes(2);
        });

        it("should free the guard when a fetch does not settle in time", async () => {
            vi.useFakeTimers();
            try {
                (getChainGasPrice as Mock).mockImplementationOnce(() => new Promise(() => {}));
                const manager = new GasManager(config);
                manager.onBlock(100n);
                await vi.advanceTimersByTimeAsync(FEE_FETCH_TIMEOUT - 1);
                manager.onBlock(103n);
                expect(getChainGasPrice).toHaveBeenCalledTimes(1);

                await vi.advanceTimersByTimeAsync(1);
                manager.onBlock(106n);
                await vi.advanceTimersByTimeAsync(0);
                expect(getChainGasPrice).toHaveBeenCalledTimes(2);
                expect(manager.gasPrice).toBe(123n);
            } finally {
                vi.useRealTimers();
            }
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

            expect(getGasPrice).toHaveBeenCalledWith(config.client, config.chainConfig);
            expect(gasManager.gasPrice).toBe(5555n);
            expect(gasManager.l1GasPrice).toBe(8888n);

            gasManager.unwatchGasPrice();
        });

        it("should keep the previous prices when a read fails", async () => {
            gasManager.gasPrice = 1n;
            gasManager.l1GasPrice = 2n;
            (getGasPrice as any).mockResolvedValue({
                gasPrice: Result.err(new Error("down")),
                l1GasPrice: Result.err(new Error("down")),
            });
            gasManager.watchGasPrice(10);
            await sleep(50);
            expect(gasManager.gasPrice).toBe(1n);
            expect(gasManager.l1GasPrice).toBe(2n);
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
            const manager = new GasManager({
                chainConfig: { id: 1, isSpecialL2: false } as any,
                client: { name: "mockClient" } as any,
            });
            expect(manager.txType).toBe(TxType.Legacy);
            expect(manager.gasFeeBlockInterval).toBe(10);
            expect(manager.priorityFeePercentiles).toEqual([75]);
            expect(manager.maxFeeBaseFeeMultiplier).toBe(2);
            expect(manager.priorityFeeMultiplier).toBe(1);
            expect(manager.feeHistoryBlockTag).toBeUndefined();
        });

        it("should use provided optional config values over the defaults", () => {
            const manager = new GasManager({
                chainConfig: { id: 1, isSpecialL2: false } as any,
                client: { name: "mockClient" } as any,
                txType: TxType.Eip1559,
                gasFeeBlockInterval: 7,
                priorityFeePercentiles: [60, 90],
                maxFeeBaseFeeMultiplier: 1.25,
                priorityFeeMultiplier: 1.07,
                feeHistoryBlockTag: "pending",
            });
            expect(manager.txType).toBe(TxType.Eip1559);
            expect(manager.gasFeeBlockInterval).toBe(7);
            expect(manager.priorityFeePercentiles).toEqual([60, 90]);
            expect(manager.maxFeeBaseFeeMultiplier).toBe(1.25);
            expect(manager.priorityFeeMultiplier).toBe(1.07);
            expect(manager.feeHistoryBlockTag).toBe("pending");
        });
    });
});
