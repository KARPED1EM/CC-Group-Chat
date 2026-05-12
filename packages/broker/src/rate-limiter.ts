// Sender-side rate limiter. The contract: each sender (a member name) may
// produce at most N messages within a sliding W-millisecond window. Loops
// produce hundreds of messages per second from the same sender; healthy
// coordination produces single-digit messages per minute. The two patterns
// are cleanly separable on the SENDER axis, which is what this limiter
// measures.
//
// The previous design measured per-RECIPIENT wake budgets, which conflated
// "this agent is being spammed" with "this orchestrator is being answered by
// many helpers in quick succession". That misattribution silently dropped
// legitimate answers in real synthesis flows. Sender-side measurement does
// not have this failure mode.

export interface SenderRateLimiterOptions {
  readonly now: () => number
  /** Max messages a single sender may send within `windowMs`. */
  readonly maxPerWindow?: number
  /** Sliding window length. */
  readonly windowMs?: number
}

const DEFAULTS = {
  maxPerWindow: 30,
  windowMs: 60_000,
} as const

export class SenderRateLimiter {
  readonly #now: () => number
  readonly #maxPerWindow: number
  readonly #windowMs: number
  readonly #timestamps = new Map<string, number[]>()

  constructor(opts: SenderRateLimiterOptions) {
    this.#now = opts.now
    this.#maxPerWindow = opts.maxPerWindow ?? DEFAULTS.maxPerWindow
    this.#windowMs = opts.windowMs ?? DEFAULTS.windowMs
  }

  /**
   * Try to consume one send slot for `sender`.
   * Returns `true` if the send fits within the window (and is now recorded);
   * `false` if the sender has exhausted their slots (no state change).
   */
  tryRecord(sender: string): boolean {
    const pruned = this.#prunedTimestamps(sender)
    if (pruned.length >= this.#maxPerWindow) return false
    pruned.push(this.#now())
    return true
  }

  /** Drop tracking for a sender. Called when they leave. */
  forget(sender: string): void {
    this.#timestamps.delete(sender)
  }

  #prunedTimestamps(sender: string): number[] {
    const cutoff = this.#now() - this.#windowMs
    let list = this.#timestamps.get(sender)
    if (!list) {
      list = []
      this.#timestamps.set(sender, list)
    }
    while (list.length > 0 && list[0]! < cutoff) list.shift()
    return list
  }
}
