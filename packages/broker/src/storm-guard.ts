// Rate limits that protect the room from runaway wake loops:
//   - Per-member wake budget: cap how often any one session can be woken.
//   - @everyone cooldown: cap how often a broadcast can fan out to all sessions.
// The room-wide message hard cap lives on Room itself since it is structural,
// not temporal.

export interface StormGuardOptions {
  readonly now: () => number
  readonly perMemberWakeBudget?: number
  readonly perMemberWindowMs?: number
  readonly everyoneIntervalMs?: number
}

const DEFAULTS = {
  perMemberWakeBudget: 10,
  perMemberWindowMs: 5 * 60 * 1000,
  everyoneIntervalMs: 60 * 1000,
} as const

export class StormGuard {
  readonly #now: () => number
  readonly #budget: number
  readonly #windowMs: number
  readonly #everyoneIntervalMs: number
  readonly #wakes = new Map<string, number[]>()
  #lastEveryoneTrigger = Number.NEGATIVE_INFINITY

  constructor(opts: StormGuardOptions) {
    this.#now = opts.now
    this.#budget = opts.perMemberWakeBudget ?? DEFAULTS.perMemberWakeBudget
    this.#windowMs = opts.perMemberWindowMs ?? DEFAULTS.perMemberWindowMs
    this.#everyoneIntervalMs = opts.everyoneIntervalMs ?? DEFAULTS.everyoneIntervalMs
  }

  /**
   * Attempt to consume one wake for `name`.
   * Returns `true` if it fit within the per-member budget (and is now recorded);
   * `false` if the budget is exhausted for the current window (no state change).
   */
  tryDeliverTo(name: string): boolean {
    const wakes = this.#prunedWakes(name)
    if (wakes.length >= this.#budget) return false
    wakes.push(this.#now())
    return true
  }

  /**
   * Attempt to consume one `@everyone` broadcast.
   * Returns `true` if the cooldown has elapsed (and is now reset);
   * `false` if a previous broadcast is still within the cooldown window.
   */
  tryTriggerEveryone(): boolean {
    if (this.#now() - this.#lastEveryoneTrigger < this.#everyoneIntervalMs) return false
    this.#lastEveryoneTrigger = this.#now()
    return true
  }

  /** Drop all recorded wakes for a member. Called when they leave. */
  forget(name: string): void {
    this.#wakes.delete(name)
  }

  #prunedWakes(name: string): number[] {
    const cutoff = this.#now() - this.#windowMs
    let list = this.#wakes.get(name)
    if (!list) {
      list = []
      this.#wakes.set(name, list)
    }
    while (list.length > 0 && list[0]! < cutoff) list.shift()
    return list
  }
}
