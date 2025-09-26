import { Order } from ".";
import { Evaluable } from "../types";
import { ABI, Result } from "../../common";
import { decodeAbiParameters, DecodeAbiParametersErrorType } from "viem";

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
