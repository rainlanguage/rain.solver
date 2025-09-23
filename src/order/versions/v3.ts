import { Order } from ".";
import { Evaluable } from "../types";
import { ABI, Result } from "../../common";
import { decodeAbiParameters, DecodeAbiParametersErrorType } from "viem";

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
