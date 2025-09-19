import { erc20Abi } from "viem";
import { SgOrder } from "../subgraph";
import { SharedState } from "../state";
import { shuffleArray } from "../utils";
import { quoteSingleOrder } from "./quote";
import { PreAssembledSpan } from "../logger";
import { SubgraphManager } from "../subgraph";
import { buildOrderbookTokenOwnerVaultsMap, downscaleProtection } from "./protection";
import {
    Pair,
    Order,
    BundledOrders,
    OrdersProfileMap,
    OwnersProfileMap,
    OrderbooksOwnersProfileMap,
} from "./types";

export * from "./types";
export * from "./quote";
export * from "./config";

/** The default owner limit */
export const DEFAULT_OWNER_LIMIT = 25 as const;

/**
 * OrderManager is responsible for managing orders state for Rainsolver during runtime, it
 * extends SubgraphManager to fetch and sync order details from subgraphs as well as providing
 * list of orders for next round and scaling owner limits for protection against order spam
 */
export class OrderManager {
    /** Quote gas limit */
    readonly quoteGas: bigint;
    /** Owner limits per round */
    readonly ownerLimits: Record<string, number>;
    /** Shared state instance */
    readonly state: SharedState;
    /** Subgraph manager instance */
    readonly subgraphManager: SubgraphManager;
    /** Orderbooks owners profile map */
    orderMap: OrderbooksOwnersProfileMap;

    /**
     * Creates a new OrderManager instance
     * @param state - SharedState instance
     * @param subgraphManager - (optional) SubgraphManager instance
     */
    constructor(state: SharedState, subgraphManager?: SubgraphManager) {
        this.state = state;
        this.orderMap = new Map();
        this.quoteGas = state.orderManagerConfig.quoteGas;
        this.ownerLimits = state.orderManagerConfig.ownerLimits;
        this.subgraphManager = subgraphManager ?? new SubgraphManager(state.subgraphConfig);
    }

    /**
     * Initializes an OrderManager instance by fetching initial orders from subgraphs
     * @param state - SharedState instance
     * @param subgraphManager - (optional) SubgraphManager instance
     * @returns OrderManager instance and report of the fetch process
     */
    static async init(
        state: SharedState,
        subgraphManager?: SubgraphManager,
    ): Promise<{ orderManager: OrderManager; report: PreAssembledSpan }> {
        const orderManager = new OrderManager(state, subgraphManager);
        const report = await orderManager.fetch();
        return { orderManager, report };
    }

    /** Fetches all active orders from upstream subgraphs */
    async fetch(): Promise<PreAssembledSpan> {
        const { orders, report } = await this.subgraphManager.fetchAll();
        await this.addOrders(orders);
        return report;
    }

    /** Syncs orders to upstream subgraphs */
    async sync(): Promise<PreAssembledSpan> {
        const { result, report } = await this.subgraphManager.syncOrders();
        let ordersDidChange = false;
        for (const key in result) {
            if (result[key].addOrders.length || result[key].removeOrders.length) {
                ordersDidChange = true;
            }
            await this.addOrders(result[key].addOrders.map((v) => v.order));
            await this.removeOrders(result[key].removeOrders.map((v) => v.order));
        }

        // run protection if there has been upstream changes
        if (ordersDidChange) this.downscaleProtection(true);

        return report;
    }

