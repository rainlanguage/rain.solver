import { parseAbi } from "viem";

const _Call3 = "(address target, bool allowFailure, bytes callData)" as const;
const _Call = "(address target, bytes callData)" as const;
const _MulticallResult = "(bool success, bytes returnData)" as const;

const _multicall3 = [
    "function getEthBalance(address addr) external view returns (uint256 balance)",
    `function aggregate3(${_Call3}[] calldata calls) external payable returns (${_MulticallResult}[] memory returnData)`,
    `function aggregate(${_Call}[] calldata calls) external payable returns (uint256 blockNumber, bytes[] memory returnData)`,
] as const;

/** Keeps the Multicall3 contract ABIs */
export namespace Multicall3Abi {
    /** Multicall3 contract primary parsed ABI */
    export namespace Primary {
        export const Multicall = parseAbi(_multicall3);
    }

    /** Multicall3 contract structs */
    export namespace Structs {
        export const Call3 = _Call3;
        export const Call = _Call;
        export const MulticallResult = _MulticallResult;
    }

    /** Multicall3 contract signatures */
    export namespace Signatures {
        export const multicall3 = _multicall3;
    }
}
