import { erc20Abi } from "viem";
import { syncOrders } from "./sync";
import { SgOrder } from "../subgraph";
import { shuffleArray } from "../common";
import { quoteSingleOrder } from "./quote";
import { PreAssembledSpan } from "../logger";
import { SubgraphManager } from "../subgraph";
import { downscaleProtection } from "./protection";
import { SharedState, TokenDetails } from "../state";
import { addToPairMap, removeFromPairMap, getSortedPairList } from "./pair";
import {
    Pair,
    Order,
    OrdersProfileMap,
    OwnersProfileMap,
    OrderbooksPairMap,
    CounterpartySource,
    OrderbooksOwnersProfileMap,
    OrderbookOwnerTokenVaultsMap,
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
    ownersMap: OrderbooksOwnersProfileMap;
    /**
     * Orderbooks order pairs map, keeps the orders organized by their pairs
     * for quick access mainly for intra and inter orderbook operations where
     * opposing orders list needs to be fetched, the data in this map points
     * to the same data in ownerMap, so it is not a copy (which would increase
     * overhead and memory usage), but rather a quick access map to the same data
     * output -> input -> orderhash -> Pair
     */
    oiPairMap: OrderbooksPairMap;
    /**
     * Same as oiPairMap but inverted, ie input -> output -> orderhash -> Pair
     */
    ioPairMap: OrderbooksPairMap;
    /**
     * Keeps a map of owner token vaults details, this is used to evaluate
     * owners limits and to keep track of vault balance changes throughout
     * the runtime, helping us to avoid running order pairs with empty vault
     * balances.
     * Vault balances are updated on each order sync operation when the recent
     * transactions are processed and those that have vault balance changes
     * are updated in this map.
     * orderbook -> owner -> token -> vaultsId -> vaultDetails
     */
    ownerTokenVaultMap: OrderbookOwnerTokenVaultsMap;

    /**
     * Creates a new OrderManager instance
     * @param state - SharedState instance
     * @param subgraphManager - (optional) SubgraphManager instance
     */
    constructor(state: SharedState, subgraphManager?: SubgraphManager) {
        this.state = state;
        this.oiPairMap = new Map();
        this.ownersMap = new Map();
        this.ioPairMap = new Map();
        this.ownerTokenVaultMap = new Map();
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
        return await syncOrders.call(this);
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
            const orderStructResult = Order.tryFromBytes(orderDetails.orderBytes);
            if (orderStructResult.isErr()) return;

            const orderStruct = orderStructResult.value;

            const pairs = await this.getOrderPairs(orderHash, orderStruct, orderDetails);

            // add to the owners map
            const orderbookOwnerProfileItem = this.ownersMap.get(orderbook);
            if (orderbookOwnerProfileItem) {
                const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner);
                if (ownerProfile) {
                    const order = ownerProfile.orders.get(orderHash);
                    if (!order) {
                        ownerProfile.orders.set(orderHash, {
                            active: true,
                            order: orderStruct,
                            takeOrders: pairs,
                        });
                    } else {
                        if (!order.active) order.active = true;
                    }
                } else {
                    const ordersProfileMap: OrdersProfileMap = new Map();
                    ordersProfileMap.set(orderHash, {
                        active: true,
                        order: orderStruct,
                        takeOrders: pairs,
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
                    takeOrders: pairs,
                });
                const ownerProfileMap: OwnersProfileMap = new Map();
                ownerProfileMap.set(orderStruct.owner, {
                    limit: this.ownerLimits[orderStruct.owner] ?? DEFAULT_OWNER_LIMIT,
                    orders: ordersProfileMap,
                    lastIndex: 0,
                });
                this.ownersMap.set(orderbook, ownerProfileMap);
            }

            // add to the pair maps
            for (let j = 0; j < pairs.length; j++) {
                this.addToPairMaps(pairs[j]);
                this.addToTokenVaultsMap(pairs[j]);
            }
        }
    }

    /**
     * Adds the given order pairs to the pair map
     * @param pair - The order pair object
     * @param inverse - Whether to add the pairs in inverse order to ioPairMap
     */
    addToPairMaps(pair: Pair) {
        const orderbook = pair.orderbook.toLowerCase();
        const hash = pair.takeOrder.id.toLowerCase();
        const outputKey = pair.sellToken.toLowerCase();
        const inputKey = pair.buyToken.toLowerCase();
        addToPairMap(this.oiPairMap, orderbook, hash, outputKey, inputKey, pair);
        addToPairMap(this.ioPairMap, orderbook, hash, inputKey, outputKey, pair);
    }

    /**
     * Adds the given order pair vault details to the token vaults map, since
     * vaults dont get destroyed, there is no need to have any remove operation
     * for this this map
     * @param pair - The order pair object
     */
    addToTokenVaultsMap(pair: Pair) {
        const orderbook = pair.orderbook.toLowerCase();
        const owner = pair.takeOrder.takeOrder.order.owner.toLowerCase();
        const outputVault =
            pair.takeOrder.takeOrder.order.validOutputs[pair.takeOrder.takeOrder.outputIOIndex];
        const inputVault =
            pair.takeOrder.takeOrder.order.validInputs[pair.takeOrder.takeOrder.inputIOIndex];

        this.updateVault(
            orderbook,
            owner,
            {
                address: outputVault.token.toLowerCase(),
                decimals: outputVault.decimals,
                symbol: pair.sellTokenSymbol,
            },
            outputVault.vaultId,
            pair.sellTokenVaultBalance,
        );
        this.updateVault(
            orderbook,
            owner,
            {
                address: inputVault.token.toLowerCase(),
                decimals: inputVault.decimals,
                symbol: pair.buyTokenSymbol,
            },
            inputVault.vaultId,
            pair.buyTokenVaultBalance,
        );
    }

    /**
     * Updates the vault balance in the ownerTokenVaultMap
     * @param orderbook - The orderbook address
     * @param owner - The owner address
     * @param token - The token details
     * @param vaultId - The vault id
     * @param balance - The new vault balance
     */
    updateVault(
        orderbook: string,
        owner: string,
        token: TokenDetails,
        vaultId: bigint,
        balance: bigint,
    ) {
        // get or create the empty map to store orderbook owner vaults
        if (!this.ownerTokenVaultMap.has(orderbook)) {
            this.ownerTokenVaultMap.set(orderbook, new Map());
        }
        const ownersTokenVaultsMap = this.ownerTokenVaultMap.get(orderbook)!;

        // get or create the empty map to store owner vaults
        if (!ownersTokenVaultsMap.has(owner)) {
            ownersTokenVaultsMap.set(owner, new Map());
        }
        const tokenVaultMap = ownersTokenVaultsMap.get(owner)!;

        // get or create the empty map to store output vault details
        if (!tokenVaultMap.has(token.address)) {
            tokenVaultMap.set(token.address, new Map());
        }
        const vaultsMap = tokenVaultMap.get(token.address)!;
        const vault = vaultsMap.get(vaultId);
        if (!vault) {
            vaultsMap.set(vaultId, {
                id: vaultId,
                balance,
                token,
            });
        } else {
            vault.balance = balance;
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
            const orderHash = orderDetails.orderHash.toLowerCase();

            const orderStructResult = Order.tryFromBytes(orderDetails.orderBytes);
            if (orderStructResult.isErr()) return;

            const orderStruct = orderStructResult.value;

            // delete from the owners map
            const orderbookOwnerProfileItem = this.ownersMap.get(orderbook);
            if (orderbookOwnerProfileItem) {
                const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner);
                if (ownerProfile) {
                    ownerProfile.orders.delete(orderHash);
                }
            }

            // delete from the pair maps
            for (let j = 0; j < orderDetails.outputs.length; j++) {
                for (let k = 0; k < orderDetails.inputs.length; k++) {
                    // skip same token pairs
                    const output = orderDetails.outputs[j].token.address;
                    const input = orderDetails.inputs[k].token.address;
                    if (input === output) continue;

                    removeFromPairMap(this.oiPairMap, orderbook, orderHash, output, input); // from oi map
                    removeFromPairMap(this.ioPairMap, orderbook, orderHash, input, output); // from io map
                }
            }
        }
    }

    /**
     * Removes orders from the pair maps
     * @param orderbook - The orderbook address
     * @param orderHash - The hash of the order
     * @param output - The output token address
     * @param input - The input token address
     * @param inverse - Whether to remove the pairs in inverse order from ioPairMap
     */
    removeFromPairMaps(pair: Pair) {
        const orderbook = pair.orderbook.toLowerCase();
        const hash = pair.takeOrder.id.toLowerCase();
        const outputKey = pair.sellToken.toLowerCase();
        const inputKey = pair.buyToken.toLowerCase();
        removeFromPairMap(this.oiPairMap, orderbook, hash, outputKey, inputKey); // from oi map
        removeFromPairMap(this.ioPairMap, orderbook, hash, inputKey, outputKey); // from io map
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
                        orderbook: orderDetails.orderbook.id.toLowerCase(),
                        buyToken: _input.token.toLowerCase(),
                        buyTokenSymbol: _inputSymbol,
                        buyTokenDecimals: _input.decimals,
                        buyTokenVaultBalance: BigInt(orderDetails.inputs[k].balance),
                        sellToken: _output.token.toLowerCase(),
                        sellTokenSymbol: _outputSymbol,
                        sellTokenDecimals: _output.decimals,
                        sellTokenVaultBalance: BigInt(orderDetails.outputs[j].balance),
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
    getNextRoundOrders(shuffle = true): Pair[] {
        const result: Pair[] = [];
        this.ownersMap.forEach((ownersProfileMap) => {
            ownersProfileMap.forEach((ownerProfile, owner) => {
                let remainingLimit = ownerProfile.limit;

                // consume orders limits
                const allOrders = Array.from(ownerProfile.orders.values()).flatMap(
                    (profile) => profile.takeOrders,
                );
                const consumingOrders = allOrders.splice(ownerProfile.lastIndex, remainingLimit);
                remainingLimit -= consumingOrders.length;
                ownerProfile.lastIndex += consumingOrders.length;
                if (remainingLimit) {
                    ownerProfile.lastIndex = 0;
                    const remainingConsumingOrders = allOrders.splice(0, remainingLimit);
                    ownerProfile.lastIndex += remainingConsumingOrders.length;
                    consumingOrders.push(...remainingConsumingOrders);
                }

                // update vault balance of each Pair object from ownerTokenVault map
                consumingOrders.forEach((pair) => {
                    pair.sellTokenVaultBalance =
                        this.ownerTokenVaultMap
                            .get(pair.orderbook)
                            ?.get(owner)
                            ?.get(pair.sellToken)
                            ?.get(
                                pair.takeOrder.takeOrder.order.validOutputs[
                                    pair.takeOrder.takeOrder.outputIOIndex
                                ].vaultId,
                            )?.balance ?? pair.sellTokenVaultBalance;
                    pair.buyTokenVaultBalance =
                        this.ownerTokenVaultMap
                            .get(pair.orderbook)
                            ?.get(owner)
                            ?.get(pair.buyToken)
                            ?.get(
                                pair.takeOrder.takeOrder.order.validInputs[
                                    pair.takeOrder.takeOrder.inputIOIndex
                                ].vaultId,
                            )?.balance ?? pair.buyTokenVaultBalance;
                });
                result.push(...consumingOrders);
            });
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
    async quoteOrder(orderDetails: Pair, blockNumber?: bigint) {
        return await quoteSingleOrder(orderDetails, this.state.client, blockNumber, this.quoteGas);
    }

    /**
     * Resets owner limits to their default values
     * Skips owners with explicitly configured limits
     */
    async resetLimits() {
        this.ownersMap.forEach((ownersProfileMap) => {
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
     * all other owners cumulative balances, the calculated ratio is used as a reducing
     * factor for the owner limit when averaged out for all of tokens the owner has
     */
    async downscaleProtection(reset = true) {
        if (reset) {
            this.resetLimits();
        }
        await downscaleProtection(
            this.ownersMap,
            this.ownerTokenVaultMap,
            this.state.client,
            this.ownerLimits,
        ).catch(() => {});
    }

    /**
     * Gets descending sorted list of counterparty orders by their ratios for a given order
     * @param orderDetails - Details of the order to find counterparty orders for
     * @param counterpartySource - Determines the type of counterparty orders source to return
     */
    getCounterpartyOrders<
        counterpartySource extends CounterpartySource = CounterpartySource.IntraOrderbook,
    >(
        orderDetails: Pair,
        counterpartySource: counterpartySource,
    ): counterpartySource extends CounterpartySource.IntraOrderbook ? Pair[] : Pair[][] {
        const sellToken = orderDetails.sellToken.toLowerCase();
        const buyToken = orderDetails.buyToken.toLowerCase();
        const ob = orderDetails.orderbook.toLowerCase();
        return getSortedPairList(this.oiPairMap, ob, buyToken, sellToken, counterpartySource);
    }
}
