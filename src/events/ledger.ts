import { TokenDetails } from "../common";
import { normalizeFloat } from "../common";
import { Amount, Hex, VaultChange, VaultRef } from "./types";

/** The key of a vault in the ledger */
export type VaultKey = `${Hex}:${Hex}:${Hex}:${bigint}`;

/**
 * A vault id as the bytes32 hex the orderbook uses, left padded to 32 bytes,
 * for a contract call, the one place the form matters. A short hex must never
 * reach one, a bytes32 argument gets padded on the right and names another vault
 * @param vaultId - The vault id
 */
export function toVaultId(vaultId: bigint): Hex {
    return `0x${vaultId.toString(16).padStart(64, "0")}`;
}

/** A change waiting for the vault baseline or the token decimals */
type Entry = {
    blockNumber: bigint;
    amount: Amount;
    sign: 1 | -1;
};

/** The state of one tracked vault */
export type VaultState = {
    ref: VaultRef;
    /** The balance at the baseline block, unknown until the snapshot or a read gives it */
    baseline?: bigint;
    /** The block the baseline holds at, changes at or below it are already in it */
    baselineBlock?: bigint;
    /**
     * The block a read of the baseline must be at or above, to hold every
     * change the ledger does not keep. It is the block of the event that
     * started the tracking, the changes in that block before the event were
     * dropped. A reorg that clears the baseline moves it to the newest change
     */
    trackedAt?: bigint;
    /** The newest block of a change applied to the vault */
    lastChangeBlock?: bigint;
    /** The sum of the changes above the baseline block, in token units */
    delta: bigint;
    /** Changes not folded into the delta yet, for lack of a baseline or of the token decimals */
    entries: Entry[];
};

/**
 * Keeps vault balances as a baseline plus the changes the logs report. A log
 * says how much a vault changed by, not what it holds, so a balance is only
 * known once a baseline is, from the subgraph snapshot or from a read the
 * client layer does. A change reported as a rain float needs the token
 * decimals to become token units, so it waits in the entries until the token
 * is known. Only the vaults told to track are kept, a vault an order does not
 * reference is nobody's concern, and when it becomes one a fresh read gives
 * its balance, which makes the changes before that read irrelevant. That read
 * must be at or above the block the tracking started at, see VaultState.trackedAt.
 */
export class VaultLedger {
    /** Token details by lower cased address */
    readonly tokens = new Map<Hex, TokenDetails>();
    /** Tracked vaults by key */
    readonly vaults = new Map<VaultKey, VaultState>();
    /**
     * The tracked vaults that have no baseline or no token details yet, by key.
     * The look for what the client layer must read uses this small set, so it
     * does not walk every tracked vault
     */
    private readonly unresolved = new Map<VaultKey, VaultState>();

    /** The key of a vault, the addresses lower cased, so the letter case of a ref never matters */
    static key(vault: VaultRef): VaultKey {
        const orderbook = vault.orderbook.toLowerCase() as Hex;
        const owner = vault.owner.toLowerCase() as Hex;
        const token = vault.token.toLowerCase() as Hex;
        return `${orderbook}:${owner}:${token}:${vault.vaultId}`;
    }

    /** Whether the token details are known */
    hasToken(address: Hex): boolean {
        return this.tokens.has(address.toLowerCase() as Hex);
    }

    /**
     * Records the token details and folds the changes that waited on them. A
     * token known already with the same decimals leaves nothing waiting, the
     * changes fold as they come once the decimals are known, so the scan of
     * the vaults is skipped, the order manager and the snapshot hand the same
     * token in once per order
     */
    setToken(details: TokenDetails) {
        const address = details.address.toLowerCase() as Hex;
        const known = this.tokens.get(address);
        this.tokens.set(address, { ...details, address });
        if (known && known.decimals === details.decimals) return;
        for (const [key, state] of this.vaults) {
            if (state.ref.token !== address) continue;
            this.fold(state);
            this.markResolved(key, state);
        }
    }

    /**
     * Starts tracking a vault, a no-op when it is tracked already, the ref is kept lower cased
     * @param vault - The vault
     * @param blockNumber - (optional) The block of the event that tracks the vault, see VaultState.trackedAt
     */
    track(vault: VaultRef, blockNumber?: bigint): VaultState {
        const key = VaultLedger.key(vault);
        let state = this.vaults.get(key);
        if (!state) {
            const ref: VaultRef = {
                orderbook: vault.orderbook.toLowerCase() as Hex,
                owner: vault.owner.toLowerCase() as Hex,
                token: vault.token.toLowerCase() as Hex,
                vaultId: vault.vaultId,
            };
            state = { ref, delta: 0n, entries: [], trackedAt: blockNumber };
            this.vaults.set(key, state);
            this.markResolved(key, state);
        }
        return state;
    }

    /**
     * Stops tracking a vault that has no baseline or no token details yet, so
     * nothing reads it anymore, a no-op for a resolved vault, its balance stays
     * current for an order that references it later
     */
    untrackUnresolved(vault: VaultRef) {
        const key = VaultLedger.key(vault);
        if (!this.unresolved.has(key)) return;
        this.unresolved.delete(key);
        this.vaults.delete(key);
    }

