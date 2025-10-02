// SPDX-License-Identifier: CAL
pragma solidity >=0.6.0;

import {Script} from "../lib/forge-std/src/Script.sol";

contract DiagOrder is Script {
    function run() external {
        vm.createSelectFork("rpc-url"); // rpc url
        vm.rollFork(123); // block number
        address to = 0x1234567890123456789012345678901234567890; // put arb contract address
        address from = 0x0987654321098765432109876543210987654321; // sender address
        bytes memory data = hex""; // put calldata here without 0x

        vm.startPrank(from);
        (bool success, bytes memory result) = to.call(data);
        (success, result);
    }
}