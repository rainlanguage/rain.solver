import { Prettify } from "viem";
import { batchRouterAbi_V3 } from "@balancer/sdk";

/** Keeps the BalancerBatchRouter contract ABIs */
export namespace BalancerBatchRouterAbi {
    /** Balancer BatchRouter v3 contract structs */
    export namespace Structs {
        type _swapPathExactAmountInType = (typeof batchRouterAbi_V3)[21]["inputs"][0];
        const _swapPathExactAmountIn = structuredClone(
            batchRouterAbi_V3[21].inputs[0],
        ) as any as Prettify<Omit<_swapPathExactAmountInType, "type"> & { readonly type: "tuple" }>;
        (_swapPathExactAmountIn as any).type = "tuple";

        export const SwapPathExactAmountIn = _swapPathExactAmountIn;
        export const SwapPathStep = batchRouterAbi_V3[21].inputs[0].components[1];
    }

    /** BalancerBatchRouter contract primary parsed ABI */
    export namespace Primary {
        /** Primary parsed ABI for SushiSwap RouteProcessor3 contract only including processRoute() function */
        export const BatchRouterV3 = batchRouterAbi_V3;
    }
}
