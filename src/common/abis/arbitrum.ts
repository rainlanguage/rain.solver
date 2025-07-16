/** Keeps Arbitrum network node interface ABIs and address */
export namespace ArbitrumNodeInterfaceAbi {
    /**
     * Arbitrum node interface address, used to get L1 gas limit.
     * This is not an actual deployed smart contract, it is only
     * available to be called through an Arbitrum RPC node, and not
     * as normally other smart contracts are called.
     */
    export const Address: `0x${string}` = "0x00000000000000000000000000000000000000C8" as const;

    /**
     * Arbitrum node interface abi, used to get L1 gas limit
     */
    export const Abi = [
        {
            inputs: [
                { internalType: "address", name: "to", type: "address" },
                { internalType: "bool", name: "contractCreation", type: "bool" },
                { internalType: "bytes", name: "data", type: "bytes" },
            ],
            name: "gasEstimateComponents",
            outputs: [
                { internalType: "uint64", name: "gasEstimate", type: "uint64" },
                { internalType: "uint64", name: "gasEstimateForL1", type: "uint64" },
                { internalType: "uint256", name: "baseFee", type: "uint256" },
                { internalType: "uint256", name: "l1BaseFeeEstimate", type: "uint256" },
            ],
            stateMutability: "payable",
            type: "function",
        },
        {
            inputs: [
                { internalType: "address", name: "to", type: "address" },
                { internalType: "bool", name: "contractCreation", type: "bool" },
                { internalType: "bytes", name: "data", type: "bytes" },
            ],
            name: "gasEstimateL1Component",
            outputs: [
                { internalType: "uint64", name: "gasEstimateForL1", type: "uint64" },
                { internalType: "uint256", name: "baseFee", type: "uint256" },
                { internalType: "uint256", name: "l1BaseFeeEstimate", type: "uint256" },
            ],
            stateMutability: "payable",
            type: "function",
        },
    ] as const;
}
