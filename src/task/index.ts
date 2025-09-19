import fs from "fs";
import { ABI, Dispair } from "../common";
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
