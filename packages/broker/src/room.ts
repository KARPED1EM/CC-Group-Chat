import type { Engagement, Member, RoomMessage, SpeakOk } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import { EVERYONE, parseMentions } from './mentions.ts'

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const RESERVED_NAMES: ReadonlySet<string> = new Set([EVERYONE])
const MAX_DESCRIPTION_LENGTH = 280
const DEFAULT_HARD_CAP = 1000
const DEFAULT_ENGAGEMENT_WINDOW_MS = 60_000
const DEFAULT_ROOM_ID = 'default'

export interface RoomOptions {
  /** Stable identifier stamped onto every message originating in this room. */
  readonly id?: string
  readonly now?: () => number
  /** Max history retained per room before further `speak` throws ROOM_FULL. */
  readonly hardCap?: number
  /**
   * Time since a member's last activity before they are reported as `idle`.
   * Defaults to 60 seconds.
   */
  readonly engagementWindowMs?: number
}

export interface HistoryQuery {
  readonly sinceId?: number
  readonly limit?: number
}

interface MemberData {
  readonly name: string
  readonly description: string
  readonly joinedAt: number
}

/**
 * Pure-logic chat room. Owns membership, history, and `@`-routing. Knows
 * nothing about transports, sessions, rate limits, or push delivery —
 * those concerns live one layer up in `Broker`.
 */
export class Room {
  readonly #id: string
  readonly #now: () => number
  readonly #hardCap: number
  readonly #engagementWindowMs: number
  readonly #members = new Map<string, MemberData>()
  readonly #lastActivityAt = new Map<string, number>()
  readonly #history: RoomMessage[] = []
  #nextId = 1

  constructor(opts: RoomOptions = {}) {
    this.#id = opts.id ?? DEFAULT_ROOM_ID
    this.#now = opts.now ?? Date.now
    this.#hardCap = opts.hardCap ?? DEFAULT_HARD_CAP
    this.#engagementWindowMs = opts.engagementWindowMs ?? DEFAULT_ENGAGEMENT_WINDOW_MS
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
    const joinedAt = this.#now()
    const data: MemberData = { name, description, joinedAt }
    this.#members.set(name, data)
    this.#lastActivityAt.set(name, joinedAt)
    return { ...data, engagement: 'engaged' }
  }

  leave(name: string): void {
    this.#members.delete(name)
    this.#lastActivityAt.delete(name)
  }

  recordActivity(name: string): void {
    if (this.#members.has(name)) {
      this.#lastActivityAt.set(name, this.#now())
    }
  }

  /**
   * Append `text` from `from` and compute the recipient set.
   *
   * Returns `SpeakOk` with `delivered` = every member that should receive a
   * push (the speaker is never in this set). Rate limiting and storm
   * protection are NOT this layer's concern; callers gate `speak` upstream
   * if necessary.
   */
  speak(from: string, text: string): SpeakOk {
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

    const message: RoomMessage = {
      id: this.#nextId++,
      roomId: this.#id,
      from,
      text,
      at: this.#now(),
      mentions,
    }
    this.#history.push(message)
    return { ok: true, message, delivered: targets }
  }

  members(): readonly Member[] {
    const now = this.#now()
    const result: Member[] = []
    for (const data of this.#members.values()) {
      const lastActivity = this.#lastActivityAt.get(data.name) ?? data.joinedAt
      const engagement: Engagement =
        now - lastActivity < this.#engagementWindowMs ? 'engaged' : 'idle'
      result.push({ ...data, engagement })
    }
    return result
  }

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

  #resolveTargets(speaker: string, mentions: readonly string[]): readonly string[] {
    const targets = new Set<string>()
    for (const m of mentions) {
      if (m === EVERYONE) {
        for (const name of this.#members.keys()) targets.add(name)
      } else if (this.#members.has(m)) {
        targets.add(m)
      }
    }
    targets.delete(speaker)
    return [...targets]
  }
}
