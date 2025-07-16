import { parseAbi } from "viem";

const _deployer = [
    "function parse2(bytes memory data) external view returns (bytes memory bytecode)",
    "function iStore() external view returns (address)",
    "function iInterpreter() external view returns (address)",
    "function iParser() external view returns (address)",
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
}
