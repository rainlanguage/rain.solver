import fs from "fs";
import { RainSolverBaseError } from "../error";
import { ABI, Dispair, Result } from "../common";
import { formatUnits, PublicClient, stringToHex } from "viem";
import { MetaStore, RainDocument } from "@rainlanguage/dotrain";

const metaStore = new MetaStore(false);
export const TaskEntryPoint = ["main"] as const;
export const EnsureBountyDotrain = fs.readFileSync("./tasks/ensure-bounty.rain", {
    encoding: "utf8",
});
export const WithdrawEnsureBountyDotrain = fs.readFileSync("./tasks/withdraw-ensure-bounty.rain", {
    encoding: "utf8",
});

/**
 * Get the bounty check ensure task rainlang
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExpected - Minimum expected amount
 * @param sender - The msg sender
 */
export async function getBountyEnsureRainlang(
    inputToEthPrice: bigint,
    outputToEthPrice: bigint,
    minimumExpected: bigint,
    sender: string,
): Promise<string> {
    return await RainDocument.composeText(
        EnsureBountyDotrain,
        TaskEntryPoint as any as string[],
        metaStore,
        [
            ["sender", sender],
            ["input-to-eth-price", formatUnits(inputToEthPrice, 18)],
            ["output-to-eth-price", formatUnits(outputToEthPrice, 18)],
            ["minimum-expected", formatUnits(minimumExpected, 18)],
        ],
    );
}

/**
 * Get the bounty check ensure task rainlang for clear2 withdraw
 * @param botAddress - Bot wallet address
 * @param inputToken - Input token address
 * @param outputToken - Output token address
 * @param orgInputBalance - Input token original balance
 * @param orgOutputBalance - Output token original balance
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExpected - Minimum expected amount
 * @param sender - The msg sender
 */
export async function getWithdrawEnsureRainlang(
    botAddress: string,
    inputToken: string,
    outputToken: string,
    orgInputBalance: bigint,
    orgOutputBalance: bigint,
    inputToEthPrice: bigint,
    outputToEthPrice: bigint,
    minimumExpected: bigint,
    sender: string,
): Promise<string> {
    return await RainDocument.composeText(
        WithdrawEnsureBountyDotrain,
        TaskEntryPoint as any as string[],
        metaStore,
        [
            ["sender", sender],
            ["bot-address", botAddress],
            ["input-token", inputToken],
            ["output-token", outputToken],
            ["minimum-expected", formatUnits(minimumExpected, 18)],
            ["input-to-eth-price", formatUnits(inputToEthPrice, 18)],
            ["output-to-eth-price", formatUnits(outputToEthPrice, 18)],
            ["org-input-balance", formatUnits(orgInputBalance, 18)],
            ["org-output-balance", formatUnits(orgOutputBalance, 18)],
        ],
    );
}

/**
 * Calls parse2 on a given deployer to parse the given rainlang text
 */
export async function parseRainlang(
    rainlang: string,
    client: PublicClient,
    dispair: Dispair,
): Promise<string> {
    return await client.readContract({
        address: dispair.deployer as `0x${string}`,
        abi: ABI.Deployer.Primary.Deployer,
        functionName: "parse2",
        args: [stringToHex(rainlang)],
    });
}

/** Specifies the type of the Ensure Bounty Task */
export enum EnsureBountyTaskType {
    /** internal clear against same orderbook, i.e. clear2() */
    Internal,
    /** external clear against different orderbooks or dexes, i.e. arb3() */
    External,
}

/**
 * Parameters for the Ensure Bounty Task based on the task type
 */
export type EnsureBountyTaskParams =
    | {
          type: EnsureBountyTaskType.External;
          inputToEthPrice: bigint;
          outputToEthPrice: bigint;
          minimumExpected: bigint;
          sender: string;
      }
    | {
          type: EnsureBountyTaskType.Internal;
          botAddress: string;
          inputToken: string;
          outputToken: string;
          orgInputBalance: bigint;
          orgOutputBalance: bigint;
          inputToEthPrice: bigint;
          outputToEthPrice: bigint;
          minimumExpected: bigint;
          sender: string;
      };

/** Error types for the Ensure Bounty Task */
export enum EnsureBountyTaskErrorType {
    /** Dotrain compose error */
    ComposeError,
    /** Rainlang onchain parse error */
    ParseError,
}

/**
 * Represents an error type for the Ensure Bounty Task functionalities.
 * This error class extends the `RainSolverBaseError` error class, with the `type`
 * property indicates the specific category of the error, as defined by the
 * `EnsureBountyTaskErrorType` enum. The optional `cause` property can be used to
 * attach the original error or any relevant context that led to this error.
 *
 * @example
 * ```typescript
 * // without cause
 * throw new EnsureBountyTaskError("msg", EnsureBountyTaskErrorType);
 *
 * // with cause
 * throw new EnsureBountyTaskError("msg", EnsureBountyTaskErrorType, originalError);
 * ```
 */
export class EnsureBountyTaskError extends RainSolverBaseError {
    type: EnsureBountyTaskErrorType;
    constructor(message: string, type: EnsureBountyTaskErrorType, cause?: any) {
        super(message, cause);
        this.type = type;
        this.name = "EnsureBountyTaskError";
    }
}

/**
 * Get the bytecode for the ensure bounty task based on the task type, this is used
 * for creating rainlang tasks to ensure a minimum bounty is received for a trade
 * @param params - The parameters for the ensure bounty task
 * @param client - The public client
 * @param dispair - The dispair instance
 * @returns The bytecode for the ensure bounty task
 */
export async function getEnsureBountyTaskBytecode(
    params: EnsureBountyTaskParams,
    client: PublicClient,
    dispair: Dispair,
): Promise<Result<`0x${string}`, EnsureBountyTaskError>> {
    const rainlangPromise = (async () => {
        if (params.type === EnsureBountyTaskType.External) {
            return getBountyEnsureRainlang(
                params.inputToEthPrice,
                params.outputToEthPrice,
                params.minimumExpected,
                params.sender,
            );
        } else if (params.type === EnsureBountyTaskType.Internal) {
            return getWithdrawEnsureRainlang(
                params.botAddress,
                params.inputToken,
                params.outputToken,
                params.orgInputBalance,
                params.orgOutputBalance,
                params.inputToEthPrice,
                params.outputToEthPrice,
                params.minimumExpected,
                params.sender,
            );
        } else {
            throw new Error("Invalid EnsureBountyTaskParams type");
        }
    })();

    // await rainlang compose
    let rainlang = "";
    try {
        rainlang = await rainlangPromise;
    } catch (error: any) {
        return Result.err(
            new EnsureBountyTaskError(
                "Failed to compose ensure bounty task",
                EnsureBountyTaskErrorType.ComposeError,
                error,
            ),
        );
    }

    // parse rainlang
    try {
        const bytecode = await parseRainlang(rainlang, client, dispair);
        return Result.ok(bytecode as `0x${string}`);
    } catch (error: any) {
        return Result.err(
            new EnsureBountyTaskError(
                "Failed to parse ensure bounty rainlang task",
                EnsureBountyTaskErrorType.ParseError,
                error,
            ),
        );
    }
}
