import { maxUint256 } from "viem";
import { RainSolverRouterBase } from "./types";
import { Order, Pair, PairV3, PairV4 } from "../order";
import { maxFloat, minFloat, Result, toFloat } from "../common";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";

vi.mock("../common", async (importOriginal) => ({
    ...(await importOriginal()),
    maxFloat: vi.fn(),
    minFloat: vi.fn(),
    toFloat: vi.fn(),
}));

// mock class extending RainSolverRouterBase for testing
class MockRouter extends RainSolverRouterBase {
    getMarketPrice = vi.fn();
    tryQuote = vi.fn();
    findBestRoute = vi.fn();
    getLiquidityProvidersList = vi.fn();
    getTradeParams = vi.fn();
}

describe("Test RainSolverRouterBase", () => {
    describe("Test getTakeOrdersConfigV3 method", () => {
        let router: MockRouter;
        let order: PairV3;
        const maximumInput = 100n;
        const price = 200n;
        const data = "0xdata" as `0x${string}`;
        const maxRatio = true;
        const isPartial = false;

        beforeEach(() => {
            vi.clearAllMocks();
            router = new MockRouter(1, {} as any);
            order = {
                takeOrder: {
                    struct: {
                        order: { type: Order.Type.V3 },
                    },
                },
            } as any;
        });

        it("should return correct config", () => {
            const result = router.getTakeOrdersConfigV3(
                order,
                maximumInput,
                price,
                data,
                maxRatio,
                isPartial,
            );
            expect(result).toEqual({
                minimumInput: 1n,
                maximumInput: maxUint256,
                maximumIORatio: maxUint256,
                orders: [order.takeOrder.struct],
                data,
            });
        });
    });

    describe("Test getTakeOrdersConfigV4 method", () => {
        let router: MockRouter;
        let order: PairV4;
        const maximumInput = 100n;
        const price = 200n;
        const data = "0xdata" as `0x${string}`;

        beforeEach(() => {
            vi.clearAllMocks();
            router = new MockRouter(1, {} as any);
            order = {
                sellTokenDecimals: 6,
                takeOrder: {
                    struct: {
                        order: { type: Order.Type.V3 },
                    },
                },
            } as any;
        });

        it("should return correct config", () => {
            (maxFloat as Mock).mockReturnValue("0xff");
            (minFloat as Mock).mockReturnValue("0x01");
            (toFloat as Mock).mockReturnValue(Result.ok("0x1234"));
            const result = router.getTakeOrdersConfigV4(
                order,
                maximumInput,
                price,
                data,
                true,
                false,
            );
            assert(result.isOk());
            expect(result.value).toEqual({
                minimumInput: "0x01",
                maximumInput: "0xff",
                maximumIORatio: "0xff",
                orders: [order.takeOrder.struct],
                data,
            });
            expect(maxFloat).toHaveBeenCalledTimes(2);
            expect(maxFloat).toHaveBeenCalledWith(18);
            expect(maxFloat).toHaveBeenCalledWith(6);
            expect(minFloat).toHaveBeenCalledTimes(1);
            expect(minFloat).toHaveBeenCalledWith(6);
            expect(toFloat).not.toHaveBeenCalled();
        });

        it("should return correct config partial true", () => {
            (maxFloat as Mock).mockReturnValue("0xff");
            (minFloat as Mock).mockReturnValue("0x01");
            (toFloat as Mock).mockReturnValue(Result.ok("0x1234"));
            const result = router.getTakeOrdersConfigV4(
                order,
                maximumInput,
                price,
                data,
                true,
                true,
            );
            assert(result.isOk());
            expect(result.value).toEqual({
                minimumInput: "0x01",
                maximumInput: "0x1234",
                maximumIORatio: "0xff",
                orders: [order.takeOrder.struct],
                data,
            });
            expect(maxFloat).toHaveBeenCalledTimes(2);
            expect(maxFloat).toHaveBeenCalledWith(18);
            expect(maxFloat).toHaveBeenCalledWith(6);
            expect(minFloat).toHaveBeenCalledTimes(1);
            expect(minFloat).toHaveBeenCalledWith(6);
            expect(toFloat).toHaveBeenCalledTimes(1);
            expect(toFloat).toHaveBeenCalledWith(maximumInput, 6);
        });

        it("should return correct config maxRatio false", () => {
            (maxFloat as Mock).mockReturnValue("0xff");
            (minFloat as Mock).mockReturnValue("0x01");
            (toFloat as Mock).mockReturnValue(Result.ok("0x1234"));
            const result = router.getTakeOrdersConfigV4(
                order,
                maximumInput,
                price,
                data,
                false,
                false,
            );
            assert(result.isOk());
            expect(result.value).toEqual({
                minimumInput: "0x01",
                maximumInput: "0xff",
                maximumIORatio: "0x1234",
                orders: [order.takeOrder.struct],
                data,
            });
            expect(maxFloat).toHaveBeenCalledTimes(2);
            expect(maxFloat).toHaveBeenCalledWith(18);
            expect(maxFloat).toHaveBeenCalledWith(6);
            expect(minFloat).toHaveBeenCalledTimes(1);
            expect(minFloat).toHaveBeenCalledWith(6);
            expect(toFloat).toHaveBeenCalledTimes(1);
            expect(toFloat).toHaveBeenCalledWith(price, 18);
        });

        it("should return error when toFloat fails", () => {
            (maxFloat as Mock).mockReturnValue("0xff");
            (minFloat as Mock).mockReturnValue("0x01");
            (toFloat as Mock).mockReturnValue(Result.err({ readableMsg: "some error" }));
            const result = router.getTakeOrdersConfigV4(
                order,
                maximumInput,
                price,
                data,
                true,
                true,
            );
            assert(result.isErr());
            expect(result.error.readableMsg).toBe("some error");
            expect(maxFloat).toHaveBeenCalledTimes(1);
            expect(maxFloat).toHaveBeenCalledWith(6);
            expect(minFloat).not.toHaveBeenCalled();
            expect(toFloat).toHaveBeenCalledTimes(1);
            expect(toFloat).toHaveBeenCalledWith(maximumInput, 6);
        });
    });

    describe("Test getTakeOrdersConfig method", () => {
        let router: MockRouter;
        let order: Pair;
        const maximumInput = 100n;
        const price = 200n;
        const data = "0xdata" as `0x${string}`;
        const maxRatio = true;
        const isPartial = false;

        beforeEach(() => {
            vi.clearAllMocks();
            router = new MockRouter(1, {} as any);
            order = {
                takeOrder: {
                    struct: {
                        order: { type: Order.Type.V3 },
                    },
                },
            } as any;
        });

        it("should return v3 result", () => {
            const spy = vi.spyOn(router, "getTakeOrdersConfigV3");
            router.getTakeOrdersConfig(order, maximumInput, price, data, maxRatio, isPartial);
            expect(spy).toHaveBeenCalledWith(order, maximumInput, price, data, maxRatio, isPartial);

            spy.mockRestore();
        });

        it("should return v4 result", () => {
            order.takeOrder.struct.order.type = Order.Type.V4;
            const spy = vi.spyOn(router, "getTakeOrdersConfigV4");
            router.getTakeOrdersConfig(order, maximumInput, price, data, maxRatio, isPartial);
            expect(spy).toHaveBeenCalledWith(order, maximumInput, price, data, maxRatio, isPartial);

            spy.mockRestore();
        });
    });
});
