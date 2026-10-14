import { toVaultId, VaultLedger } from "./ledger";
import { VaultRef } from "./types";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    float,
    ORDERBOOK,
    OWNER,
    USDC,
    USDC_DETAILS,
    VAULT_1,
    WETH,
    WETH_DETAILS,
} from "./fixtures";

const usdcVault: VaultRef = { orderbook: ORDERBOOK, owner: OWNER, token: USDC, vaultId: 1n };
const wethVault: VaultRef = { orderbook: ORDERBOOK, owner: OWNER, token: WETH, vaultId: 1n };

describe("Test VaultLedger", () => {
    let ledger: VaultLedger;

    beforeEach(() => {
        ledger = new VaultLedger();
    });

    it("should key a vault by its addresses and id", () => {
        expect(VaultLedger.key(usdcVault)).toBe(VaultLedger.key({ ...usdcVault }));
        expect(VaultLedger.key(usdcVault)).not.toBe(VaultLedger.key({ ...usdcVault, vaultId: 2n }));
        expect(VaultLedger.key(usdcVault)).not.toBe(VaultLedger.key(wethVault));
    });

    it("should list as unresolved only the tracked vaults with no baseline or no token details", () => {
        const refs = () => ledger.unresolvedVaults().map((state) => state.ref);
        ledger.track(usdcVault);
        expect(refs()).toEqual([usdcVault]);
        // a baseline with no token details is not enough
        ledger.setBaseline(usdcVault, 10n, 1n);
        expect(refs()).toEqual([usdcVault]);
        expect(ledger.unknownTokens()).toEqual([USDC]);
        ledger.setToken(USDC_DETAILS);
        expect(refs()).toEqual([]);

        // token details with no baseline are not enough either
        ledger.setToken(WETH_DETAILS);
        ledger.track(wethVault);
        expect(refs()).toEqual([wethVault]);
        expect(ledger.vaultsWithoutBaseline()).toEqual([wethVault]);
        ledger.setBaseline(wethVault, 1n, 1n);
        expect(refs()).toEqual([]);
        expect(ledger.unknownTokens()).toEqual([]);
    });

    it("should drop a change to a vault it does not track", () => {
        const applied = ledger.apply({ vault: usdcVault, amount: { raw: 5n }, sign: 1 }, 10n);
        expect(applied).toBe(false);
        expect(ledger.vaults.size).toBe(0);
        expect(ledger.balance(usdcVault)).toBeUndefined();
    });

    it("should keep the balance unknown until a baseline is set, then hold changes on top", () => {
        ledger.setToken(USDC_DETAILS);
        ledger.track(usdcVault);
        expect(ledger.apply({ vault: usdcVault, amount: { raw: 5n }, sign: 1 }, 10n)).toBe(true);
        expect(ledger.balance(usdcVault)).toBeUndefined();
        expect(ledger.vaultsWithoutBaseline()).toEqual([usdcVault]);

        // the baseline at block 8 holds the changes at or below it, the one at 10 is on top
        ledger.setBaseline(usdcVault, 100n, 8n);
        expect(ledger.balance(usdcVault)).toBe(105n);
        expect(ledger.vaultsWithoutBaseline()).toEqual([]);

        ledger.apply({ vault: usdcVault, amount: { raw: 2n }, sign: -1 }, 11n);
        expect(ledger.balance(usdcVault)).toBe(103n);
    });

    it("should drop the changes a baseline already holds", () => {
        ledger.setToken(USDC_DETAILS);
        ledger.track(usdcVault);
        ledger.apply({ vault: usdcVault, amount: { raw: 5n }, sign: 1 }, 10n);
        ledger.apply({ vault: usdcVault, amount: { raw: 7n }, sign: 1 }, 12n);
        // a read at block 11 saw the 5 but not the 7
        ledger.setBaseline(usdcVault, 100n, 11n);
        expect(ledger.balance(usdcVault)).toBe(107n);
    });

    it("should ignore a baseline older than the one it has", () => {
        ledger.setToken(USDC_DETAILS);
        ledger.setBaseline(usdcVault, 100n, 20n);
        ledger.setBaseline(usdcVault, 50n, 10n);
        expect(ledger.balance(usdcVault)).toBe(100n);

        // a newer one replaces it and starts the delta over
        ledger.apply({ vault: usdcVault, amount: { raw: 1n }, sign: 1 }, 21n);
        ledger.setBaseline(usdcVault, 200n, 25n);
        expect(ledger.balance(usdcVault)).toBe(200n);
    });

    it("should hold a float change until the token decimals are known, then fold it", () => {
        ledger.setBaseline(wethVault, 10n ** 18n, 5n);
        ledger.apply(
            { vault: wethVault, amount: { float: float(5n * 10n ** 17n, 18) }, sign: -1 },
            6n,
        );
        expect(ledger.balance(wethVault)).toBeUndefined();
        expect(ledger.unknownTokens()).toEqual([WETH]);

        ledger.setToken(WETH_DETAILS);
        expect(ledger.balance(wethVault)).toBe(5n * 10n ** 17n);
        expect(ledger.unknownTokens()).toEqual([]);

        // the same token handed in again does not scan the vaults, nothing
        // waits on it, a new symbol is still recorded
        const fold = vi.spyOn(ledger as any, "fold");
        ledger.setToken({ ...WETH_DETAILS, symbol: "WETH2" });
        expect(fold).not.toHaveBeenCalled();
        expect(ledger.tokens.get(WETH)?.symbol).toBe("WETH2");
        expect(ledger.balance(wethVault)).toBe(5n * 10n ** 17n);
        // other decimals are a change, the vaults are looked at again
        ledger.setToken({ ...WETH_DETAILS, decimals: 6 });
        expect(fold).toHaveBeenCalledTimes(1);
    });

    it("should reverse a change when told to, the sign flips", () => {
        ledger.setToken(USDC_DETAILS);
        ledger.setBaseline(usdcVault, 100n, 1n);
        ledger.apply({ vault: usdcVault, amount: { raw: 30n }, sign: 1 }, 2n);
        expect(ledger.balance(usdcVault)).toBe(130n);
        ledger.apply({ vault: usdcVault, amount: { raw: 30n }, sign: 1 }, 2n, true);
        expect(ledger.balance(usdcVault)).toBe(100n);
    });

    it("should key and store a vault the same whatever the letter case of the ref", () => {
        const checksummed: VaultRef = {
            orderbook: ORDERBOOK.toUpperCase().replace("0X", "0x") as `0x${string}`,
            owner: OWNER.toUpperCase().replace("0X", "0x") as `0x${string}`,
            token: USDC.toUpperCase().replace("0X", "0x") as `0x${string}`,
            vaultId: 1n,
        };
        expect(VaultLedger.key(checksummed)).toBe(VaultLedger.key(usdcVault));

        ledger.setToken(USDC_DETAILS);
        ledger.setBaseline(checksummed, 100n, 1n);
        expect(ledger.isTracked(usdcVault)).toBe(true);
        expect(ledger.vaults.get(VaultLedger.key(usdcVault))?.ref).toEqual(usdcVault);
        ledger.apply({ vault: usdcVault, amount: { raw: 5n }, sign: 1 }, 2n);
        expect(ledger.balance(checksummed)).toBe(105n);
        expect(ledger.vaultsWithoutBaseline()).toEqual([]);
    });

    it("should give a vault id as the padded bytes32 a contract call takes", () => {
        expect(toVaultId(1n)).toBe(VAULT_1);
        expect(toVaultId(0n)).toBe("0x" + "0".repeat(64));
        expect(toVaultId(2n ** 256n - 1n)).toBe("0x" + "f".repeat(64));
    });

    it("should lower case the token address it stores", () => {
        ledger.setToken({ ...USDC_DETAILS, address: USDC.toUpperCase().replace("0X", "0x") });
        expect(ledger.hasToken(USDC)).toBe(true);
        expect(ledger.tokens.get(USDC)?.address).toBe(USDC);
    });
});

