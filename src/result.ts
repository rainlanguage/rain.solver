/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Prettify } from "viem";

/** Ok varinat of Result */
export type Ok<T> = { value: T };

/** Error variant of Result */
export type Err<E> = { error: E };

/** Represents a result type that can ether be ok or error */
export type Result<T, E> = Prettify<
    (Ok<T> | Err<E>) & {
        // @ts-ignore
        isOk(): this is Ok<T>;
        // @ts-ignore
        isErr(): this is Err<E>;
    }
>;
export namespace Result {
    /** Creates an Ok variant of Result */
    export function ok<T, E>(value: T): Result<T, E> {
        return {
            value,
            isOk: () => true,
            isErr: () => false,
        } as any as Result<T, E>;
    }

    /** Creates an Error variant of Result */
    export function err<T, E>(error: E): Result<T, E> {
        return {
            error,
            isOk: () => false,
            isErr: () => true,
        } as any as Result<T, E>;
    }
}
