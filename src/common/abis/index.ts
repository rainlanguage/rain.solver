/* eslint-disable @typescript-eslint/no-unused-vars */
import { RouteProcessorAbi } from "./rp";
import { DeployerAbi } from "./deployer";
import { OrderbookAbi } from "./orderbook";
import { Multicall3Abi } from "./multicall";
import { BalancerBatchRouterAbi } from "./balancer";
import { ArbitrumNodeInterfaceAbi } from "./arbitrum";

/** Keeps all necesdsary ABIs for rain solver app */
export namespace ABI {
    export import Deployer = DeployerAbi;
    export import Orderbook = OrderbookAbi;
    export import Multicall3 = Multicall3Abi;
    export import RouteProcessor = RouteProcessorAbi;
    export import BalancerBatchRouter = BalancerBatchRouterAbi;
    export import ArbitrumNodeInterface = ArbitrumNodeInterfaceAbi;
}
