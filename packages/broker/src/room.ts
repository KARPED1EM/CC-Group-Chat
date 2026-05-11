import type { Member, RoomMessage, SpeakResult } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import { EVERYONE, parseMentions } from './mentions.ts'
import { StormGuard } from './storm-guard.ts'

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const RESERVED_NAMES: ReadonlySet<string> = new Set([EVERYONE])
const DEFAULT_HARD_CAP = 200

export interface RoomOptions {
  readonly now?: () => number
  readonly hardCap?: number
  readonly stormGuard?: StormGuard
}

export interface HistoryQuery {
  readonly sinceId?: number
  readonly limit?: number
}

export class Room {
  readonly #now: () => number
  readonly #hardCap: number
  readonly #stormGuard: StormGuard
  readonly #members = new Map<string, Member>()
  readonly #history: RoomMessage[] = []
  #nextId = 1

  constructor(opts: RoomOptions = {}) {
    this.#now = opts.now ?? Date.now
    this.#hardCap = opts.hardCap ?? DEFAULT_HARD_CAP
    this.#stormGuard = opts.stormGuard ?? new StormGuard({ now: this.#now })
  }

  join(name: string, description: string): Member {
    if (!NAME_PATTERN.test(name)) {
      throw new ChatError(
        'INVALID_NAME',
        `Name '${name}' must start with a letter and contain only letters, digits, '-' or '_'`,
      )
    }
    if (RESERVED_NAMES.has(name)) {
      throw new ChatError('RESERVED_NAME', `Name '${name}' is reserved`)
    }
    if (this.#members.has(name)) {
      throw new ChatError('DUPLICATE_NAME', `Name '${name}' is already in the room`)
    }
    const member: Member = { name, description, joinedAt: this.#now() }
    this.#members.set(name, member)
    return member
  }

  leave(name: string): void {
    this.#members.delete(name)
    this.#stormGuard.forget(name)
  }

  speak(from: string, text: string): SpeakResult {
    if (!this.#members.has(from)) {
      throw new ChatError('NOT_MEMBER', `'${from}' is not in the room`)
    }
    if (this.#history.length >= this.#hardCap) {
      throw new ChatError(
        'ROOM_FULL',
        `Room hard cap of ${this.#hardCap} messages reached`,
      )
    }

    const mentions = parseMentions(text)
    const targets = this.#resolveTargets(from, mentions)

    const delivered: string[] = []
    const throttled: string[] = []
    for (const target of targets) {
      if (this.#stormGuard.canDeliverTo(target)) {
        this.#stormGuard.recordDelivery(target)
        delivered.push(target)
      } else {
        throttled.push(target)
      }
    }

    const message: RoomMessage = {
      id: this.#nextId++,
      from,
      text,
      at: this.#now(),
      mentions,
    }
    this.#history.push(message)
    return { message, delivered, throttled }
  }

  members(): readonly Member[] {
    return [...this.#members.values()]
  }

  history(query: HistoryQuery = {}): readonly RoomMessage[] {
    const { sinceId, limit } = query
    const start = sinceId === undefined
      ? 0
      : this.#history.findIndex(m => m.id > sinceId)
    if (start < 0) return []
    const slice = this.#history.slice(start)
    return limit === undefined ? slice : slice.slice(0, limit)
  }

  #resolveTargets(speaker: string, mentions: readonly string[]): readonly string[] {
    const targets = new Set<string>()
    let everyoneRequested = false
    for (const m of mentions) {
      if (m === EVERYONE) {
        everyoneRequested = true
      } else if (this.#members.has(m)) {
        targets.add(m)
      }
    }
    if (everyoneRequested && this.#stormGuard.canTriggerEveryone()) {
      this.#stormGuard.recordEveryoneTrigger()
      for (const name of this.#members.keys()) targets.add(name)
    }
    targets.delete(speaker)
    return [...targets]
  }
}
