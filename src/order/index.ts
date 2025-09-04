import { syncOrders } from "./sync";
import { SgOrder } from "../subgraph";
import { errorSnapshot } from "../error";
import { quoteSingleOrder } from "./quote";
import { PreAssembledSpan } from "../logger";
import { SubgraphManager } from "../subgraph";
import { downscaleProtection } from "./protection";
import { normalizeFloat, Result } from "../common";
import { SharedState, TokenDetails } from "../state";
import { WasmEncodedError } from "@rainlanguage/float";
import { DecodeAbiParametersErrorType, erc20Abi } from "viem";
import { addToPairMap, removeFromPairMap, getSortedPairList } from "./pair";
import {
    IO,
    Pair,
    Order,
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
        for (const order of orders) {
            const result = await this.addOrder(order);
            if (result.isErr()) {
                report.setAttr(
                    `fetchstatus.orders.${order.orderHash}`,
                    await errorSnapshot("Failed to handle order", result.error),
                );
            }
        }
        return report;
    }

    /** Syncs orders to upstream subgraphs */
    async sync(): Promise<PreAssembledSpan> {
        return await syncOrders.call(this);
    }

    /**
     * Adds a new order to the order map
     * @param orderDetails - Order details from subgraph
     */
    async addOrder(
        orderDetails: SgOrder,
    ): Promise<Result<void, WasmEncodedError | DecodeAbiParametersErrorType>> {
        const orderHash = orderDetails.orderHash.toLowerCase();
        const orderbook = orderDetails.orderbook.id.toLowerCase();

        const orderStructResult = Order.tryFromBytes(orderDetails.orderBytes);
        if (orderStructResult.isErr()) return Result.err(orderStructResult.error);
        const orderStruct = orderStructResult.value;

        const pairsResult = await this.getOrderPairs(orderHash, orderStruct, orderDetails);
        if (pairsResult.isErr()) return Result.err(pairsResult.error);
        const pairs = pairsResult.value;

        // add to the owners map
        if (!this.ownersMap.has(orderbook)) {
            this.ownersMap.set(orderbook, new Map());
        }
        const orderbookOwnerProfileItem = this.ownersMap.get(orderbook)!;

        if (!orderbookOwnerProfileItem.has(orderStruct.owner)) {
            const order = {
                active: true,
                order: orderStruct,
                takeOrders: pairs,
            };
            orderbookOwnerProfileItem.set(orderStruct.owner, {
                limit: this.ownerLimits[orderStruct.owner] ?? DEFAULT_OWNER_LIMIT,
                orders: new Map([[orderHash, order]]),
                lastIndex: 0,
            });
        }
        const ownerProfile = orderbookOwnerProfileItem.get(orderStruct.owner)!;
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

        // add to the pair maps
        for (let j = 0; j < pairs.length; j++) {
            this.addToPairMaps(pairs[j]);
            this.addToTokenVaultsMap(pairs[j]);
        }

        return Result.ok(undefined);
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
        const owner = pair.takeOrder.struct.order.owner.toLowerCase();
        const outputVault =
            pair.takeOrder.struct.order.validOutputs[pair.takeOrder.struct.outputIOIndex];
        const inputVault =
            pair.takeOrder.struct.order.validInputs[pair.takeOrder.struct.inputIOIndex];

        this.updateVault(
            orderbook,
            owner,
            {
                address: outputVault.token.toLowerCase(),
                decimals: pair.sellTokenDecimals,
                symbol: pair.sellTokenSymbol,
            },
            BigInt(outputVault.vaultId),
            pair.sellTokenVaultBalance,
        );
        this.updateVault(
            orderbook,
            owner,
            {
                address: inputVault.token.toLowerCase(),
                decimals: pair.buyTokenDecimals,
                symbol: pair.buyTokenSymbol,
            },
            BigInt(inputVault.vaultId),
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
            if (orderStructResult.isErr()) continue;

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
     * @returns Array of valid trading pairs if successful, or an WasmEncoded if error
     */
    async getOrderPairs(
        orderHash: string,
        orderStruct: Order,
        orderDetails: SgOrder,
    ): Promise<Result<Pair[], WasmEncodedError>> {
        const pairs: Pair[] = [];
        // helper iterator function
        function* iterIO() {
            for (let i = 0; i < orderStruct.validOutputs.length; i++) {
                for (let j = 0; j < orderStruct.validInputs.length; j++) {
                    yield {
                        outputIOIndex: i,
                        inputIOIndex: j,
                        output: orderStruct.validOutputs[i],
                        input: orderStruct.validInputs[j],
                    };
                }
            }
        }

        // helper function to handle token details
        const handleToken = async (io: IO, tokensList: SgOrder["outputs"]) => {
            const address = io.token.toLowerCase() as `0x${string}`;
            const cached = this.state.watchedTokens.get(address);
            const sgOrderIO = tokensList.find((v) => v.token.address.toLowerCase() === address)!;
            const symbol =
                cached?.symbol ?? // from cache
                sgOrderIO?.token.symbol ?? // from sg tokens list
                (await this.state.client // from contract call
                    .readContract({
                        address,
                        abi: erc20Abi,
                        functionName: "symbol",
                    })
                    .catch(() => "UnknownSymbol")); // fallback to unknown symbol if all fail
            const decimals =
                cached?.decimals ??
                (sgOrderIO?.token.decimals === undefined
                    ? undefined
                    : Number(sgOrderIO?.token.decimals)) ??
                (await this.state.client
                    .readContract({
                        address,
                        abi: erc20Abi,
                        functionName: "decimals",
                    })
                    .catch(() => undefined))!;
            // add to watched tokens
            this.state.watchToken({
                symbol,
                address,
                decimals,
            });
            return { symbol, decimals, balance: sgOrderIO.balance };
        };

        for (const { output, input, outputIOIndex, inputIOIndex } of iterIO()) {
            const {
                symbol: inputSymbol,
                decimals: inputDecimals,
                balance: inputBalanceHex,
            } = await handleToken(input, orderDetails.inputs);
            const {
                symbol: outputSymbol,
                decimals: outputDecimals,
                balance: outputBalanceHex,
            } = await handleToken(output, orderDetails.outputs);

            const inputBalanceRes = normalizeFloat(inputBalanceHex, inputDecimals);
            if (inputBalanceRes.isErr()) {
                return Result.err(inputBalanceRes.error);
            }
            const outputBalanceRes = normalizeFloat(outputBalanceHex, outputDecimals);
            if (outputBalanceRes.isErr()) {
                return Result.err(outputBalanceRes.error);
            }

            if (input.token.toLowerCase() !== output.token.toLowerCase()) {
                pairs.push({
                    orderbook: orderDetails.orderbook.id.toLowerCase(),
                    buyToken: input.token.toLowerCase(),
                    buyTokenSymbol: inputSymbol,
                    buyTokenDecimals: inputDecimals,
                    buyTokenVaultBalance: inputBalanceRes.value,
                    sellToken: output.token.toLowerCase(),
                    sellTokenSymbol: outputSymbol,
                    sellTokenDecimals: outputDecimals,
                    sellTokenVaultBalance: outputBalanceRes.value,
                    takeOrder: {
                        id: orderHash,
                        struct: {
                            order: orderStruct,
                            inputIOIndex,
                            outputIOIndex,
                            signedContext: [],
                        },
                    },
                });
            }
        }

        return Result.ok(pairs);
    }

    /**
     * Prepares orders for the next round
     * @returns Array of bundled orders grouped by orderbook
     */
    getNextRoundOrders(): Pair[] {
        const result: Pair[] = [];
        this.ownersMap.forEach((ownersProfileMap) => {
            ownersProfileMap.forEach((ownerProfile) => {
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
                result.push(...consumingOrders);
            });
        });
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

    /**
     * Gets the current metadata of all orders that being processed, which includes total
     * orders count, total owners count, total pairs count and total distinct pairs count
     * @returns An object containing the metadata
     */
    getCurrentMetadata() {
        let totalCount = 0;
        let totalOwnersCount = 0;
        let totalPairsCount = 0;
        let totalDistinctPairsCount = 0;
        this.ownersMap.forEach((ownersProfileMap) => {
            let obOwners = 0;
            let obOrders = 0;
            let obPairs = 0;
            const distinctPairsSet = new Set<string>();
            ownersProfileMap.forEach((ownerProfile) => {
                obOwners++;
                obOrders += ownerProfile.orders.size;
                ownerProfile.orders.forEach((orderProfile) => {
                    obPairs += orderProfile.takeOrders.length;
                    orderProfile.takeOrders.forEach((pair) => {
                        distinctPairsSet.add(`${pair.buyToken}-${pair.sellToken}`);
                    });
                });
            });
            totalCount += obOrders;
            totalOwnersCount += obOwners;
            totalPairsCount += obPairs;
            totalDistinctPairsCount = distinctPairsSet.size;
        });
        return {
            totalCount,
            totalOwnersCount,
            totalPairsCount,
            totalDistinctPairsCount,
        };
    }
}
