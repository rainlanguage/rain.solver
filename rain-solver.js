// #!/usr/bin/env node

// /* eslint-disable no-console */
// const { main } = require("./dist");
// const { version } = require("./package.json");

// main(process.argv, version)
//     .then(() => {
//         console.log("\x1b[32m%s\x1b[0m", "Rain Solver process finished successfully!");
//         process.exit(0);
//     })
//     .catch((v) => {
//         console.log("\x1b[31m%s\x1b[0m", "An error occured during execution: ");
//         console.log(v);
//         process.exit(1);
//     });

const { getAbiItem, toFunctionSelector } = require( "viem");
const { ABI } = require("./dist/common/abis");
// const { ABI } = require( "./dist/common");

// Get specific ABI item and convert to selector
const abiItem = getAbiItem({
    abi: ABI.Orderbook.Primary.Arb,
    name: "arb4"  // function name
});

const selector = toFunctionSelector(abiItem);
console.log(selector); // Outputs: "0x4ed39461"