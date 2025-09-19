import { SubgraphConfig } from "./index";
import { describe, it, expect } from "vitest";

describe("Test SubgraphConfig", () => {
    it("should init successfully using tryFromAppOptions", () => {
        const appOptions = {
            subgraph: ["http://sg1", "http://sg2"],
            sgFilter: { includeOrders: ["0xJohn"], includeOwners: ["0xNina"] },
            timeout: 12345,
        } as any;

        const config = SubgraphConfig.tryFromAppOptions(appOptions);

        expect(config.subgraphs).toEqual(["http://sg1", "http://sg2"]);
        expect(config.filters).toEqual({
            includeOrders: ["0xJohn"],
            includeOwners: ["0xNina"],
        });
        expect(config.requestTimeout).toBe(12345);
    });
});
