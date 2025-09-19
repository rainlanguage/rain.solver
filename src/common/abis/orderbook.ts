import { parseAbi, parseAbiParameters } from "viem";

// structs
const _Float = "bytes32" as const;
const _IOV2 = `(address token, bytes32 vaultId)` as const;
const _EvaluableV4 = `(address interpreter, address store, bytes bytecode)` as const;
const _SignedContextV1 = "(address signer, bytes32[] context, bytes signature)" as const;
const _TaskV2 = `(${_EvaluableV4} evaluable, ${_SignedContextV1}[] signedContext)` as const;
const _ClearStateChangeV2 =
    `(${_Float} aliceOutput, ${_Float} bobOutput, ${_Float} aliceInput, ${_Float} bobInput)` as const;
const _OrderV4 =
    `(address owner, ${_EvaluableV4} evaluable, ${_IOV2}[] validInputs, ${_IOV2}[] validOutputs, bytes32 nonce)` as const;
const _TakeOrderConfigV4 =
    `(${_OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${_SignedContextV1}[] signedContext)` as const;
const _QuoteV2 =
    `(${_OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${_SignedContextV1}[] signedContext)` as const;
const _TakeOrdersConfigV4 =
    `(${_Float} minimumInput, ${_Float} maximumInput, ${_Float} maximumIORatio, ${_TakeOrderConfigV4}[] orders, bytes data)` as const;
const _OrderConfigV4 =
    `(${_EvaluableV4} evaluable, ${_IOV2}[] validInputs, ${_IOV2}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
const _ClearConfigV2 =
    "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, bytes32 aliceBountyVaultId, bytes32 bobBountyVaultId)" as const;

// signatures
const _Orderbook = [
    `event OrderNotFound(address sender, address owner, bytes32 orderHash)` as const,
    `event AddOrderV3(address sender, bytes32 orderHash, ${_OrderV4} order)` as const,
    `event OrderZeroAmount(address sender, address owner, bytes32 orderHash)` as const,
    `event RemoveOrderV3(address sender, bytes32 orderHash, ${_OrderV4} order)` as const,
    `event AfterClearV2(address sender, ${_ClearStateChangeV2} clearStateChange)` as const,
    `event OrderExceedsMaxRatio(address sender, address owner, bytes32 orderHash)` as const,
    `event DepositV2(address sender, address token, bytes32 vaultId, uint256 depositAmountUint256)` as const,
    `event ClearV3(address sender, ${_OrderV4} alice, ${_OrderV4} bob, ${_ClearConfigV2} clearConfig)` as const,
    `event TakeOrderV3(address sender, ${_TakeOrderConfigV4} config, ${_Float} input, ${_Float} output)` as const,
    `event WithdrawV2(address sender, address token, bytes32 vaultId, ${_Float} targetAmount, ${_Float} withdrawAmount, uint256 withdrawAmountUint256)` as const,
    `function entask2(${_TaskV2}[] calldata tasks) external` as const,
    `function orderExists(bytes32 orderHash) external view returns (bool exists)` as const,
    `function vaultBalance2(address owner, address token, bytes32 vaultId) external view returns (${_Float} balance)` as const,
    `function deposit3(address token, bytes32 vaultId, ${_Float} depositAmount, ${_TaskV2}[] calldata tasks) external` as const,
    `function withdraw3(address token, bytes32 vaultId, ${_Float} targetAmount, ${_TaskV2}[] calldata tasks) external` as const,
    `function removeOrder3(${_OrderV4} calldata order, ${_TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
    `function addOrder3(${_OrderConfigV4} calldata config, ${_TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
    `function quote2(${_QuoteV2} calldata quoteConfig) external view returns (bool exists, ${_Float} outputMax, ${_Float} ioRatio)` as const,
    `function takeOrders3(${_TakeOrdersConfigV4} calldata config) external returns (${_Float} totalTakerInput, ${_Float} totalTakerOutput)` as const,
    `function clear3(${_OrderV4} memory alice, ${_OrderV4} memory bob, ${_ClearConfigV2} calldata clearConfig, ${_SignedContextV1}[] memory aliceSignedContext, ${_SignedContextV1}[] memory bobSignedContext) external` as const,
    "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
] as const;
export const _Arb = [
    "function iRouteProcessor() external view returns (address)",
    `function arb4(address orderBook, ${_TakeOrdersConfigV4} calldata takeOrders, ${_TaskV2} calldata task) external payable`,
    `function arb3(address orderBook, ${_TakeOrdersConfigV4} calldata takeOrders, bytes calldata exchangeData, ${_TaskV2} calldata task) external payable`,
] as const;

/** Keeps Orderbook v4 related ABIs */
export namespace OrderbookAbi {
    /** Orderbook and Arb contracts primary parsed ABIs */
    export namespace Primary {
        /** Arb contract ABI */
        export const Arb = parseAbi(_Arb);

        /** Orderbook v4 contract ABI */
        export const Orderbook = parseAbi(_Orderbook);

        /** Order v4 struct ABI */
        export const OrderStructAbi = parseAbiParameters(_OrderV4);
    }

    /** Orderbook v4 structs */
    export namespace Structs {
        export const Float = _Float;
        export const IO = _IOV2;
        export const Evaluable = _EvaluableV4;
        export const SignedContext = _SignedContextV1;
        export const Task = _TaskV2;
        export const ClearStateChange = _ClearStateChangeV2;
        export const Order = _OrderV4;
        export const TakeOrderConfig = _TakeOrderConfigV4;
        export const OrderConfig = _OrderConfigV4;
        export const TakeOrdersConfig = _TakeOrdersConfigV4;
        export const ClearConfig = _ClearConfigV2;
        export const Quote = _QuoteV2;
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
