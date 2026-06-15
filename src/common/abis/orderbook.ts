import { parseAbi, parseAbiParameters } from "viem";

namespace _v4 {
    // structs
    export const IO = "(address token, uint8 decimals, uint256 vaultId)" as const;
    export const EvaluableV3 = "(address interpreter, address store, bytes bytecode)" as const;
    export const SignedContextV1 = "(address signer, uint256[] context, bytes signature)" as const;
    export const TaskV1 = `(${EvaluableV3} evaluable, ${SignedContextV1}[] signedContext)` as const;
    export const ClearStateChange =
        "(uint256 aliceOutput, uint256 bobOutput, uint256 aliceInput, uint256 bobInput)" as const;
    export const OrderV3 =
        `(address owner, ${EvaluableV3} evaluable, ${IO}[] validInputs, ${IO}[] validOutputs, bytes32 nonce)` as const;
    export const TakeOrderConfigV3 =
        `(${OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
    export const OrderConfigV3 =
        `(${EvaluableV3} evaluable, ${IO}[] validInputs, ${IO}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
    export const TakeOrdersConfigV3 =
        `(uint256 minimumInput, uint256 maximumInput, uint256 maximumIORatio, ${TakeOrderConfigV3}[] orders, bytes data)` as const;
    export const ClearConfig =
        "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, uint256 aliceBountyVaultId, uint256 bobBountyVaultId)" as const;
    export const Quote =
        `(${OrderV3} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;

    // signatures
    export const Orderbook = [
        `event AddOrderV2(address sender, bytes32 orderHash, ${OrderV3} order)`,
        `event RemoveOrderV2(address sender, bytes32 orderHash, ${OrderV3} order)`,
        `event AfterClear(address sender, ${ClearStateChange} clearStateChange)`,
        "function vaultBalance(address owner, address token, uint256 vaultId) external view returns (uint256 balance)",
        `function deposit2(address token, uint256 vaultId, uint256 amount, ${TaskV1}[] calldata tasks) external`,
        `function addOrder2(${OrderConfigV3} calldata config, ${TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
        `function entask(${TaskV1}[] calldata tasks) external`,
        `function withdraw2(address token, uint256 vaultId, uint256 targetAmount, ${TaskV1}[] calldata tasks) external`,
        "function orderExists(bytes32 orderHash) external view returns (bool exists)",
        `function removeOrder2(${OrderV3} calldata order, ${TaskV1}[] calldata tasks) external returns (bool stateChanged)`,
        "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
        `function takeOrders2(${TakeOrdersConfigV3} memory config) external returns (uint256 totalInput, uint256 totalOutput)`,
        `function clear2(${OrderV3} memory aliceOrder, ${OrderV3} memory bobOrder, ${ClearConfig} calldata clearConfig, ${SignedContextV1}[] memory aliceSignedContext, ${SignedContextV1}[] memory bobSignedContext) external`,
        `event TakeOrderV2(address sender, ${TakeOrderConfigV3} config, uint256 input, uint256 output)`,
        `function quote(${Quote} calldata quoteConfig) external view returns (bool, uint256, uint256)`,
        `event ClearV2(address sender, ${OrderV3} alice, ${OrderV3} bob, ${ClearConfig} clearConfig)`,
    ] as const;
    export const Arb = [
        `function arb2(${TakeOrdersConfigV3} calldata takeOrders, uint256 minimumSenderOutput, ${EvaluableV3} calldata evaluable) external payable`,
        `function arb3(address orderBook, ${TakeOrdersConfigV3} calldata takeOrders, ${TaskV1} calldata task) external payable`,
        "function iRouteProcessor() external view returns (address)",
    ] as const;
}

export namespace _v5 {
    // structs
    export const Float = "bytes32" as const;
    export const IOV2 = `(address token, bytes32 vaultId)` as const;
    export const EvaluableV4 = `(address interpreter, address store, bytes bytecode)` as const;
    export const SignedContextV1 = "(address signer, bytes32[] context, bytes signature)" as const;
    export const TaskV2 = `(${EvaluableV4} evaluable, ${SignedContextV1}[] signedContext)` as const;
    export const ClearStateChangeV2 =
        `(${Float} aliceOutput, ${Float} bobOutput, ${Float} aliceInput, ${Float} bobInput)` as const;
    export const OrderV4 =
        `(address owner, ${EvaluableV4} evaluable, ${IOV2}[] validInputs, ${IOV2}[] validOutputs, bytes32 nonce)` as const;
    export const TakeOrderConfigV4 =
        `(${OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
    export const QuoteV2 =
        `(${OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
    export const TakeOrdersConfigV4 =
        `(${Float} minimumInput, ${Float} maximumInput, ${Float} maximumIORatio, ${TakeOrderConfigV4}[] orders, bytes data)` as const;
    export const OrderConfigV4 =
        `(${EvaluableV4} evaluable, ${IOV2}[] validInputs, ${IOV2}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
    export const ClearConfigV2 =
        "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, bytes32 aliceBountyVaultId, bytes32 bobBountyVaultId)" as const;

    // signatures
    export const Orderbook = [
        `event OrderNotFound(address sender, address owner, bytes32 orderHash)` as const,
        `event AddOrderV3(address sender, bytes32 orderHash, ${OrderV4} order)` as const,
        `event OrderZeroAmount(address sender, address owner, bytes32 orderHash)` as const,
        `event RemoveOrderV3(address sender, bytes32 orderHash, ${OrderV4} order)` as const,
        `event AfterClearV2(address sender, ${ClearStateChangeV2} clearStateChange)` as const,
        `event OrderExceedsMaxRatio(address sender, address owner, bytes32 orderHash)` as const,
        `event DepositV2(address sender, address token, bytes32 vaultId, uint256 depositAmountUint256)` as const,
        `event ClearV3(address sender, ${OrderV4} alice, ${OrderV4} bob, ${ClearConfigV2} clearConfig)` as const,
        `event TakeOrderV3(address sender, ${TakeOrderConfigV4} config, ${Float} input, ${Float} output)` as const,
        `event WithdrawV2(address sender, address token, bytes32 vaultId, ${Float} targetAmount, ${Float} withdrawAmount, uint256 withdrawAmountUint256)` as const,
        `function entask2(${TaskV2}[] calldata tasks) external` as const,
        `function orderExists(bytes32 orderHash) external view returns (bool exists)` as const,
        `function vaultBalance2(address owner, address token, bytes32 vaultId) external view returns (${Float} balance)` as const,
        `function deposit3(address token, bytes32 vaultId, ${Float} depositAmount, ${TaskV2}[] calldata tasks) external` as const,
        `function withdraw3(address token, bytes32 vaultId, ${Float} targetAmount, ${TaskV2}[] calldata tasks) external` as const,
        `function removeOrder3(${OrderV4} calldata order, ${TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
        `function addOrder3(${OrderConfigV4} calldata config, ${TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
        `function quote2(${QuoteV2} calldata quoteConfig) external view returns (bool exists, ${Float} outputMax, ${Float} ioRatio)` as const,
        `function takeOrders3(${TakeOrdersConfigV4} calldata config) external returns (${Float} totalTakerInput, ${Float} totalTakerOutput)` as const,
        `function clear3(${OrderV4} memory alice, ${OrderV4} memory bob, ${ClearConfigV2} calldata clearConfig, ${SignedContextV1}[] memory aliceSignedContext, ${SignedContextV1}[] memory bobSignedContext) external` as const,
        "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
    ] as const;
    export const Arb = [
        "function iRouteProcessor() external view returns (address)",
        `function arb4(address orderBook, ${TakeOrdersConfigV4} calldata takeOrders, ${TaskV2} calldata task) external payable`,
        `function arb3(address orderBook, ${TakeOrdersConfigV4} calldata takeOrders, bytes calldata exchangeData, ${TaskV2} calldata task) external payable`,
    ] as const;
}

export namespace _v6 {
    // structs
    export const Float = "bytes32" as const;
    export const IOV2 = `(address token, bytes32 vaultId)` as const;
    export const EvaluableV4 = `(address interpreter, address store, bytes bytecode)` as const;
    export const SignedContextV1 = "(address signer, bytes32[] context, bytes signature)" as const;
    export const TaskV2 = `(${EvaluableV4} evaluable, ${SignedContextV1}[] signedContext)` as const;
    export const ClearStateChangeV2 =
        `(${Float} aliceOutput, ${Float} bobOutput, ${Float} aliceInput, ${Float} bobInput)` as const;
    export const OrderV4 =
        `(address owner, ${EvaluableV4} evaluable, ${IOV2}[] validInputs, ${IOV2}[] validOutputs, bytes32 nonce)` as const;
    export const TakeOrderConfigV4 =
        `(${OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
    export const QuoteV2 =
        `(${OrderV4} order, uint256 inputIOIndex, uint256 outputIOIndex, ${SignedContextV1}[] signedContext)` as const;
    export const TakeOrdersConfigV5 =
        `(${Float} minimumIO, ${Float} maximumIO, ${Float} maximumIORatio, bool IOIsInput, ${TakeOrderConfigV4}[] orders, bytes data)` as const;
    export const OrderConfigV4 =
        `(${EvaluableV4} evaluable, ${IOV2}[] validInputs, ${IOV2}[] validOutputs, bytes32 nonce, bytes32 secret, bytes meta)` as const;
    export const ClearConfigV2 =
        "(uint256 aliceInputIOIndex, uint256 aliceOutputIOIndex, uint256 bobInputIOIndex, uint256 bobOutputIOIndex, bytes32 aliceBountyVaultId, bytes32 bobBountyVaultId)" as const;
    export const RouteLeg = `(uint8 routeLegType, address destination, bytes data)[]`;

    // signatures
    export const Orderbook = [
        `event OrderNotFound(address sender, address owner, bytes32 orderHash)` as const,
        `event AddOrderV3(address sender, bytes32 orderHash, ${OrderV4} order)` as const,
        `event OrderZeroAmount(address sender, address owner, bytes32 orderHash)` as const,
        `event RemoveOrderV3(address sender, bytes32 orderHash, ${OrderV4} order)` as const,
        `event AfterClearV2(address sender, ${ClearStateChangeV2} clearStateChange)` as const,
        `event OrderExceedsMaxRatio(address sender, address owner, bytes32 orderHash)` as const,
        `event DepositV2(address sender, address token, bytes32 vaultId, uint256 depositAmountUint256)` as const,
        `event ClearV3(address sender, ${OrderV4} alice, ${OrderV4} bob, ${ClearConfigV2} clearConfig)` as const,
        `event TakeOrderV3(address sender, ${TakeOrderConfigV4} config, ${Float} input, ${Float} output)` as const,
        `event WithdrawV2(address sender, address token, bytes32 vaultId, ${Float} targetAmount, ${Float} withdrawAmount, uint256 withdrawAmountUint256)` as const,
        `function entask2(${TaskV2}[] calldata tasks) external` as const,
        `function orderExists(bytes32 orderHash) external view returns (bool exists)` as const,
        `function vaultBalance2(address owner, address token, bytes32 vaultId) external view returns (${Float} balance)` as const,
        `function deposit4(address token, bytes32 vaultId, ${Float} depositAmount, ${TaskV2}[] calldata tasks) external` as const,
        `function withdraw4(address token, bytes32 vaultId, ${Float} targetAmount, ${TaskV2}[] calldata tasks) external` as const,
        `function removeOrder3(${OrderV4} calldata order, ${TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
        `function addOrder4(${OrderConfigV4} calldata config, ${TaskV2}[] calldata tasks) external returns (bool stateChanged)` as const,
        `function quote2(${QuoteV2} calldata quoteConfig) external view returns (bool exists, ${Float} outputMax, ${Float} ioRatio)` as const,
        `function takeOrders4(${TakeOrdersConfigV5} calldata config) external returns (${Float} totalTakerInput, ${Float} totalTakerOutput)` as const,
        `function clear3(${OrderV4} memory alice, ${OrderV4} memory bob, ${ClearConfigV2} calldata clearConfig, ${SignedContextV1}[] memory aliceSignedContext, ${SignedContextV1}[] memory bobSignedContext) external` as const,
        "function multicall(bytes[] calldata data) external returns (bytes[] memory results)",
    ] as const;
    export const Arb = [
        "function iRouteProcessor() external view returns (address)",
        `function arb5(address orderBook, ${TakeOrdersConfigV5} calldata takeOrders, ${TaskV2} calldata task) external payable`,
        `function arb4(address orderBook, ${TakeOrdersConfigV5}[] calldata startTakeOrders, bytes calldata exchangeData, ${TaskV2} calldata task) external payable`,
    ] as const;
}

/** Keeps Orderbook v4 and v5 related ABIs */
export namespace OrderbookAbi {
    export namespace V4 {
        /** Orderbook and Arb contracts primary parsed ABIs */
        export namespace Primary {
            /** Arb contract ABI */
            export const Arb = parseAbi(_v4.Arb);

            /** Orderbook v4 contract ABI */
            export const Orderbook = parseAbi(_v4.Orderbook);

            /** Order v3 struct ABI */
            export const OrderStructAbi = parseAbiParameters(_v4.OrderV3);
        }

        /** Orderbook v4 structs */
        export namespace Structs {
            export const IO = _v4.IO;
            export const Evaluable = _v4.EvaluableV3;
            export const SignedContext = _v4.SignedContextV1;
            export const Task = _v4.TaskV1;
            export const ClearStateChange = _v4.ClearStateChange;
            export const Order = _v4.OrderV3;
            export const TakeOrderConfig = _v4.TakeOrderConfigV3;
            export const OrderConfig = _v4.OrderConfigV3;
            export const TakeOrdersConfig = _v4.TakeOrdersConfigV3;
            export const ClearConfig = _v4.ClearConfig;
            export const Quote = _v4.Quote;
        }

        /** Signature ABI for Orderbook v4 and Arb contracts */
        export namespace Signatures {
            /** Signature ABI for Orderbook contract only including vaultBalance() function */
            export const Orderbook = _v4.Orderbook;

            /** Signature ABI for Arb contract */
            export const Arb = _v4.Arb;
        }

        // an empty evaluable mainly used as default evaluable for arb contracts
        export const DefaultArbEvaluable = {
            interpreter: "0x" + "0".repeat(40),
            store: "0x" + "0".repeat(40),
            bytecode: "0x",
        } as const;
    }

    export namespace V5 {
        /** Orderbook and Arb contracts primary parsed ABIs */
        export namespace Primary {
            /** Arb contract ABI */
            export const Arb = parseAbi(_v5.Arb);

            /** Orderbook v4 contract ABI */
            export const Orderbook = parseAbi(_v5.Orderbook);

            /** Order v4 struct ABI */
            export const OrderStructAbi = parseAbiParameters(_v5.OrderV4);
        }

        /** Orderbook v4 structs */
        export namespace Structs {
            export const Float = _v5.Float;
            export const IO = _v5.IOV2;
            export const Evaluable = _v5.EvaluableV4;
            export const SignedContext = _v5.SignedContextV1;
            export const Task = _v5.TaskV2;
            export const ClearStateChange = _v5.ClearStateChangeV2;
            export const Order = _v5.OrderV4;
            export const TakeOrderConfig = _v5.TakeOrderConfigV4;
            export const OrderConfig = _v5.OrderConfigV4;
            export const TakeOrdersConfig = _v5.TakeOrdersConfigV4;
            export const ClearConfig = _v5.ClearConfigV2;
            export const Quote = _v5.QuoteV2;
        }

        /** Signature ABI for Orderbook v4 and Arb contracts */
        export namespace Signatures {
            /** Signature ABI for Orderbook contract only including vaultBalance() function */
            export const Orderbook = _v5.Orderbook;

            /** Signature ABI for Arb contract */
            export const Arb = _v5.Arb;
        }

        // an empty evaluable mainly used as default evaluable for arb contracts
        export const DefaultArbEvaluable = {
            interpreter: "0x" + "0".repeat(40),
            store: "0x" + "0".repeat(40),
            bytecode: "0x",
        } as const;
    }

    export namespace V6 {
        /** Orderbook and Arb contracts primary parsed ABIs */
        export namespace Primary {
            /** Arb contract ABI */
            export const Arb = parseAbi(_v6.Arb);

            /** Orderbook v6 contract ABI */
            export const Orderbook = parseAbi(_v6.Orderbook);

            /** Order v4 (for orderbook v6) struct ABI */
            export const OrderStructAbi = parseAbiParameters(_v6.OrderV4);

            export const RouteLeg = parseAbiParameters(_v6.RouteLeg);
        }

        /** Orderbook v4 structs */
        export namespace Structs {
            export const Float = _v6.Float;
            export const IO = _v6.IOV2;
            export const Evaluable = _v6.EvaluableV4;
            export const SignedContext = _v6.SignedContextV1;
            export const Task = _v6.TaskV2;
            export const ClearStateChange = _v6.ClearStateChangeV2;
            export const Order = _v6.OrderV4;
            export const TakeOrderConfig = _v6.TakeOrderConfigV4;
            export const OrderConfig = _v6.OrderConfigV4;
            export const TakeOrdersConfig = _v6.TakeOrdersConfigV5;
            export const ClearConfig = _v6.ClearConfigV2;
            export const Quote = _v6.QuoteV2;
            export const RouteLeg = _v6.RouteLeg;
        }

        /** Signature ABI for Orderbook v4 and Arb contracts */
        export namespace Signatures {
            /** Signature ABI for Orderbook contract only including vaultBalance() function */
            export const Orderbook = _v6.Orderbook;

            /** Signature ABI for Arb contract */
            export const Arb = _v6.Arb;
        }

        // an empty evaluable mainly used as default evaluable for arb contracts
        export const DefaultArbEvaluable = {
            interpreter: "0x" + "0".repeat(40),
            store: "0x" + "0".repeat(40),
            bytecode: "0x",
        } as const;
    }
}
