import { Router } from "sushi";
import { ABI } from "../common";
import { SelfFundVault } from "../config";
import { RainSolverSigner } from "../signer";
import { Native, Token } from "sushi/currency";
import { erc20Abi, maxUint256, parseUnits } from "viem";
import { findMultiRouteExactOut, RToken } from "sushi/tines";

/**
 * Funds the vault with the given details
 * @param details - The details of the vault to fund
 * @param signer - The signer to use for the funding
 * @returns The result of the funding process
 */
export async function fundVault(details: SelfFundVault, signer: RainSolverSigner) {
    const rp4Address = signer.state.chainConfig.routeProcessors["4"] as `0x${string}`;
    const gasToken = Native.onChain(signer.chain.id);

    // get cuirrent vault balance
    const balance = await signer.readContract({
        address: details.orderbook as `0x${string}`,
        abi: [ABI.Orderbook.V4.Primary.Orderbook[3]],
        functionName: "vaultBalance",
        args: [
            signer.account.address as `0x${string}`, // owner
            details.token as `0x${string}`, // token
            BigInt(details.vaultId), // valut id
        ],
    });

    // get token details of the vault token
    const vaultToken = await (async () => {
        let tokenDetails = signer.state.watchedTokens.get(details.token.toLowerCase());
        // try to fetch the details from onchain if not already found in watched tokens list
        if (!tokenDetails) {
            const decimals = await signer.readContract({
                address: details.token as `0x${string}`,
                abi: erc20Abi,
                functionName: "decimals",
            });
            // symbol is not breaking, unlike decimals
            const symbol = await signer
                .readContract({
                    address: details.token as `0x${string}`,
                    abi: erc20Abi,
                    functionName: "symbol",
                })
                .catch(() => "UnknownSymbol");
            tokenDetails = {
                symbol,
                decimals,
                address: details.token as `0x${string}`,
            };
            signer.state.watchToken(tokenDetails); // add the token to watch list
        }
        return new Token({
            chainId: signer.state.chainConfig.id,
            decimals: tokenDetails.decimals,
            address: tokenDetails.address,
            symbol: tokenDetails.symbol,
        });
    })();

    // proceed to deposit into the vault if the vault balance is below the threshold
    if (balance < parseUnits(details.threshold, vaultToken.decimals)) {
        const topupAmount = parseUnits(details.topupAmount, vaultToken.decimals);
        const signerTokenBalance = await signer.readContract({
            address: vaultToken.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [signer.account.address],
        });

        // convert gas to the vault token for depositing only in case the current balance is insufficient
        if (topupAmount > signerTokenBalance) {
            await signer.state.router.sushi?.update();
            await signer.state.router.sushi?.dataFetcher.fetchPoolsForToken(gasToken, vaultToken);
            const pcMap = signer.state.router.sushi!.dataFetcher.getCurrentPoolCodeMap(
                gasToken,
                vaultToken,
            );
            const network = {
                chainId: signer.chain.id,
                gasPrice: Number(signer.state.gasPrice),
                baseToken: signer.state.chainConfig.nativeWrappedToken as RToken,
            };
            // find best route and build swap contract call params,
            // since know what amount of vault token we need for depositing,
            // we calculate the input amount from the output (topup amount)
            const route = findMultiRouteExactOut(
                {
                    address: "",
                    name: gasToken.name,
                    symbol: gasToken.symbol,
                    chainId: gasToken.chainId,
                    decimals: 18,
                } as RToken,
                vaultToken as RToken,
                (topupAmount * 105n) / 100n, // swap 5% more just to make sure
                Array.from(pcMap.values()).map((v) => v.pool),
                [network],
                Number(signer.state.gasPrice),
                1,
            );
            route.legs = route.legs.map((l) => ({
                ...l,
                poolName: pcMap.get(l.poolAddress)?.poolName ?? "Unknown Pool",
            }));
            const rpParams = Router.routeProcessor4Params(
                pcMap,
                route,
                gasToken,
                vaultToken,
                signer.account.address,
                rp4Address,
            );

            // perform the swap
            const hash = await signer.sendTx({
                to: rp4Address,
                data: rpParams.data as `0x${string}`,
                value: route.amountInBI,
            });
            const receipt = await signer.waitForReceipt({ hash });
            if (receipt.status === "reverted") {
                throw new Error(
                    "Failed to swap gas to target token to acquire the balance needed for depositing into the vault, reason: transaction reverted onchain",
                );
            }
        }

        // check allowance and increase it if neeeded
        const allowance = await signer.readContract({
            address: vaultToken.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [signer.account.address, details.orderbook as `0x${string}`],
        });
        if (topupAmount > allowance) {
            const hash = await signer.writeContract({
                address: vaultToken.address,
                abi: erc20Abi,
                functionName: "approve",
                args: [details.orderbook as `0x${string}`, maxUint256],
            });
            const receipt = await signer.waitForReceipt({ hash });
            if (receipt.status === "reverted") {
                throw new Error(
                    "Failed to approve token spend cap for depositing, reason: transaction reverted onchain",
                );
            }
        }

        // deposit the topup amount into the vault
        const hash = await signer.writeContract({
            address: details.orderbook as `0x${string}`,
            abi: [ABI.Orderbook.V4.Primary.Orderbook[4]],
            functionName: "deposit2",
            args: [vaultToken.address, BigInt(details.vaultId), topupAmount, []],
        });
        const receipt = await signer.waitForReceipt({ hash });
        if (receipt.status === "success") {
            return { txHash: hash };
        } else {
            throw {
                txHash: hash,
                error: new Error("Failed to deposit, reason: transaction reverted onchain"),
            };
        }
    }
}
