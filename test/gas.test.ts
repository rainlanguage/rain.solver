import { assert } from "chai";
import { getL1Fee, getTxFee } from "../src/gas";

describe("Test gas", async function () {
    it("should get L1 fee from receipt", async function () {
        // mock config
        const config = {
            isSpecialL2: true,
        } as any;

        // chain is L1, no L1 fee in receipt
        const receipt1 = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
        } as any;
        assert.equal(getL1Fee(receipt1, config), 0n);

        // L2
        config.isSpecialL2 = true;
        const receipt2 = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
            l1Fee: 6n,
            l1GasPrice: 2n,
            l1GasUsed: 3n,
        } as any;
        assert.equal(getL1Fee(receipt2, config), 6n);
    });

    it("should get tx fee", async function () {
        // mock config and receipt
        const config = {
            chain: { id: 137 },
        } as any;
        const receipt = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
        } as any;

        // L1
        let result = getTxFee(receipt, config);
        assert.equal(result, 50n);

        // L2
        config.isSpecialL2 = true;
        receipt.l1Fee = 50n;
        result = getTxFee(receipt, config);
        assert.equal(result, 100n);
    });
});
