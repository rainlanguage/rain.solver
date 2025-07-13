import { dryrun } from "../dryrun";
import { RainSolver } from "../..";
import { ONE18 } from "../../../math";
import { Result } from "../../../common";
import { encodeFunctionData } from "viem";
import { Pair, TakeOrderDetails } from "../../../order";
import { describe, it, expect, vi, beforeEach, Mock, assert } from "vitest";
import { trySimulateTrade, SimulateIntraOrderbookTradeArgs } from "./simulation";

vi.mock("viem", async (importOriginal) => ({
    ...(await importOriginal()),
    encodeFunctionData: vi.fn().mockReturnValue("0xdata"),
}));

vi.mock("./utils", () => ({
    estimateProfit: vi.fn().mockReturnValue(200n),
}));

vi.mock("../../../task", () => ({
    parseRainlang: vi.fn().mockResolvedValue("0xbytecode"),
    getWithdrawEnsureRainlang: vi.fn().mockResolvedValue("rainlang"),
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
        takeOrder: {
            takeOrder: {
                order: {},
                inputIOIndex: 0,
                outputIOIndex: 1,
            },
            quote: { ratio },
        },
    } as Pair;
}

function makeCounterpartyOrder(): TakeOrderDetails {
    return {
        id: "0xid",
        quote: { maxOutput: 1n, ratio: 2n },
        takeOrder: {
            order: {},
            inputIOIndex: 1,
            outputIOIndex: 0,
        },
    } as TakeOrderDetails;
}

describe("Test trySimulateTrade", () => {
    let solver: RainSolver;
    let args: SimulateIntraOrderbookTradeArgs;

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
                arbAddress: "0xarb",
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
            inputBalance: 5n * ONE18,
            outputBalance: 3n * ONE18,
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

        const result = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error.spanAttributes.stage).toBe(1);
        expect(result.error.spanAttributes.oppBlockNumber).toBe(123);
        expect(result.error.type).toBe("intraOrderbook");
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

        const result = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(200n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(200n);
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xorderbook");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("intraOrderbook");

        // assert encodeFunctionData was called correctly for multicall
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // OrderbookMulticallAbi
            functionName: "multicall",
            args: [expect.any(Array)],
        });

        // assert encodeFunctionData was called for clear2
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // Clear2Abi
            functionName: "clear2",
            args: [
                {},
                {},
                {
                    aliceInputIOIndex: 0n,
                    aliceOutputIOIndex: 1n,
                    bobInputIOIndex: 1n,
                    bobOutputIOIndex: 0n,
                    aliceBountyVaultId: 1n,
                    bobBountyVaultId: 1n,
                },
                [],
                [],
            ],
        });

        // assert encodeFunctionData was called for withdraw2 (input)
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // Withdraw2Abi
            functionName: "withdraw2",
            args: ["0xbuytoken", 1n, expect.any(BigInt), []],
        });

        // assert encodeFunctionData was called for withdraw2 (output)
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array), // Withdraw2Abi
            functionName: "withdraw2",
            args: ["0xselltoken", 1n, expect.any(BigInt), []],
        });
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

        const result = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value).toHaveProperty("spanAttributes");
        expect(result.value).toHaveProperty("rawtx");
        expect(result.value).toHaveProperty("estimatedGasCost");
        expect(result.value).toHaveProperty("oppBlockNumber");
        expect(result.value).toHaveProperty("estimatedProfit");
        expect(result.value.estimatedProfit).toBe(200n);
        expect(result.value.oppBlockNumber).toBe(Number(args.blockNumber));
        expect(result.value.spanAttributes.foundOpp).toBe(true);
        expect(result.value.estimatedGasCost).toBe(300n);
        expect(result.value.spanAttributes.initial).toBe("data");
        expect(result.value.spanAttributes.final).toBe("data");
        expect(result.value.rawtx).toHaveProperty("data", "0xdata");
        expect(result.value.rawtx).toHaveProperty("to", "0xorderbook");
        expect(result.value.rawtx).toHaveProperty("gasPrice", 1n);
        expect(result.value.type).toBe("intraOrderbook");

        // verify encodeFunctionData called multiple times (initial, final, and last)
        expect(encodeFunctionData).toHaveBeenCalledTimes(8); // 4 calls * 2 dryruns
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

        const result = await trySimulateTrade.call(solver, args);

        assert(result.isErr());
        expect(result.error).toHaveProperty("spanAttributes");
        expect(result.error.spanAttributes.stage).toBe(2);
        expect(result.error.spanAttributes["gasEst.initial.gasLimit"]).toBe("100");
        expect(result.error.spanAttributes["gasEst.initial.totalCost"]).toBe("200");
        expect(result.error.spanAttributes["gasEst.initial.gasPrice"]).toBe("1");
        expect(result.error.spanAttributes["gasEst.initial.minBountyExpected"]).toBe("206");
        expect(result.error.type).toBe("intraOrderbook");

        // verify encodeFunctionData was called for both dryruns
        expect(encodeFunctionData).toHaveBeenCalledTimes(6); // 3 calls * 2 dryruns
    });

    it("should handle different input/output IO indices correctly", async () => {
        (dryrun as Mock).mockResolvedValue(
            Result.ok({
                estimation: { gas: 100n, totalGasCost: 200n, gasPrice: 1n },
                estimatedGasCost: 200n,
                spanAttributes: {},
            }),
        );
        args.orderDetails = makeOrderDetails(1n * ONE18);
        args.orderDetails.takeOrder.takeOrder.inputIOIndex = 2;
        args.orderDetails.takeOrder.takeOrder.outputIOIndex = 3;
        args.counterpartyOrderDetails.takeOrder.inputIOIndex = 4;
        args.counterpartyOrderDetails.takeOrder.outputIOIndex = 5;

        const result = await trySimulateTrade.call(solver, args);

        assert(result.isOk());
        expect(result.value.spanAttributes.foundOpp).toBe(true);

        // verify clear2 was called with correct IO indices
        expect(encodeFunctionData).toHaveBeenCalledWith({
            abi: expect.any(Array),
            functionName: "clear2",
            args: [
                {},
                {},
                {
                    aliceInputIOIndex: 2n,
                    aliceOutputIOIndex: 3n,
                    bobInputIOIndex: 4n,
                    bobOutputIOIndex: 5n,
                    aliceBountyVaultId: 1n,
                    bobBountyVaultId: 1n,
                },
                [],
                [],
            ],
        });
    });
});
