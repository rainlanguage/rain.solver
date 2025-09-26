import { Evaluable } from "../types";
import { SgOrder } from "../../subgraph";
import { WasmEncodedError } from "@rainlanguage/float";
import { Order, PairBase, TakeOrderDetailsBase } from ".";
import { ABI, normalizeFloat, Result } from "../../common";
import { decodeAbiParameters, DecodeAbiParametersErrorType } from "viem";

// these types are used in orderbook v5

/** Represents an v4 order */
export type V4 = {
    type: Order.Type.V4;
    owner: `0x${string}`;
    nonce: `0x${string}`;
    evaluable: Evaluable;
    validInputs: V4.IO[];
    validOutputs: V4.IO[];
};

/** @remarks V4 namespace provides utilities and types related and for working with v4 orders */
export namespace V4 {
    /** Represents an input/output for a v4 order */
    export type IO = {
        token: `0x${string}`;
        vaultId: `0x${string}`;
    };

    /** Decodes order bytes into OrderV4 struct */
    export function tryFromBytes(orderBytes: string): Result<V4, DecodeAbiParametersErrorType> {
        try {
            const decoded = decodeAbiParameters(
                ABI.Orderbook.V5.Primary.OrderStructAbi,
                orderBytes as `0x${string}`,
            )[0];
            return Result.ok({
                type: Order.Type.V4,
                owner: decoded.owner.toLowerCase() as `0x${string}`,
                nonce: decoded.nonce.toLowerCase() as `0x${string}`,
                evaluable: {
                    interpreter: decoded.evaluable.interpreter.toLowerCase() as `0x${string}`,
                    store: decoded.evaluable.store.toLowerCase() as `0x${string}`,
                    bytecode: decoded.evaluable.bytecode.toLowerCase() as `0x${string}`,
                },
                validInputs: decoded.validInputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    vaultId: v.vaultId.toLowerCase() as `0x${string}`,
                })),
                validOutputs: decoded.validOutputs.map((v) => ({
                    token: v.token.toLowerCase() as `0x${string}`,
                    vaultId: v.vaultId.toLowerCase() as `0x${string}`,
                })),
            });
        } catch (err: any) {
            return Result.err(err);
        }
    }
}

export type TakeOrderV4 = {
    order: V4;
    inputIOIndex: number;
    outputIOIndex: number;
    signedContext: any[];
};

export type TakeOrderDetailsV4 = TakeOrderDetailsBase & {
    struct: TakeOrderV4;
};

export type OrderProfileV4 = {
    active: boolean;
    order: V4;
    takeOrders: PairV4[];
};

/** Represents the take orders configuration structure for version 5 orderbook */
export type TakeOrdersConfigTypeV4 = {
    minimumInput: `0x${string}`;
    maximumInput: `0x${string}`;
    maximumIORatio: `0x${string}`;
    orders: TakeOrderV4[];
    data: `0x${string}`;
};

export type PairV4 = PairBase & {
    takeOrder: TakeOrderDetailsV4;
};
export namespace PairV4 {
    export function fromArgs(
        orderHash: string,
        orderStruct: Order.V4,
        orderDetails: SgOrder,
        inputIOIndex: number,
        outputIOIndex: number,
        inputVaultDetails: { token: string; symbol: string; decimals: number; balance: string },
        outputVaultDetails: { token: string; symbol: string; decimals: number; balance: string },
    ): Result<PairV4, WasmEncodedError> {
        const {
            token: inputToken,
            symbol: inputSymbol,
            decimals: inputDecimals,
            balance: inputBalanceHex,
        } = inputVaultDetails;
        const {
            token: outputToken,
            symbol: outputSymbol,
            decimals: outputDecimals,
            balance: outputBalanceHex,
        } = outputVaultDetails;

        const inputBalanceRes = normalizeFloat(inputBalanceHex, inputDecimals);
        if (inputBalanceRes.isErr()) {
            return Result.err(inputBalanceRes.error);
        }
        const outputBalanceRes = normalizeFloat(outputBalanceHex, outputDecimals);
        if (outputBalanceRes.isErr()) {
            return Result.err(outputBalanceRes.error);
        }
        return Result.ok({
            orderbook: orderDetails.orderbook.id.toLowerCase(),
            buyToken: inputToken.toLowerCase(),
            buyTokenSymbol: inputSymbol,
            buyTokenDecimals: inputDecimals,
            buyTokenVaultBalance: inputBalanceRes.value,
            sellToken: outputToken.toLowerCase(),
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
