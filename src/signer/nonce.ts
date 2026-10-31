import type { RainSolverSigner } from ".";

/**
 * Keeps the next nonce of each wallet address. A send reserves it instead of fetching
 * the tx count from the rpc, see consume. The cache of a wallet is filled at startup,
 * or at the first send that finds no entry. Each reservation moves it up by one. A
 * mined tx of any status leaves it as is, a reverted tx took its nonce too. A failed
 * send gives its nonce back, it was not used. A tx that did not mine refreshes it
 * from the chain, see refresh. The addresses are keyed case insensitive.
 */
export class NonceCache {
    /** The next nonce of each address */
    private readonly nonces = new Map<string, number>();
    /** The tx count fetch in flight of each address, so concurrent misses share one rpc call */
    private readonly fetching = new Map<string, Promise<void>>();

    /** The cache key of the given address */
    private static key(address: string): string {
        return address.toLowerCase();
    }

    /**
     * Gets the cached next nonce of the address, undefined when none is cached
     * @param address - The wallet address
     */
    get(address: string): number | undefined {
        return this.nonces.get(NonceCache.key(address));
    }

    /**
     * Sets the next nonce of the address
     * @param address - The wallet address
     * @param nonce - The next nonce
     */
    set(address: string, nonce: number) {
        this.nonces.set(NonceCache.key(address), nonce);
    }

    /**
     * Drops the cached next nonce of the address, so it gets fetched again
     * @param address - The wallet address
     */
    invalidate(address: string) {
        this.nonces.delete(NonceCache.key(address));
    }

    /**
     * Takes the next nonce of the wallet and moves the cache up by one, so the
     * next send takes the one after it. The read and the increment run with no
     * await between them. So a send that yields while its tx goes out cannot hand
     * the same nonce to a concurrent send of the same wallet. Fetches the tx count
     * when the wallet has no cached nonce, concurrent fetches of one wallet share
     * a single rpc call.
     * @param signer - The signer of the account
     * @returns The reserved nonce
     */
    async consume(signer: RainSolverSigner): Promise<number> {
        const key = NonceCache.key(signer.account.address);
        if (this.nonces.get(key) === undefined) {
            let fetching = this.fetching.get(key);
            if (!fetching) {
                // the first caller of an empty cache fetches, the rest share its call
                fetching = NonceCache.fetch(signer, "latest")
                    .then((nonce) => {
                        if (this.nonces.get(key) === undefined) this.nonces.set(key, nonce);
                    })
                    .finally(() => this.fetching.delete(key));
                this.fetching.set(key, fetching);
            }
            await fetching;
        }
        // no await from here on, so the reservation cannot race a concurrent send
        const nonce = this.nonces.get(key)!;
        this.nonces.set(key, nonce + 1);
        return nonce;
    }

    /**
     * Gives back a nonce that a send did not use, so the next send takes it again.
     * Does nothing when a concurrent send of the same wallet already reserved a
     * nonce after it, that reservation stands.
     * @param address - The wallet address
     * @param nonce - The nonce to give back
     */
    release(address: string, nonce: number) {
        if (this.get(address) === nonce + 1) this.set(address, nonce);
    }

    /**
     * Fetches the mined tx count of the signer's account and caches it as the
     * next nonce. Replaces whatever was cached.
     * @param signer - The signer of the account
     * @returns The fetched next nonce
     */
    async sync(signer: RainSolverSigner): Promise<number> {
        const nonce = await NonceCache.fetch(signer, "latest");
        this.set(signer.account.address, nonce);
        return nonce;
    }

    /**
     * Refreshes the cached next nonce after a tx of the wallet did not mine. Fetches
     * the mined tx count and the pending one. A pending count above the mined one
     * means a tx of the wallet is stuck in the pool. The mined count is cached either
     * way. So the next send takes the nonce of a stuck tx and replaces it, instead of
     * queueing behind it and getting stuck too.
     * @param signer - The signer of the account
     * @returns The cached next nonce and whether a tx of the wallet is stuck in the pool
     */
    async refresh(signer: RainSolverSigner): Promise<{ nonce: number; stuck: boolean }> {
        const [mined, pending] = await Promise.all([
            NonceCache.fetch(signer, "latest"),
            NonceCache.fetch(signer, "pending"),
        ]);
        this.set(signer.account.address, mined);
        return { nonce: mined, stuck: pending > mined };
    }

    /** Fetches the tx count of the signer's account from the rpc at the given block tag */
    private static fetch(
        signer: RainSolverSigner,
        blockTag: "latest" | "pending",
    ): Promise<number> {
        return signer.getTransactionCount({ address: signer.account.address, blockTag });
    }
}
