import { ethers } from 'ethers';

/**
 * Extract oracle URL from meta bytes.
 * 
 * TODO: This will use the SDK's extractOracleUrl once the wasm package is updated.
 * For now, this is a placeholder that should parse meta bytes to find oracle URL.
 * 
 * @param metaHex - Hex string of meta bytes (e.g. "0x1234...")
 * @returns Oracle URL if found, null otherwise
 */
export function extractOracleUrl(metaHex: string): string | null {
    // TODO: Implement CBOR decoding to find RaindexSignedContextOracleV1 
    // magic number 0xff7a1507ba4419ca and extract URL.
    // For now, return null as a stub.
    console.warn('extractOracleUrl not yet implemented - waiting for SDK update');
    return null;
}

/**
 * Signed context response from oracle endpoint.
 * Maps directly to SignedContextV1 in the orderbook contract.
 */
export interface SignedContextV1 {
    /** The signer address (EIP-191 signer of the context data) */
    signer: string;
    /** The signed context data as bytes32[] values */
    context: string[];
    /** The EIP-191 signature over keccak256(abi.encodePacked(context)) */
    signature: string;
}

/**
 * Order details for oracle request.
 */
export interface OracleOrderRequest {
    order: any; // OrderV4 struct
    inputIOIndex: number;
    outputIOIndex: number;
    counterparty: string;
}

/**
 * Fetch signed context from oracle endpoint.
 * 
 * POSTs the ABI-encoded batch body and returns the array of signed contexts.
 * The request body is abi.encode((OrderV4, uint256, uint256, address)[]).
 * The response is an array of SignedContextV1 JSON objects.
 * 
 * @param url - Oracle endpoint URL
 * @param orders - Array of order requests
 * @returns Array of signed contexts matching the request array length and order
 */
export async function fetchSignedContext(
    url: string,
    orders: OracleOrderRequest[]
): Promise<SignedContextV1[]> {
    // Encode the batch request body
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    
    // For each order, create a tuple: (OrderV4, uint256, uint256, address)
    const tuples = orders.map(req => [
        req.order,
        req.inputIOIndex,
        req.outputIOIndex,
        req.counterparty
    ]);
    
    // ABI encode the array of tuples
    // Note: This needs the actual OrderV4 struct ABI definition
    // TODO: Import proper OrderV4 type definition
    const body = abiCoder.encode(
        ['tuple(tuple(address owner, tuple(address interpreter, address store, bytes bytecode) evaluable, tuple(address token, bytes32 vaultId)[] validInputs, tuple(address token, bytes32 vaultId)[] validOutputs, bytes32 nonce), uint256, uint256, address)[]'],
        [tuples]
    );
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream'
        },
        body: ethers.getBytes(body)
    });
    
    if (!response.ok) {
        throw new Error(`Oracle request failed: ${response.status} ${response.statusText}`);
    }
    
    const contexts: SignedContextV1[] = await response.json();
    
    if (!Array.isArray(contexts)) {
        throw new Error('Oracle response must be an array');
    }
    
    if (contexts.length !== orders.length) {
        throw new Error(`Oracle response length (${contexts.length}) must match request length (${orders.length})`);
    }
    
    return contexts;
}