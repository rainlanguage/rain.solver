import { Prettify, TransactionRequestBase } from "viem";

/** Rain dispair contracts, deployer, store and interpreter */
export type Dispair = {
    deployer: `0x${string}`;
    interpreter: `0x${string}`;
    store: `0x${string}`;
};

/** Details about a token */
export type TokenDetails = {
    address: string;
    decimals: number;
    symbol: string;
};

/** Represents a raw transaction type with base fields that can be sent to the network */
export type RawTransaction = Prettify<
    Omit<TransactionRequestBase, "to"> & {
        to: `0x${string}`;
        gasPrice?: bigint;
    }
>;