    /** Whether the vault is tracked */
    isTracked(vault: VaultRef): boolean {
        return this.vaults.has(VaultLedger.key(vault));
    }

    /**
     * Sets the balance of a vault at a block and folds the changes above that
     * block into the delta, the changes at or below it are dropped as the
     * baseline already holds them. A baseline at a block below the current one
     * is ignored, a read that lost a race to a newer one changes nothing. The
     * delta folded so far starts over, so the call is right only for a vault
     * with no baseline yet, or with no changes folded since its baseline, a
     * subgraph balance of an orderbook the logs do not sync say.
     */
    setBaseline(vault: VaultRef, balance: bigint, blockNumber: bigint) {
        const state = this.track(vault);
        if (state.baselineBlock !== undefined && state.baselineBlock > blockNumber) return;
        state.baseline = balance;
        state.baselineBlock = blockNumber;
        // the folded delta belongs to the old baseline, it starts over
        state.delta = 0n;
        state.entries = state.entries.filter((entry) => entry.blockNumber > blockNumber);
        this.fold(state);
        this.markResolved(VaultLedger.key(state.ref), state);
    }

    /**
     * Applies a change to a tracked vault, a change to a vault not tracked is
     * dropped. The change goes to the delta right away when the vault has a
     * baseline and the token is known, otherwise it waits in the entries. A
     * reorg that undoes a change at or below the baseline block clears the
     * baseline, the baseline may hold the change from the old chain, so the
     * vault is read again, at or above every change seen
     * @returns Whether the vault is tracked
     */
    apply(change: VaultChange, blockNumber: bigint, reverse = false): boolean {
        const key = VaultLedger.key(change.vault);
        const state = this.vaults.get(key);
        if (!state) return false;
        if (state.lastChangeBlock === undefined || blockNumber > state.lastChangeBlock) {
            state.lastChangeBlock = blockNumber;
        }
        if (reverse && state.baselineBlock !== undefined && blockNumber <= state.baselineBlock) {
            state.baseline = undefined;
            state.baselineBlock = undefined;
            state.delta = 0n;
            state.entries = [];
            if (state.trackedAt === undefined || state.lastChangeBlock > state.trackedAt) {
                state.trackedAt = state.lastChangeBlock;
            }
            this.markResolved(key, state);
            return true;
        }
        const sign = reverse ? -change.sign : change.sign;
        state.entries.push({ blockNumber, amount: change.amount, sign: sign as 1 | -1 });
        this.fold(state);
        return true;
    }

    /** The balance of a vault in token units, undefined until it is known */
    balance(vault: VaultRef): bigint | undefined {
        const state = this.vaults.get(VaultLedger.key(vault));
        if (!state || state.baseline === undefined || state.entries.length) return undefined;
        return state.baseline + state.delta;
    }

    /**
     * The tracked vaults with no baseline yet, the client layer reads those
     * @param readBlock - (optional) The block the read is at, a vault tracked
     * above it is left out until a read can be at its tracked block
     */
    vaultsWithoutBaseline(readBlock?: bigint): VaultRef[] {
        return this.unresolvedVaults()
            .filter((state) => state.baseline === undefined && readable(state, readBlock))
            .map((state) => state.ref);
    }

    /** The tokens of tracked vaults with no details yet, the client layer reads those */
    unknownTokens(): Hex[] {
        const unknown = new Set<Hex>();
        for (const state of this.unresolved.values()) {
            if (!this.tokens.has(state.ref.token)) unknown.add(state.ref.token);
        }
        return [...unknown];
    }

    /** The tracked vaults that have no baseline or no token details yet */
    unresolvedVaults(): VaultState[] {
        return [...this.unresolved.values()];
    }

    /** Keeps the vault in the unresolved set while it has no baseline or no token details */
    private markResolved(key: VaultKey, state: VaultState) {
        if (state.baseline !== undefined && this.tokens.has(state.ref.token)) {
            this.unresolved.delete(key);
        } else {
            this.unresolved.set(key, state);
        }
    }

    /** Folds the entries above the baseline block into the delta once both the baseline and the token are known */
    private fold(state: VaultState) {
        if (state.baseline === undefined || state.baselineBlock === undefined) return;
        const token = this.tokens.get(state.ref.token);
        if (!token) return;
        const kept: Entry[] = [];
        for (const entry of state.entries) {
            if (entry.blockNumber <= state.baselineBlock) continue;
            const units = toUnits(entry.amount, token.decimals);
            // a float that does not normalize keeps waiting, the balance stays unknown
            if (units === undefined) {
                kept.push(entry);
                continue;
            }
            state.delta += entry.sign === 1 ? units : -units;
        }
        state.entries = kept;
    }
}

/** Whether a read of the vault baseline at the given block holds every change the ledger dropped */
export function readable(state: VaultState, readBlock?: bigint): boolean {
    return readBlock === undefined || state.trackedAt === undefined || state.trackedAt <= readBlock;
}

/** An amount in token units, undefined when a float fails to normalize */
function toUnits(amount: Amount, decimals: number): bigint | undefined {
    if ("raw" in amount) return amount.raw;
    const normalized = normalizeFloat(amount.float, decimals);
    return normalized.isOk() ? normalized.value : undefined;
}
