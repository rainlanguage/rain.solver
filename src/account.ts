import { erc20Abi, PublicClient } from "viem";
import { SharedState, TokenDetails } from "./state";
import { RPParams } from "sushi";
import { BigNumber, ethers } from "ethers";
import { getTxFee } from "./gas";
import { errorSnapshot } from "./error";
import { Native, Token } from "sushi/currency";
import { ROUTE_PROCESSOR_4_ADDRESS } from "sushi/config";
import { getRpSwap } from "./utils";
import { BotConfig, OwnedOrder } from "./types";
import { MulticallAbi, orderbookAbi, routeProcessor3Abi, VaultBalanceAbi } from "./abis";
import { BundledOrders } from "./order";
import { RainSolverSigner } from "./signer";

/**
 * Rotates accounts by putting the first one in last place
 * @param accounts - Array of accounts to rotate
 */
export function rotateAccounts(accounts: RainSolverSigner[]) {
    if (accounts && Array.isArray(accounts) && accounts.length > 1) {
        accounts.push(accounts.shift()!);
    }
}

/**
 * Get eth balance of multiple accounts using multicall
 * @param addresses - The addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchEthBalance(
    addresses: string[],
    viemClient: PublicClient,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: addresses.map((v) => ({
                address: (multicallAddressOverride ??
                    viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain?.id,
                abi: MulticallAbi,
                functionName: "getEthBalance",
                args: [v],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Get balance of multiple erc20 tokens for an account using multicall3
 * @param address - The address to get its token balances
 * @param tokens - The token addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchTokenBalanceForAccount(
    address: string,
    tokens: TokenDetails[],
    viemClient: RainSolverSigner,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: tokens.map((v) => ({
                address: v.address as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain.id,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Funds the sepcified bot owned orders from the gas token
 * @param ownedOrders
 * @param config
 */
