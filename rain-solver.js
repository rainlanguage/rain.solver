#!/usr/bin/env node

/* eslint-disable no-console */
const { main } = require("./dist");

main(process.argv)
    .then(() => {
        process.exit(0);
    })
    .catch((v) => {
        console.log("\n");
        console.log(v);
        console.log("\x1b[31m%s\x1b[0m", "An error occured during execution!");
        process.exit(1);
    });
