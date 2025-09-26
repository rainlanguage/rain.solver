import { Evaluable } from "../types";
import { SgOrder } from "../../subgraph";
import { ABI, Result } from "../../common";
import { Order, PairBase, TakeOrderDetailsBase } from ".";
import { decodeAbiParameters, DecodeAbiParametersErrorType } from "viem";

// these types are used in orderbook v4

/** Represents an v3 order */
export type V3 = {
    type: Order.Type.V3;
    owner: `0x${string}`;
    nonce: `0x${string}`;
    evaluable: Evaluable;
    validInputs: V3.IO[];
    validOutputs: V3.IO[];
};

/** @remarks V3 namespace provides utilities and types related and for working with v3 orders */
export namespace V3 {
    /** Represents an input/output for a v3 order */
    export type IO = {
        token: `0x${string}`;
        decimals: number;
        vaultId: bigint;
    };

    /** Decodes order bytes into OrderV3 struct */
    export function tryFromBytes(orderBytes: string): Result<V3, DecodeAbiParametersErrorType> {
        try {
            const decoded = decodeAbiParameters(
                ABI.Orderbook.V4.Primary.OrderStructAbi,
                orderBytes as `0x${string}`,
            )[0];
            return Result.ok({
                type: Order.Type.V3,
                owner: decoded.owner.toLowerCase() as `0x${string}`,
                nonce: decoded.nonce.toLowerCase() as `0x${string}`,
                evaluable: {
                    interpreter: decoded.evaluable.interpreter.toLowerCase() as `0x${string}`,
                    store: decoded.evaluable.store.toLowerCase() as `0x${string}`,
                    bytecode: decoded.evaluable.bytecode.toLowerCase() as `0x${string}`,
                },
                validInputs: decoded.validInputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    decimals: v.decimals,
                    vaultId: v.vaultId,
                })),
                validOutputs: decoded.validOutputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    decimals: v.decimals,
                    vaultId: v.vaultId,
                })),
            });
        } catch (err: any) {
            return Result.err(err);
        }
    }
}

export type TakeOrderV3 = {
    order: V3;
    inputIOIndex: number;
    outputIOIndex: number;
    signedContext: any[];
};

export type TakeOrderDetailsV3 = TakeOrderDetailsBase & {
    struct: TakeOrderV3;
};

export type OrderProfileV3 = {
    active: boolean;
    order: V3;
    takeOrders: PairV3[];
};

/** Represents the take orders configuration structure for version 4 orderbook */
export type TakeOrdersConfigTypeV3 = {
    minimumInput: bigint;
    maximumInput: bigint;
    maximumIORatio: bigint;
    orders: TakeOrderV3[];
    data: `0x${string}`;
};

export type PairV3 = PairBase & {
    takeOrder: TakeOrderDetailsV3;
};
export namespace PairV3 {
    export function fromArgs(
        orderHash: string,
        orderStruct: Order.V3,
        orderDetails: SgOrder,
        inputIOIndex: number,
        outputIOIndex: number,
        inputVaultDetails: { token: string; symbol: string; decimals: number; balance: string },
        outputVaultDetails: { token: string; symbol: string; decimals: number; balance: string },
    ): PairV3 {
        const {
            token: inputToken,
            symbol: inputSymbol,
            decimals: inputDecimals,
            balance: inputBalance,
        } = inputVaultDetails;
        const {
            token: outputToken,
            symbol: outputSymbol,
            decimals: outputDecimals,
            balance: outputBalance,
        } = outputVaultDetails;

        return {
            orderbook: orderDetails.orderbook.id.toLowerCase(),
            buyToken: inputToken.toLowerCase(),
            buyTokenSymbol: inputSymbol,
            buyTokenDecimals: inputDecimals,
            buyTokenVaultBalance: BigInt(inputBalance),
            sellToken: outputToken.toLowerCase(),
            sellTokenSymbol: outputSymbol,
            sellTokenDecimals: outputDecimals,
            sellTokenVaultBalance: BigInt(outputBalance),
            takeOrder: {
                id: orderHash,
                struct: {
                    order: orderStruct,
                    inputIOIndex,
                    outputIOIndex,
                    signedContext: [],
                },
            },
        };
    }
}
