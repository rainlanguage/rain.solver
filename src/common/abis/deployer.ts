import { parseAbi } from "viem";

const _StackItem = `bytes32` as const;
const _SourceIndexV2 = `uint256` as const;
const _FullyQualifiedNamespace = `uint256` as const;
const _EvalV4 =
    `(address store, ${_FullyQualifiedNamespace} namespace, bytes bytecode, ${_SourceIndexV2} sourceIndex, bytes32[][] context, ${_StackItem}[] inputs, bytes32[] stateOverlay)` as const;

const _deployer = [
    "function parse2(bytes memory data) external view returns (bytes memory bytecode)",
    "function iStore() external view returns (address)",
    "function iInterpreter() external view returns (address)",
    "function iParser() external view returns (address)",
    `function eval4(${_EvalV4} calldata eval) external view returns (${_StackItem}[] calldata stack, bytes32[] calldata writes)`,
] as const;

/** Keeps ExpressionDeployer related ABIs */
export namespace DeployerAbi {
    /** ExpressionDeployerNPE2 contract primary parsed ABI */
    export namespace Primary {
        /** ExpressionDeployerNPE2 contract primary parsed ABI */
        export const Deployer = parseAbi(_deployer);
    }

    /** Deployer signature ABI */
    export namespace Signatures {
        /** ExpressionDeployerNPE2 signature ABI */
        export const deployer = _deployer;
    }

    /** Deployer and Interpreter structs ABI */
    export namespace Structs {
        export const EvalV4 = _EvalV4;
        export const StackItem = _StackItem;
        export const SourceIndexV2 = _SourceIndexV2;
        export const FullyQualifiedNamespace = _FullyQualifiedNamespace;
    }
}
