// #!/usr/bin/env node

const { Float } = require("@rainlanguage/float");
const { decodeErrorResult, parseAbiItem } = require("viem");

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
// const data = "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000174d756c746963616c6c333a2063616c6c206661696c6564000000000000000000";
// console.log(decodeErrorResult({ abi: [parseAbiItem("error Error(string)")], data }));


const x = Float.fromFixedDecimal(123451n, 3).value; // a price for a token from sushi
// console.log(x.toFixedDecimal(2))
const y = Float.parse("123.451").value; // a quote ratio raw hex float
console.log(x.asHex(), y.asHex())
console.log(x.eq(y));
