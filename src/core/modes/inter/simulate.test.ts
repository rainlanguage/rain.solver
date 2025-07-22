import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { Pair } from "../../../order";
import { Result } from "../../../common";
import { SimulationResult } from "../../types";
import { ONE18, ONE_FLOAT } from "../../../math";
import { encodeFunctionData, encodeAbiParameters } from "viem";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { trySimulateTrade, SimulateInterOrderbookTradeArgs } from "./simulate";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xdata"),
    encodeAbiParameters: vi.fn().mockReturnValue("0xparams"),
}));

vi.mock("./utils", () => ({
    estimateProfit: vi.fn().mockReturnValue(150n),
}));

vi.mock("../../../task", () => ({
    parseRainlang: vi.fn().mockResolvedValue("0xbytecode"),
    getBountyEnsureRainlang: vi.fn().mockResolvedValue("rainlang"),
}));

vi.mock("../dryrun", () => ({
    dryrun: vi.fn(),
}));

function makeOrderDetails(ratio = 1n * ONE18): Pair {
    return {
        orderbook: "0xorderbook",
        sellToken: "0xselltoken",
        buyToken: "0xbuytoken",
        sellTokenDecimals: 18,
        buyTokenDecimals: 18,
        takeOrder: { struct: {}, quote: { ratio } },
    } as Pair;
}

function makeCounterpartyOrder(): Pair {
    return {
        orderbook: "0xcounterpartyorderbook",
        takeOrder: {
            id: "0xid",
            quote: { maxOutput: 1n, ratio: 2n },
        },
    } as Pair;
}

describe("Test trySimulateTrade", () => {
    let solver: RainSolver;
    let args: SimulateInterOrderbookTradeArgs;

    beforeEach(() => {
        vi.clearAllMocks();
        solver = {
            state: {
                gasPrice: 1n,
                chainConfig: {
                    isSpecialL2: false,
                },
                dispair: {
                    interpreter: "0xint",
                    store: "0xstore",
                },
                client: {},
            },
            appOptions: {
                genericArbAddress: "0xarb",
                gasCoveragePercentage: "0",
                gasLimitMultiplier: 120,
            },
        } as any;
        args = {
            orderDetails: makeOrderDetails(),
            counterpartyOrderDetails: makeCounterpartyOrder(),
            signer: { account: { address: "0xsigner" } },
            inputToEthPrice: "0.5",
            outputToEthPrice: "2.0",
            maximumInputFixed: 10n * ONE18,
            blockNumber: 123n,
        } as any;
    });

    it("should return error if initial dryrun fails", async () => {
        (dryrun as Mock).mockResolvedValueOnce(
            Result.err({
                spanAttributes: { stage: 1 },
                reason: "NoOpportunity",
            }),
        );

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error.spanAttributes.stage).toBe(1);
        expect(result.error.spanAttributes.oppBlockNumber).toBe(123);
        expect(result.error.spanAttributes.maxInput).toBe("10000000000000000000");
        expect(result.error.type).toBe("interOrderbook");
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage 0", async () => {
        (dryrun as Mock).mockResolvedValueOnce(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "0";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(150n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(200n);
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xarb");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("interOrderbook");

        // Assert encodeFunctionData was called correctly
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // ArbAbi
            functionName: "arb4",
            args: [
                "0xorderbook",
                {
                    data: "0xparams",
                    maximumIORatio: expect.any(String),
                    maximumInput: expect.any(String),
                    minimumInput: ONE_FLOAT,
                    orders: [{}],
                },
                {
                    evaluable: {
                        bytecode: "0x",
                        interpreter: "0xint",
                        store: "0xstore",
                    },
                    signedContext: [],
                },
            ],
        });

        // Assert encodeAbiParameters was called correctly for takeOrders2
        expect(encodeAbiParameters).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ type: "address" }),
                expect.objectContaining({ type: "address" }),
                expect.objectContaining({ type: "bytes" }),
            ]),
            ["0xcounterpartyorderbook", "0xcounterpartyorderbook", expect.any(String)],
        );
    });

    it("should return ok result if all steps succeed with gasCoveragePercentage not 0", async () => {
        (dryrun as Mock)
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                    estimatedGasCost: 200n,
                    spanAttributes: { initial: "data" },
                }),
            )
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 150n, totalGasCost: 300n, gasPrice: 1n },
                    estimatedGasCost: 300n,
                    spanAttributes: { final: "data" },
                }),
            );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "100";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(150n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(300n);
        expect(result.value.spanAttributes.initial).toBe("data");
        expect(result.value.spanAttributes.final).toBe("data");
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xarb");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("interOrderbook");

        // Verify encodeFunctionData called 3 times (initial, final, and last)
        expect(encodeFunctionData).toHaveBeenCalledTimes(4);
        expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
    });

    it("should handle zero ratio in opposing order calculations", async () => {
        (dryrun as Mock).mockResolvedValue(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = makeOrderDetails(0n); // zero ratio

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.type).toBe("interOrderbook");

        // Verify that maxUint256 is used for zero ratio
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array),
            functionName: "arb4",
            args: [
                "0xorderbook",
                expect.objectContaining({
                    maximumInput: expect.any(String),
                    maximumIORatio: expect.any(String),
                }),
                expect.any(Object),
            ],
        });
    });

    it("should return error if final dryrun fails when gasCoveragePercentage is not 0", async () => {
        (dryrun as Mock)
            .mockResolvedValueOnce(
                Result.ok({
                    estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                    estimatedGasCost: 200n,
                    spanAttributes: {},
                }),
            )
            .mockResolvedValueOnce(
                Result.err({
                    spanAttributes: { stage: 2 },
                    reason: "NoOpportunity",
                }),
            );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        solver.appOptions.gasCoveragePercentage = "100";

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error.spanAttributes.stage).toBe(2);
        expect(result.error.spanAttributes["gasEst.initial.gasLimit"]).toBe("100");
        expect(result.error.spanAttributes["gasEst.initial.totalCost"]).toBe("200");
        expect(result.error.spanAttributes["gasEst.initial.gasPrice"]).toBe("1");
        expect(result.error.spanAttributes["gasEst.initial.minBountyExpected"]).toBe("206");
        expect(result.error.type).toBe("interOrderbook");

        // Verify encodeFunctionData was called twice (for both dryruns)
        expect(encodeFunctionData).toHaveBeenCalledTimes(3);
        expect(encodeAbiParameters).toHaveBeenCalledTimes(1);
    });

    it("should handle different token decimals correctly", async () => {
        (dryrun as Mock).mockResolvedValue(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = {
            ...makeOrderDetails(1n * ONE18),
            sellTokenDecimals: 6,
            buyTokenDecimals: 8,
        };

        const result: SimulationResult = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.spanAttributes.maxInput).toBe("10000000"); // scaled to 6 decimals
        expect(result.value.type).toBe("interOrderbook");
    });
});