describe("Test VaultLedger reads after tracking", () => {
    let ledger: VaultLedger;

    beforeEach(() => {
        ledger = new VaultLedger();
        ledger.setToken(USDC_DETAILS);
    });

    it("should leave a vault out of the reads until the read block holds the block it was tracked at", () => {
        // a deposit before the add in the same block is dropped, the vault is not tracked yet
        expect(ledger.apply({ vault: usdcVault, amount: { raw: 500n }, sign: 1 }, 10n)).toBe(false);
        ledger.track(usdcVault, 10n);
        expect(ledger.vaultsWithoutBaseline(9n)).toEqual([]);
        expect(ledger.vaultsWithoutBaseline(10n)).toEqual([usdcVault]);
        expect(ledger.vaultsWithoutBaseline()).toEqual([usdcVault]);

        // a read at the block holds the dropped deposit, and a change of the
        // same block after the add, which is in the entries, is not counted twice
        ledger.apply({ vault: usdcVault, amount: { raw: 7n }, sign: 1 }, 10n);
        ledger.setBaseline(usdcVault, 507n, 10n);
        expect(ledger.balance(usdcVault)).toBe(507n);
    });

    it("should untrack a vault only while it has no baseline or no token details", () => {
        ledger.track(usdcVault, 10n);
        ledger.apply({ vault: usdcVault, amount: { raw: 7n }, sign: 1 }, 11n);
        ledger.untrackUnresolved(usdcVault);
        expect(ledger.isTracked(usdcVault)).toBe(false);
        expect(ledger.unresolvedVaults()).toEqual([]);

        // a vault with a known balance stays
        ledger.setBaseline(usdcVault, 1n, 12n);
        ledger.untrackUnresolved(usdcVault);
        expect(ledger.balance(usdcVault)).toBe(1n);
    });
});

describe("Test VaultLedger reorgs", () => {
    let ledger: VaultLedger;

    beforeEach(() => {
        ledger = new VaultLedger();
        ledger.setToken(USDC_DETAILS);
    });

    it("should clear the baseline and read the vault again when a reorg undoes a change the baseline holds", () => {
        ledger.track(usdcVault, 5n);
        // a deposit at 10, then the read at 10 holds it
        ledger.apply({ vault: usdcVault, amount: { raw: 100n }, sign: 1 }, 10n);
        ledger.setBaseline(usdcVault, 100n, 10n);
        expect(ledger.balance(usdcVault)).toBe(100n);
        expect(ledger.vaultsWithoutBaseline()).toEqual([]);

        // a deposit at 11 lands on top, then a reorg undoes the one at 10
        ledger.apply({ vault: usdcVault, amount: { raw: 7n }, sign: 1 }, 11n);
        ledger.apply({ vault: usdcVault, amount: { raw: 100n }, sign: 1 }, 10n, true);
        expect(ledger.balance(usdcVault)).toBeUndefined();
        // the read must hold every change seen, the newest is at 11
        expect(ledger.vaultsWithoutBaseline(10n)).toEqual([]);
        expect(ledger.vaultsWithoutBaseline(11n)).toEqual([usdcVault]);

        // the deposit is mined again at 12, after the read at 11
        ledger.apply({ vault: usdcVault, amount: { raw: 100n }, sign: 1 }, 12n);
        ledger.setBaseline(usdcVault, 7n, 11n);
        expect(ledger.balance(usdcVault)).toBe(107n);
    });
});
