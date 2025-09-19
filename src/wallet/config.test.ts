import { parseUnits } from "viem";
import { describe, it, expect } from "vitest";
import { WalletConfig, WalletType } from "./config";

describe("Test WalletConfig tryFromAppOptions", () => {
    it("should create private key config", () => {
        const options = {
            key: "1234567890123456789012345678901234567890123456789012345678901234",
            botMinBalance: "1.5",
            selfFundVaults: [],
        } as any;

        const config = WalletConfig.tryFromAppOptions(options);

        expect(config).toEqual({
            key: `0x${options.key}`,
            type: WalletType.PrivateKey,
            minBalance: parseUnits("1.5", 18),
            selfFundVaults: [],
        });
    });

    it("should create mnemonic config", () => {
        const options = {
            mnemonic: "test test test test test test test test test test test junk",
            botMinBalance: "2.0",
            walletCount: 5,
            topupAmount: "0.1",
        } as any;

        const config = WalletConfig.tryFromAppOptions(options);

        expect(config).toEqual({
            key: options.mnemonic,
            type: WalletType.Mnemonic,
            count: options.walletCount,
            minBalance: parseUnits("2.0", 18),
            topupAmount: parseUnits("0.1", 18),
        });
    });
});
