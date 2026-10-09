#!/usr/bin/env node

/* eslint-disable no-console */
const { main } = require("./dist");

// wait for piped stdout and stderr to drain so console output is not cut off at exit
const exit = (code) =>
    process.stderr.write("", () => process.stdout.write("", () => process.exit(code)));

main(process.argv)
    .then(() => {
        exit(0);
    })
    .catch((v) => {
        console.error(v, "\n");
        console.log("\x1b[31m%s\x1b[0m", "An error occured during execution!\n");
        exit(1);
    });
