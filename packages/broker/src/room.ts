import type { Member, RoomMessage, SpeakResult } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import { EVERYONE, parseMentions } from './mentions.ts'
import { StormGuard } from './storm-guard.ts'

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const RESERVED_NAMES: ReadonlySet<string> = new Set([EVERYONE])
const MAX_DESCRIPTION_LENGTH = 280
const DEFAULT_HARD_CAP = 200
const DEFAULT_ROOM_ID = 'default'

export interface RoomOptions {
  /** Stable identifier stamped onto every message originating in this room. */
  readonly id?: string
  readonly now?: () => number
  readonly hardCap?: number
  readonly stormGuard?: StormGuard
}

export interface HistoryQuery {
  readonly sinceId?: number
  readonly limit?: number
}

interface ResolvedTargets {
  readonly targets: readonly string[]
  readonly everyoneThrottled: boolean
}

export class Room {
  readonly #id: string
  readonly #now: () => number
  readonly #hardCap: number
  readonly #stormGuard: StormGuard
  readonly #members = new Map<string, Member>()
  readonly #history: RoomMessage[] = []
  #nextId = 1

  constructor(opts: RoomOptions = {}) {
    this.#id = opts.id ?? DEFAULT_ROOM_ID
    this.#now = opts.now ?? Date.now
    this.#hardCap = opts.hardCap ?? DEFAULT_HARD_CAP
    this.#stormGuard = opts.stormGuard ?? new StormGuard({ now: this.#now })
  }

  get id(): string {
    return this.#id
  }

  join(name: string, description: string): Member {
    if (!NAME_PATTERN.test(name)) {
      throw new ChatError(
        'INVALID_NAME',
        `Name '${name}' must start with a letter and contain only letters, digits, '-' or '_' (max 64 chars)`,
      )
    }
    if (RESERVED_NAMES.has(name)) {
      throw new ChatError('RESERVED_NAME', `Name '${name}' is reserved`)
    }
    if (this.#members.has(name)) {
      throw new ChatError('DUPLICATE_NAME', `Name '${name}' is already in the room`)
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ChatError(
        'INVALID_DESCRIPTION',
        `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`,
      )
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
    const { targets, everyoneThrottled } = this.#resolveTargets(from, mentions)

    const delivered: string[] = []
    const throttled: string[] = []
    for (const target of targets) {
      if (this.#stormGuard.tryDeliverTo(target)) {
        delivered.push(target)
      } else {
        throttled.push(target)
      }
    }

    const message: RoomMessage = {
      id: this.#nextId++,
      roomId: this.#id,
      from,
      text,
      at: this.#now(),
      mentions,
    }
    this.#history.push(message)
    return { message, delivered, throttled, everyoneThrottled }
  }

  members(): readonly Member[] {
    return [...this.#members.values()]
  }

  /** True when no members are currently joined. */
  isEmpty(): boolean {
    return this.#members.size === 0
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

  #resolveTargets(speaker: string, mentions: readonly string[]): ResolvedTargets {
    const targets = new Set<string>()
    let everyoneRequested = false
    for (const m of mentions) {
      if (m === EVERYONE) {
        everyoneRequested = true
      } else if (this.#members.has(m)) {
        targets.add(m)
      }
    }
    let everyoneThrottled = false
    if (everyoneRequested) {
      if (this.#stormGuard.tryTriggerEveryone()) {
        for (const name of this.#members.keys()) targets.add(name)
      } else {
        everyoneThrottled = true
      }
    }
    targets.delete(speaker)
    return { targets: [...targets], everyoneThrottled }
  }
}