    /**
     * Adds new orders to the order map
     * @param ordersDetails - Array of order details from subgraph
     */
    async addOrders(ordersDetails: SgOrder[]) {
        for (let i = 0; i < ordersDetails.length; i++) {
            const orderDetails = ordersDetails[i];
            const orderHash = orderDetails.orderHash.toLowerCase();
            const orderbook = orderDetails.orderbook.id.toLowerCase();
            const orderStruct = Order.fromBytes(orderDetails.orderBytes);

            // add to the map
            const orderbookOwnerProfileItem = this.orderMap.get(orderbook);
            if (orderbookOwnerProfileItem) {
                const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner);
                if (ownerProfile) {
                    const order = ownerProfile.orders.get(orderHash);
                    if (!order) {
                        ownerProfile.orders.set(orderHash, {
                            active: true,
                            order: orderStruct,
                            takeOrders: await this.getOrderPairs(
                                orderHash,
                                orderStruct,
                                orderDetails,
                            ),
                        });
                    } else {
                        if (!order.active) order.active = true;
                    }
                } else {
                    const ordersProfileMap: OrdersProfileMap = new Map();
                    ordersProfileMap.set(orderHash, {
                        active: true,
                        order: orderStruct,
                        takeOrders: await this.getOrderPairs(orderHash, orderStruct, orderDetails),
                    });
                    orderbookOwnerProfileItem.set(orderStruct.owner, {
                        limit: this.ownerLimits[orderStruct.owner] ?? DEFAULT_OWNER_LIMIT,
                        orders: ordersProfileMap,
                        lastIndex: 0,
                    });
                }
            } else {
                const ordersProfileMap: OrdersProfileMap = new Map();
                ordersProfileMap.set(orderHash, {
                    active: true,
                    order: orderStruct,
                    takeOrders: await this.getOrderPairs(orderHash, orderStruct, orderDetails),
                });
                const ownerProfileMap: OwnersProfileMap = new Map();
                ownerProfileMap.set(orderStruct.owner, {
                    limit: this.ownerLimits[orderStruct.owner] ?? DEFAULT_OWNER_LIMIT,
                    orders: ordersProfileMap,
                    lastIndex: 0,
                });
                this.orderMap.set(orderbook, ownerProfileMap);
            }
        }
    }

    /**
     * Removes orders from order map
     * @param ordersDetails - Array of order details to remove
     */
    async removeOrders(ordersDetails: SgOrder[]) {
        for (let i = 0; i < ordersDetails.length; i++) {
            const orderDetails = ordersDetails[i];
            const orderbook = orderDetails.orderbook.id.toLowerCase();
            const orderStruct = Order.fromBytes(orderDetails.orderBytes);
            const orderbookOwnerProfileItem = this.orderMap.get(orderbook);
            if (orderbookOwnerProfileItem) {
                const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner);
                if (ownerProfile) {
                    ownerProfile.orders.delete(orderDetails.orderHash.toLowerCase());
                }
            }
        }
    }

    /**
     * Gets all possible pair combinations of an order's inputs and outputs
     * @param orderHash - The hash of the order
     * @param orderStruct - The order struct
     * @param orderDetails - The order details from subgraph
     * @returns Array of valid trading pairs
     */
    async getOrderPairs(
        orderHash: string,
        orderStruct: Order,
        orderDetails: SgOrder,
    ): Promise<Pair[]> {
        const pairs: Pair[] = [];
        for (let j = 0; j < orderStruct.validOutputs.length; j++) {
            const _output = orderStruct.validOutputs[j];
            let _outputSymbol = orderDetails.outputs.find(
                (v) => v.token.address.toLowerCase() === _output.token.toLowerCase(),
            )?.token?.symbol;
            if (!_outputSymbol) {
                _outputSymbol = this.state.watchedTokens.get(_output.token.toLowerCase())?.symbol;
                if (!_outputSymbol) {
                    _outputSymbol = await this.state.client
                        .readContract({
                            address: _output.token as `0x${string}`,
                            abi: erc20Abi,
                            functionName: "symbol",
                        })
                        .catch(() => "UnknownSymbol");
                }
            }
            // add to watched tokens
            this.state.watchToken({
                address: _output.token.toLowerCase(),
                symbol: _outputSymbol,
                decimals: _output.decimals,
            });

            for (let k = 0; k < orderStruct.validInputs.length; k++) {
                const _input = orderStruct.validInputs[k];
                let _inputSymbol = orderDetails.inputs.find(
                    (v) => v.token.address.toLowerCase() === _input.token.toLowerCase(),
                )?.token?.symbol;
                if (!_inputSymbol) {
                    _inputSymbol = this.state.watchedTokens.get(_input.token.toLowerCase())?.symbol;
                    if (!_inputSymbol) {
                        _inputSymbol = await this.state.client
                            .readContract({
                                address: _input.token as `0x${string}`,
                                abi: erc20Abi,
                                functionName: "symbol",
                            })
                            .catch(() => "UnknownSymbol");
                    }
                }
                // add to watched tokens
                this.state.watchToken({
                    address: _input.token.toLowerCase(),
                    symbol: _inputSymbol,
                    decimals: _input.decimals,
                });

                if (_input.token.toLowerCase() !== _output.token.toLowerCase())
                    pairs.push({
                        buyToken: _input.token.toLowerCase(),
                        buyTokenSymbol: _inputSymbol,
                        buyTokenDecimals: _input.decimals,
                        sellToken: _output.token.toLowerCase(),
                        sellTokenSymbol: _outputSymbol,
                        sellTokenDecimals: _output.decimals,
                        takeOrder: {
                            id: orderHash,
                            takeOrder: {
                                order: orderStruct,
                                inputIOIndex: k,
                                outputIOIndex: j,
                                signedContext: [],
                            },
                        },
                    });
            }
        }
        return pairs;
    }

    /**
     * Prepares orders for the next round
     * @param shuffle - Whether to randomize the order of items (default: true)
     * @returns Array of bundled orders grouped by orderbook
     */
    getNextRoundOrders(shuffle = true): BundledOrders[][] {
        const result: BundledOrders[][] = [];
        this.orderMap.forEach((ownersProfileMap, orderbook) => {
            const bundledOrders: BundledOrders[] = [];
            ownersProfileMap.forEach((ownerProfile) => {
                let remainingLimit = ownerProfile.limit;

                // consume orders limits
                const allOrders: Pair[] = [];
                ownerProfile.orders.forEach((v) => allOrders.push(...v.takeOrders));
                const consumingOrders = allOrders.splice(ownerProfile.lastIndex, remainingLimit);
                remainingLimit -= consumingOrders.length;
                ownerProfile.lastIndex += consumingOrders.length;
                if (remainingLimit) {
                    ownerProfile.lastIndex = 0;
                    const remainingConsumingOrders = allOrders.splice(0, remainingLimit);
                    ownerProfile.lastIndex += remainingConsumingOrders.length;
                    consumingOrders.push(...remainingConsumingOrders);
                }
                for (const order of consumingOrders) {
                    const bundleOrder = bundledOrders.find(
                        (v) =>
                            v.buyToken.toLowerCase() === order.buyToken.toLowerCase() &&
                            v.sellToken.toLowerCase() === order.sellToken.toLowerCase(),
                    );
                    if (bundleOrder) {
                        // make sure to not duplicate
                        if (!bundleOrder.takeOrders.find((v) => v.id === order.takeOrder.id)) {
                            bundleOrder.takeOrders.push(order.takeOrder);
                        }
                    } else {
                        bundledOrders.push({
                            orderbook,
                            buyToken: order.buyToken,
                            buyTokenDecimals: order.buyTokenDecimals,
                            buyTokenSymbol: order.buyTokenSymbol,
                            sellToken: order.sellToken,
                            sellTokenDecimals: order.sellTokenDecimals,
                            sellTokenSymbol: order.sellTokenSymbol,
                            takeOrders: [order.takeOrder],
                        });
                    }
                }
            });
            if (shuffle) {
                // shuffle orders
                for (const b of bundledOrders) {
                    shuffleArray(b.takeOrders);
                }
                // shuffle pairs
                shuffleArray(bundledOrders);
            }
            result.push(bundledOrders);
        });
        if (shuffle) {
            // shuffle orderbooks
            shuffleArray(result);
        }
        return result;
    }

    /**
     * Gets a quote for a single order
     * @param orderDetails - Order details to quote
     * @param blockNumber - Optional block number for the quote
     */
    async quoteOrder(orderDetails: BundledOrders, blockNumber?: bigint) {
        return await quoteSingleOrder(orderDetails, this.state.client, blockNumber, this.quoteGas);
    }

    /**
     * Resets owner limits to their default values
     * Skips owners with explicitly configured limits
     */
    async resetLimits() {
        this.orderMap.forEach((ownersProfileMap) => {
            if (ownersProfileMap) {
                ownersProfileMap.forEach((ownerProfile, owner) => {
                    // skip if owner limit is set by bot admin
                    if (typeof this.ownerLimits[owner] === "number") return;
                    ownerProfile.limit = DEFAULT_OWNER_LIMIT;
                });
            }
        });
    }

    /**
     * Provides a protection by evaluating and possibly reducing owner's limit,
     * this takes place by checking an owners avg vault balance of a token against
     * all other owners cumulative balances, the calculated ratio is used a reducing
     * factor for the owner limit when averaged out for all of tokens the owner has
     */
    async downscaleProtection(reset = true, multicallAddressOverride?: string) {
        if (reset) {
            this.resetLimits();
        }
        const otovMap = buildOrderbookTokenOwnerVaultsMap(this.orderMap);
        await downscaleProtection(
            this.orderMap,
            otovMap,
            this.state.client,
            this.ownerLimits,
            multicallAddressOverride,
        ).catch(() => {});
    }
}
