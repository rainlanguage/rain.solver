import { batchRouterAbi_V3 } from "@balancer/sdk";

/** Keeps the BalancerBatchRouter contract ABIs */
export namespace BalancerBatchRouterAbi {
    /** Balancer BatchRouter v3 contract structs */
    export namespace Structs {
        export const SwapPathExactAmountIn = batchRouterAbi_V3[21].inputs[0];
        export const SwapPathStep = batchRouterAbi_V3[21].inputs[0].components[1];
    }

    /** BalancerBatchRouter contract primary parsed ABI */
    export namespace Primary {
        /** Primary parsed ABI for SushiSwap RouteProcessor3 contract only including processRoute() function */
        export const BatchRouterV3 = batchRouterAbi_V3;
    }
}
