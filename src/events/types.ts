import { Order } from "../order";

/** A hex string */
export type Hex = `0x${string}`;

/**
 * The part of a viem log the module reads, so the client layer can hand over
 * logs from a subscription or from a range query alike
 */
export type RawLog = {
    address: Hex;
    topics: readonly Hex[];
    data: Hex;
    blockNumber: bigint;
    /** The hash of the block of the log, the http poll uses it to find a reorg */
    blockHash?: Hex;
    transactionHash: Hex;
    logIndex: number;
    /** Set when the log was undone by a reorg */
    removed?: boolean;
};

/** Where a log sits in the chain, the order of events follows it */
export type LogRef = {
    blockNumber: bigint;
    transactionHash: Hex;
    logIndex: number;
};

/**
 * A vault, addresses lower cased, the vault id as a number, so no padding or
 * case of a hex can tell two refs of one vault apart, the bytes32 form the
 * orderbook uses is built where a contract call needs it, see toVaultId
 */
export type VaultRef = {
    orderbook: Hex;
    owner: Hex;
    token: Hex;
    vaultId: bigint;
};

/**
 * An amount a vault changed by, either in token units, as deposits and
 * withdrawals report them, or as a rain float, as trades report them, a float
 * needs the token decimals to become token units
 */
export type Amount = { raw: bigint } | { float: Hex };

/** A signed change of one vault balance */
export type VaultChange = {
    vault: VaultRef;
    amount: Amount;
    /** 1 for an increase, -1 for a decrease */
    sign: 1 | -1;
};

/** An order was added, the struct and its bytes as the order manager wants them */
export type AddOrderEvent = {
    type: "AddOrder";
    ref: LogRef;
    orderbook: Hex;
    orderHash: Hex;
    order: Order;
    orderBytes: Hex;
    /** The order meta, when the add came with a meta log */
    meta?: Hex;
};

/** An order was removed */
export type RemoveOrderEvent = {
    type: "RemoveOrder";
    ref: LogRef;
    orderbook: Hex;
    orderHash: Hex;
    order: Order;
    orderBytes: Hex;
};

/** Vault balances changed, by a deposit, a withdrawal, a take order or a clear */
export type VaultEvent = {
    type: "Deposit" | "Withdraw" | "TakeOrder" | "Clear";
    ref: LogRef;
    orderbook: Hex;
    changes: VaultChange[];
};

/**
 * The meta of an order. The orderbook logs it right after the add, in the same
 * transaction. The ingestor puts it on the add when the add is still in the
 * buffer, otherwise the syncer applies it to the added order as an update
 */
export type MetaEvent = {
    type: "Meta";
    ref: LogRef;
    orderbook: Hex;
    /** The order hash the meta belongs to */
    orderHash: Hex;
    meta: Hex;
};

/** An event the syncer applies */
export type OrderbookEvent = AddOrderEvent | RemoveOrderEvent | VaultEvent | MetaEvent;

/**
 * The first half of a clear, the orders and the config, the amounts come with
 * the after clear log of the same transaction
 */
export type ClearStartLog = {
    type: "ClearStart";
    ref: LogRef;
    orderbook: Hex;
    sender: Hex;
    alice: Order;
    bob: Order;
    clearConfig: {
        aliceInputIOIndex: number;
        aliceOutputIOIndex: number;
        bobInputIOIndex: number;
        bobOutputIOIndex: number;
        /** A bytes32 hex on a v5 or v6 orderbook, a uint256 on a v4 one */
        aliceBountyVaultId: Hex | bigint;
        bobBountyVaultId: Hex | bigint;
    };
};

/**
 * The second half of a clear, the amounts as rain floats on a v5 or v6
 * orderbook, in token units on a v4 one
 */
export type AfterClearLog = {
    type: "AfterClear";
    ref: LogRef;
    orderbook: Hex;
    stateChange: {
        aliceOutput: Amount;
        bobOutput: Amount;
        aliceInput: Amount;
        bobInput: Amount;
    };
};

/** What a single log decodes to, the halves get paired by the ingestor */
export type DecodedLog = OrderbookEvent | ClearStartLog | AfterClearLog;
