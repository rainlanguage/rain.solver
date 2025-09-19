import { AppOptions } from "../config";

/** Configuration required for instantiating OrderManager */
export type OrderManagerConfig = {
    quoteGas: bigint;
    ownerLimits: Record<string, number>;
};
export namespace OrderManagerConfig {
    export function tryFromAppOptions(options: AppOptions) {
        return {
            quoteGas: options.quoteGas,
            ownerLimits: options.ownerProfile ?? {},
        };
    }
}
