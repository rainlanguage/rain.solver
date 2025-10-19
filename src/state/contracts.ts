import { Pair } from "../order";
import { PublicClient } from "viem";
import { ABI, Dispair } from "../common";
import { TradeType } from "../core/types";
import { AppOptions, AppOptionsContracts } from "../config";

export type TradeAddresses = {
    dispair: Dispair;
    destination: `0x${string}`;
};

/** Keeps list of contract addresses required for working with different versions of the protocol */
export type SolverContracts = {
    v4?: {
        sushiArb?: `0x${string}`;
        genericArb?: `0x${string}`;
        balancerArb?: `0x${string}`;
        stabullArb?: `0x${string}`;
        dispair: Dispair;
    };
    v5?: {
        sushiArb?: `0x${string}`;
        genericArb?: `0x${string}`;
        balancerArb?: `0x${string}`;
        stabullArb?: `0x${string}`;
        dispair: Dispair;
    };

    /**
     * Gets the addresses required for the given order and optional trade type to trade
     * @param order - The order to get addresses for
     * @param tradeType - The type of trade to get addresses for (optional)
     * @returns The trade addresses or undefined if not found
     */
    getAddressesForTrade(order: Pair, tradeType?: TradeType): TradeAddresses | undefined;
};
export namespace SolverContracts {
    /** Creates a SolverContracts instance from AppOptions */
    export async function fromAppOptions(
        client: PublicClient,
        options: AppOptions,
    ): Promise<SolverContracts> {
        const contracts: SolverContracts = {
            v4: await resolveVersionContracts(client, options.contracts.v4),
            v5: await resolveVersionContracts(client, options.contracts.v5),

            getAddressesForTrade(order: Pair, tradeType?: TradeType): TradeAddresses | undefined {
                if (Pair.isV3(order) && this.v4) {
                    return versionAddressGetter(this.v4, order, tradeType);
                }
                if (Pair.isV4(order) && this.v5) {
                    return versionAddressGetter(this.v5, order, tradeType);
                }
                return undefined;
            },
        };
        return contracts;
    }
}

export async function resolveVersionContracts(
    client: PublicClient,
    addresses: AppOptionsContracts["v4" | "v5"] | undefined,
): Promise<SolverContracts["v4" | "v5"] | undefined> {
    if (!addresses || !addresses.dispair) {
        return undefined;
    }
    const interpreter = await client
        .readContract({
            address: addresses.dispair,
            functionName: "iInterpreter",
            abi: ABI.Deployer.Primary.Deployer,
        })
        .catch(() => undefined);
    if (!interpreter) {
        return undefined;
    }

    const store = await client
        .readContract({
            address: addresses.dispair,
            functionName: "iStore",
            abi: ABI.Deployer.Primary.Deployer,
        })
        .catch(() => undefined);
    if (!store) {
        return undefined;
    }

    const result: any = {
        dispair: {
            deployer: addresses.dispair,
            interpreter,
            store,
        },
    };
    if (addresses.sushiArb) {
        result.sushiArb = addresses.sushiArb;
    }
    if (addresses.genericArb) {
        result.genericArb = addresses.genericArb;
    }
    if (addresses.balancerArb) {
        result.balancerArb = addresses.balancerArb;
    }
    if (addresses.stabullArb) {
        result.stabullArb = addresses.stabullArb;
    }
    return result;
}

export function versionAddressGetter<
    const T extends keyof Omit<SolverContracts, "getAddressesForTrade">,
>(
    contracts: NonNullable<SolverContracts[T]>,
    order: Pair,
    tradeType?: TradeType,
): TradeAddresses | undefined {
    if (!tradeType) {
        return {
            dispair: contracts.dispair,
            destination: "0x",
        };
    }
    switch (tradeType) {
        case TradeType.Router: {
            if (contracts.sushiArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.sushiArb,
                };
            }
            if (contracts.balancerArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.balancerArb,
                };
            }
            if (contracts.stabullArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.stabullArb,
                };
            }
            return undefined;
        }
        case TradeType.RouteProcessor: {
            if (contracts.sushiArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.sushiArb,
                };
            }
            return undefined;
        }
        case TradeType.Balancer: {
            if (contracts.balancerArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.balancerArb,
                };
            }
            return undefined;
        }
        case TradeType.Stabull: {
            if (contracts.stabullArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.stabullArb,
                };
            }
            return undefined;
        }
        case TradeType.InterOrderbook: {
            if (contracts.genericArb) {
                return {
                    dispair: contracts.dispair,
                    destination: contracts.genericArb,
                };
            }
            return undefined;
        }
        case TradeType.IntraOrderbook: {
            return {
                dispair: contracts.dispair,
                destination: order.orderbook as `0x${string}`,
            };
        }
        default: {
            return undefined;
        }
    }
}
