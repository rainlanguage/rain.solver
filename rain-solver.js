#!/usr/bin/env node

/* eslint-disable no-console */
const { Float } = require("@rainlanguage/float");
const { maxUint256 } = require("viem");
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
const x = Float.fromHex("0xfffffffa00000000000000000000000000000000000000000000000000030d40").value;
const y = Float.fromFixedDecimalLossy(maxUint256, 18).value;
console.log(y.toFixedDecimal(18).value, y.asHex(), maxUint256)
console.log(x.gt(y)); // true