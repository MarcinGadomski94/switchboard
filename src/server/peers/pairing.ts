import { PAIRING_CODE_TTL_MS, PAIRING_MAX_FAILURES, normalizePairingCode } from '../../core/peers.ts';
import { hashesMatch, hashPeerToken, newPairingCode } from './tokens.ts';

/** Why a pairing code was refused. */
export type PairingRefusal = 'no-code' | 'expired' | 'wrong-code' | 'too-many-tries';

/** Options of {@link PairingCodes}. */
export interface PairingCodesOptions {
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxFailures?: number;
}

/**
 * The one pairing code of "Allow a new peer" (D48, `docs/peers.md` → *Pairing*):
 * short-lived ({@link PAIRING_CODE_TTL_MS}), single use, and burned after
 * {@link PAIRING_MAX_FAILURES} wrong tries. Held in memory only (a restart forgets
 * it); a new code replaces the old one. Compared in constant time (as hashes).
 */
export class PairingCodes {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxFailures: number;
  #current: { readonly hash: string; readonly expiresAt: number; failures: number } | null = null;

  constructor(options: PairingCodesOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.#maxFailures = options.maxFailures ?? PAIRING_MAX_FAILURES;
  }

  /** A new code (the old one stops working) and when it expires. */
  create(): { readonly code: string; readonly expiresAt: Date } {
    const code = newPairingCode();
    const expiresAt = this.#now() + this.#ttlMs;
    this.#current = { hash: hashPeerToken(code), expiresAt, failures: 0 };
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** Drops the current code (nothing can pair until a new one is made). */
  clear(): void {
    this.#current = null;
  }

  /** `true` while a code waits. */
  get pending(): boolean {
    return this.#current !== null && this.#current.expiresAt > this.#now();
  }

  /**
   * Uses the typed code: `null` = accepted (the code is gone now, single use), else
   * why not. A wrong code counts a failure; the last allowed failure burns the code.
   */
  consume(typed: unknown): PairingRefusal | null {
    const current = this.#current;
    if (!current) return 'no-code';
    if (current.expiresAt <= this.#now()) {
      this.#current = null;
      return 'expired';
    }
    const code = normalizePairingCode(typed);
    if (code !== null && hashesMatch(hashPeerToken(code), current.hash)) {
      this.#current = null;
      return null;
    }
    current.failures += 1;
    if (current.failures >= this.#maxFailures) {
      this.#current = null;
      return 'too-many-tries';
    }
    return 'wrong-code';
  }
}
