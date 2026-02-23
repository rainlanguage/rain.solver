/** Tracks per-URL failure counts and cooloff deadlines */
interface OracleHealthState {
    consecutiveFailures: number;
    cooloffUntil: number; // unix ms, 0 = not cooling off
}

/**
 * Manages oracle endpoint health tracking and cooloff.
 *
 * Tracks consecutive failures per oracle URL and places failing
 * oracles into a cooloff period so they are skipped without any
 * network calls, preventing slow/dead oracles from blocking
 * order processing.
 */
export class OracleManager {
    /** How long to skip a failing oracle (ms) */
    readonly cooloffDurationMs: number;
    /** Number of consecutive failures before entering cooloff */
    readonly cooloffThreshold: number;

    private health: Map<string, OracleHealthState> = new Map();

    constructor(
        cooloffDurationMs: number = 5 * 60 * 1_000,
        cooloffThreshold: number = 3,
    ) {
        this.cooloffDurationMs = cooloffDurationMs;
        this.cooloffThreshold = cooloffThreshold;
    }

    private getHealth(url: string): OracleHealthState {
        let state = this.health.get(url);
        if (!state) {
            state = { consecutiveFailures: 0, cooloffUntil: 0 };
            this.health.set(url, state);
        }
        return state;
    }

    /** Record a successful oracle response — clears failure state */
    recordSuccess(url: string) {
        const state = this.getHealth(url);
        state.consecutiveFailures = 0;
        state.cooloffUntil = 0;
    }

    /** Record a failed oracle request — may trigger cooloff */
    recordFailure(url: string) {
        const state = this.getHealth(url);
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= this.cooloffThreshold) {
            state.cooloffUntil = Date.now() + this.cooloffDurationMs;
            console.warn(
                `Oracle ${url} entered cooloff for ${this.cooloffDurationMs / 1000}s ` +
                    `after ${state.consecutiveFailures} consecutive failures`,
            );
        }
    }

    /** Check if an oracle URL is currently in cooloff */
    isInCooloff(url: string): boolean {
        const state = this.getHealth(url);
        if (state.cooloffUntil === 0) return false;
        if (Date.now() >= state.cooloffUntil) {
            // Cooloff expired — reset but keep failure count so next
            // failure re-enters cooloff immediately
            state.cooloffUntil = 0;
            return false;
        }
        return true;
    }

    /** Get current health info for an oracle (for logging/diagnostics) */
    getStatus(url: string): { consecutiveFailures: number; inCooloff: boolean } {
        const state = this.getHealth(url);
        return {
            consecutiveFailures: state.consecutiveFailures,
            inCooloff: this.isInCooloff(url),
        };
    }

    /** Reset all health tracking state */
    reset() {
        this.health.clear();
    }
}
