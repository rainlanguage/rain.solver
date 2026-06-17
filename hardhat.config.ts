import { config } from "dotenv";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-viem";
import { HardhatUserConfig } from "hardhat/config";

config();

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more
const hhConfig: HardhatUserConfig = {
    networks: {
        hardhat: {
            forking: {
                url: process?.env?.DEFAULT_RPC ?? "https://polygon.drpc.org",
            },
            mining: {
                auto: true,
                interval: 50,
            },
            gasPrice: "auto",
            blockGasLimit: 100000000,
            allowUnlimitedContractSize: true,
        },
    },
    mocha: {
        // explicit test configuration, just in case
        asyncOnly: true,
        bail: false,
        parallel: false,
        timeout: 5000000,
    },
    paths: {
        tests: "./test/e2e",
    },
};

export default hhConfig;
