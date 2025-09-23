/* eslint-disable @typescript-eslint/no-unused-vars */
import { V3 as _V3 } from "./v3";
import { V4 as _V4 } from "./v4";

/** Represents an order with a specific version */
export type Order = _V3 | _V4;

/** @remarks Order namespace provides utilities and types related and for working with orders */
export namespace Order {
    /** Specifies the version of the order */
    export enum Type {
        V3 = "V3", // orderbook v4
        V4 = "V4", // orderbook v5
    }

    export import V3 = _V3;
    export import V4 = _V4;
}