export async function fundOwnedOrders(
    ownedOrders: OwnedOrder[],
    config: BotConfig,
    state: SharedState,
): Promise<{ ownedOrder?: OwnedOrder; error: string }[]> {
    const failedFundings: { ownedOrder?: OwnedOrder; error: string }[] = [];
    const ob = new ethers.utils.Interface(orderbookAbi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const rp4Address =
        ROUTE_PROCESSOR_4_ADDRESS[config.chain.id as keyof typeof ROUTE_PROCESSOR_4_ADDRESS];
    const gasPrice = ethers.BigNumber.from(state.gasPrice);
    if (config.selfFundOrders) {
        for (let i = 0; i < ownedOrders.length; i++) {
            const ownedOrder = ownedOrders[i];
            const vaultId = ethers.BigNumber.from(ownedOrder.vaultId);
            const fundingOrder = config.selfFundOrders.find(
                (e) =>
                    e.token.toLowerCase() === ownedOrder.token.toLowerCase() &&
                    vaultId.eq(e.vaultId),
            );
            if (fundingOrder) {
                if (
                    ownedOrder.vaultBalance.lt(
                        ethers.utils.parseUnits(fundingOrder.threshold, ownedOrder.decimals),
                    )
                ) {
                    const topupAmount = ethers.utils.parseUnits(
                        fundingOrder.topupAmount,
                        ownedOrder.decimals,
                    );
                    try {
                        const balance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("balanceOf", [
                                    config.mainAccount.account.address,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (balance && topupAmount.gt(balance)) {
                            const token = new Token({
                                chainId: config.chain.id,
                                decimals: ownedOrder.decimals,
                                address: ownedOrder.token,
                                symbol: ownedOrder.symbol,
                            });
                            const { route } = await getRpSwap(
                                config.chain.id,
                                topupAmount,
                                token,
                                Native.onChain(config.chain.id),
                                config.mainAccount.account.address,
                                rp4Address,
                                config.dataFetcher,
                                gasPrice,
                                undefined,
                                true,
                            );
                            const initSellAmount = ethers.BigNumber.from(route.amountOutBI);
                            let sellAmount: BigNumber;
                            let finalRpParams: RPParams;
                            for (let j = 0; j < 25; j++) {
                                sellAmount = initSellAmount.mul(100 + j).div(100);
                                const { rpParams, route } = await getRpSwap(
                                    config.chain.id,
                                    sellAmount,
                                    Native.onChain(config.chain.id),
                                    token,
                                    config.mainAccount.account.address,
                                    rp4Address,
                                    config.dataFetcher,
                                    gasPrice,
                                    undefined,
                                    true,
                                );
                                if (topupAmount.lte(route.amountOutBI)) {
                                    finalRpParams = rpParams;
                                    break;
                                }
                            }
                            const data = rp.encodeFunctionData("processRoute", [
                                finalRpParams!.tokenIn,
                                finalRpParams!.amountIn,
                                finalRpParams!.tokenOut,
                                finalRpParams!.amountOutMin,
                                finalRpParams!.to,
                                finalRpParams!.routeCode,
                            ]) as `0x${string}`;
                            const swapHash = await config.mainAccount.sendTx({
                                to: rp4Address,
                                value: sellAmount!.toBigInt(),
                                data,
                            });
                            const swapReceipt = await config.mainAccount.waitForTransactionReceipt({
                                hash: swapHash,
                                confirmations: 4,
                                timeout: 100_000,
                            });
                            const swapTxCost = ethers.BigNumber.from(getTxFee(swapReceipt, config));
                            config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(swapTxCost);
                            if (swapReceipt.status === "success") {
                                config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(
                                    sellAmount!,
                                );
                            } else {
                                throw "failed to swap eth to vault token";
                            }
                        }

                        const allowance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("allowance", [
                                    config.mainAccount.account.address,
                                    ownedOrder.orderbook,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (allowance && topupAmount.gt(allowance)) {
                            const approveHash = await config.mainAccount.sendTx({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("approve", [
                                    ownedOrder.orderbook,
                                    topupAmount.mul(20),
                                ]) as `0x${string}`,
                            });
                            const approveReceipt =
                                await config.mainAccount.waitForTransactionReceipt({
                                    hash: approveHash,
                                    confirmations: 4,
                                    timeout: 100_000,
                                });
                            const approveTxCost = ethers.BigNumber.from(
                                getTxFee(approveReceipt, config),
                            );
                            config.mainAccount.BALANCE =
                                config.mainAccount.BALANCE.sub(approveTxCost);
                            if (approveReceipt.status === "reverted") {
                                throw "failed to approve token spend";
                            }
                        }

                        const hash = await config.mainAccount.sendTx({
                            to: ownedOrder.orderbook as `0x${string}`,
                            data: ob.encodeFunctionData("deposit2", [
                                ownedOrder.token,
                                vaultId,
                                topupAmount,
                                [],
                            ]) as `0x${string}`,
                        });
                        const receipt = await config.mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 4,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(getTxFee(receipt, config));
                        config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(txCost);
                        if (receipt.status === "success") {
                            ownedOrder.vaultBalance = ownedOrder.vaultBalance.add(topupAmount);
                        }
                    } catch (error) {
                        failedFundings.push({
                            ownedOrder,
                            error: errorSnapshot("Failed to fund owned vault", error),
                        });
                    }
                }
            }
        }
    }
    return failedFundings;
}

/**
 * Quotes order details that are already fetched and bundled by bundleOrder()
 * @param config - Config obj
 * @param orderDetails - Order details to quote
 * @param multicallAddressOverride - Optional multicall address
 */
export async function checkOwnedOrders(
    config: BotConfig,
    orderDetails: BundledOrders[][],
    multicallAddressOverride?: string,
): Promise<OwnedOrder[]> {
    const ownedOrders: any[] = [];
    const result: OwnedOrder[] = [];
    orderDetails.flat().forEach((v) => {
        v.takeOrders.forEach((order) => {
            if (
                // owner check
                order.takeOrder.order.owner.toLowerCase() ===
                    config.mainAccount.account.address.toLowerCase() &&
                // self fund config check
                !!(config.selfFundOrders ?? []).find(
                    (e) =>
                        e.token.toLowerCase() ===
                            order.takeOrder.order.validOutputs[
                                order.takeOrder.outputIOIndex
                            ].token.toLowerCase() &&
                        BigNumber.from(
                            order.takeOrder.order.validOutputs[order.takeOrder.outputIOIndex]
                                .vaultId,
                        ).eq(e.vaultId),
                ) &&
                // repetition check
                !ownedOrders.find(
                    (e) =>
                        e.orderbook.toLowerCase() === v.orderbook.toLowerCase() &&
                        e.outputToken.toLowerCase() === v.sellToken.toLowerCase() &&
                        e.order.takeOrder.order.validOutputs[
                            e.order.takeOrder.outputIOIndex
                        ].token.toLowerCase() ==
                            order.takeOrder.order.validOutputs[
                                order.takeOrder.outputIOIndex
                            ].token.toLowerCase() &&
                        ethers.BigNumber.from(
                            e.order.takeOrder.order.validOutputs[e.order.takeOrder.outputIOIndex]
                                .vaultId,
                        ).eq(
                            order.takeOrder.order.validOutputs[order.takeOrder.outputIOIndex]
                                .vaultId,
                        ),
                )
            ) {
                ownedOrders.push({
                    order,
                    orderbook: v.orderbook,
                    outputSymbol: v.sellTokenSymbol,
                    outputToken: v.sellToken,
                    outputDecimals: v.sellTokenDecimals,
                });
            }
        });
    });
    if (!ownedOrders.length) return result;
    try {
        const multicallResult = await config.viemClient.multicall({
            multicallAddress:
                (multicallAddressOverride as `0x${string}` | undefined) ??
                config.viemClient.chain?.contracts?.multicall3?.address,
            allowFailure: false,
            contracts: ownedOrders.map((v) => ({
                address: v.orderbook,
                allowFailure: false,
                chainId: config.chain.id,
                abi: VaultBalanceAbi,
                functionName: "vaultBalance",
                args: [
                    // owner
                    v.order.takeOrder.order.owner,
                    // token
                    v.order.takeOrder.order.validOutputs[v.order.takeOrder.outputIOIndex].token,
                    // valut id
                    v.order.takeOrder.order.validOutputs[v.order.takeOrder.outputIOIndex].vaultId,
                ],
            })),
        });
        for (let i = 0; i < multicallResult.length; i++) {
            let vaultId =
                ownedOrders[i].order.takeOrder.order.validOutputs[
                    ownedOrders[i].order.takeOrder.outputIOIndex
                ].vaultId;
            if (vaultId instanceof BigNumber) vaultId = vaultId.toHexString();
            result.push({
                vaultId,
                id: ownedOrders[i].order.id,
                token: ownedOrders[i].outputToken,
                symbol: ownedOrders[i].outputSymbol,
                decimals: ownedOrders[i].outputDecimals,
                orderbook: ownedOrders[i].orderbook,
                vaultBalance: ethers.BigNumber.from(multicallResult[i]),
            });
        }
    } catch (e) {
        /**/
    }
    return result;
}
