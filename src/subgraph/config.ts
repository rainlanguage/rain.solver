import { SgFilter } from "./filter";
import { AppOptions } from "../config";

/** Subgraph configuration used for instantiating SubgraphManager */
export type SubgraphConfig = {
    /** List of subgraph urls */
    subgraphs: string[];
    /** Subgraph filters */
    filters?: SgFilter;
    /** Optional query timeout */
    requestTimeout?: number;
};

export namespace SubgraphConfig {
    /** Create an instance from yaml config i.e. AppOptions */
    export function tryFromAppOptions(options: AppOptions): SubgraphConfig {
        return {
            filters: options.sgFilter,
            requestTimeout: options.timeout,
            subgraphs: Array.from(new Set(options.subgraph)), // use set to dedup
        };
    }
}
