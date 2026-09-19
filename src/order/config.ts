import { AppOptions } from "../config";

/** The default owner limit */
export const DEFAULT_OWNER_LIMIT = 5 as const;

/** Configuration required for instantiating OrderManager */
export type OrderManagerConfig = {
    quoteGas: bigint;
    ownerLimits: Record<string, number>;
    defaultOwnerLimit: number;
};
export namespace OrderManagerConfig {
    export function tryFromAppOptions(options: AppOptions) {
        return {
            quoteGas: options.quoteGas,
            ownerLimits: options.ownerProfile ?? {},
            defaultOwnerLimit: options.defaultOwnerLimit,
        };
    }
}
