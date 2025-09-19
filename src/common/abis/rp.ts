// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { abi as rpAbi } from "../../../lib/sushiswap/protocols/route-processor/deployments/arbitrum/RouteProcessor4.json";

const _routeProcessor4 = [
    `function processRoute(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutMin ,address to, bytes memory route) external payable returns (uint256 amountOut)`,
] as const;

/** Keeps the RouteProcessor contract ABIs */
export namespace RouteProcessorAbi {
    /** RouteProcessor contract  signatures */
    export namespace Signatures {
        /** Signature ABI for SushiSwap RouteProcessor4 contract only including processRoute() function */
        export const routeProcessor4 = _routeProcessor4;
    }

    /** RouteProcessor contract primary parsed ABI */
    export namespace Primary {
        /** Primary parsed ABI for SushiSwap RouteProcessor4 contract only including processRoute() function */
        export const RouteProcessor4 = rpAbi;
    }
}
