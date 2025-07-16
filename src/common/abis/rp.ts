import { parseAbi } from "viem";

const _routeProcessor3 = [
    `function processRoute(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutMin ,address to, bytes memory route) external payable returns (uint256 amountOut)`,
] as const;

/** Keeps the RouteProcessor contract ABIs */
export namespace RouteProcessorAbi {
    /** RouteProcessor contract  signatures */
    export namespace Signatures {
        /** Signature ABI for SushiSwap RouteProcessor3 contract only including processRoute() function */
        export const routeProcessor3 = _routeProcessor3;
    }

    /** RouteProcessor contract primary parsed ABI */
    export namespace Primary {
        /** Primary parsed ABI for SushiSwap RouteProcessor3 contract only including processRoute() function */
        export const RouteProcessor3 = parseAbi(_routeProcessor3);
    }
}
