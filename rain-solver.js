// #!/usr/bin/env node

// /* eslint-disable no-console */
const { sleep } = require("./dist");
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
(async () => {
    const x = await sleep(1000).then(async () => {
        await sleep(5000);
        return 50;
    });
    console.log(x);
})();
