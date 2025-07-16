import { parseAbi } from "viem";

// structs
const _IO = "(address token, uint8 decimals, uint256 vaultId)" as const;
const _EvaluableV3 = "(address interpreter, address store, bytes bytecode)" as const;
const _SignedContextV1 = "(address signer, uint256[] context, bytes signature)" as const;
const _TaskV1 = `(${_EvaluableV3} evaluable, ${_SignedContextV1}[] signedContext)` as const;
const _ClearStateChange =
    "(uint256 aliceOutput, uint256 bobOutput, uint256 aliceInput, uint256 bobInput)" as const;
const _OrderV3 =
    `(address owner, ${_EvaluableV3} evaluable, ${_IO}[] validInputs, ${_IO}[] validOutputs, bytes32 nonce)` as const;
const _TakeOrderConfigV3 =
    `(${_OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${_SignedContextV1}[] signedContext)` as const;
const _OrderConfigV3 =
    `(${_EvaluableV3} evaluable, ${_IO}[] validInputs, ${_IO}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
const _TakeOrdersConfigV3 =
    `(uint256 minimumInput, uint256 maximumInput, uint256 maximumIORatio, ${_TakeOrderConfigV3}[] orders, bytes data)` as const;
const _ClearConfig =
    "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, uint256 aliceBountyVaultId, uint256 bobBountyVaultId)" as const;
const _Quote =
    `(${_OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${_SignedContextV1}[] signedContext)` as const;

// signatures
const _Orderbook = [
    `event AddOrderV2(address sender, bytes32 orderHash, ${_OrderV3} order)`,
    `event RemoveOrderV2(address sender, bytes32 orderHash, ${_OrderV3} order)`,
    `event AfterClear(address sender, ${_ClearStateChange} clearStateChange)`,
    "function vaultBalance(address owner, address token, uint256 vaultId) external view returns (uint256 balance)",
    `function deposit2(address token, uint256 vaultId, uint256 amount, ${_TaskV1}[] calldata tasks) external`,
    `function addOrder2(${_OrderConfigV3} calldata config, ${_TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
    `function entask(${_TaskV1}[] calldata tasks) external`,
    `function withdraw2(address token, uint256 vaultId, uint256 targetAmount, ${_TaskV1}[] calldata tasks) external`,
    "function orderExists(bytes32 orderHash) external view returns (bool exists)",
    `function removeOrder2(${_OrderV3} calldata order, ${_TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
    "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
    `function takeOrders2(${_TakeOrdersConfigV3} memory config) external returns (uint256 totalInput, uint256 totalOutput)`,
    `function clear2(${_OrderV3} memory aliceOrder, ${_OrderV3} memory bobOrder, ${_ClearConfig} calldata clearConfig, ${_SignedContextV1}[] memory aliceSignedContext, ${_SignedContextV1}[] memory bobSignedContext) external`,
    `event TakeOrderV2(address sender, ${_TakeOrderConfigV3} config, uint256 input, uint256 output)`,
    `function quote(${_Quote} calldata quoteConfig) external view returns (bool, uint256, uint256)`,
    `event ClearV2(address sender, ${_OrderV3} alice, ${_OrderV3} bob, ${_ClearConfig} clearConfig)`,
] as const;
export const _Arb = [
    `function arb2(${_TakeOrdersConfigV3} calldata takeOrders, uint256 minimumSenderOutput, ${_EvaluableV3} calldata evaluable) external payable`,
    `function arb3(address orderBook, ${_TakeOrdersConfigV3} calldata takeOrders, ${_TaskV1} calldata task) external payable`,
    "function iRouteProcessor() external view returns (address)",
] as const;

/** Keeps Orderbook v4 related ABIs */
export namespace OrderbookAbi {
    /** Orderbook and Arb contracts primary parsed ABIs */
    export namespace Primary {
        /** Arb contract ABI */
        export const Arb = parseAbi(_Arb);

        /** Orderbook v4 contract ABI */
        export const Orderbook = parseAbi(_Orderbook);
    }

    /** Orderbook v4 structs */
    export namespace Structs {
        export const IO = _IO;
        export const EvaluableV3 = _EvaluableV3;
        export const SignedContextV1 = _SignedContextV1;
        export const TaskV1 = _TaskV1;
        export const ClearStateChange = _ClearStateChange;
        export const OrderV3 = _OrderV3;
        export const TakeOrderConfigV3 = _TakeOrderConfigV3;
        export const OrderConfigV3 = _OrderConfigV3;
        export const TakeOrdersConfigV3 = _TakeOrdersConfigV3;
        export const ClearConfig = _ClearConfig;
        export const Quote = _Quote;
    }

    /** Signature ABI for Orderbook v4 and Arb contracts */
    export namespace Signatures {
        /** Signature ABI for Orderbook contract only including vaultBalance() function */
        export const Orderbook = _Orderbook;

        /** Signature ABI for Arb contract */
        export const Arb = _Arb;
    }

    // an empty evaluable mainly used as default evaluable for arb contracts
    export const DefaultArbEvaluable = {
        interpreter: "0x" + "0".repeat(40),
        store: "0x" + "0".repeat(40),
        bytecode: "0x",
    } as const;
}
