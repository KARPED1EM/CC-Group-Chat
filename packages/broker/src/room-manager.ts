import { ChatError } from './errors.ts'
import { Room, type RoomOptions } from './room.ts'

const ROOM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const DEFAULT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

export interface RoomManagerOptions {
  /** Clock used for `lastEmptyAt` timestamps and GC decisions. */
  readonly now?: () => number
  /**
   * Default options for newly-created rooms (clock, hard cap, engagement
   * window). The room's own `id` is set by `getOrCreate`.
   */
  readonly roomOptions?: Omit<RoomOptions, 'id'>
  /** Empty rooms older than this are garbage-collected. Default 7 days. */
  readonly historyTtlMs?: number
}

interface RoomEntry {
  readonly room: Room
  /** Unix milliseconds at which the room most recently became empty; undefined while it has members. */
  lastEmptyAt: number | undefined
}

/**
 * Holds multiple `Room` instances keyed by id. Rooms are lazily created on
 * first `getOrCreate`. They live in memory after their last member leaves
 * (so an agent that rejoins shortly after can still see history) up to
 * `historyTtlMs`, after which `gc` evicts them. A re-created room with the
 * same id starts fresh — old history is not replayed.
 */
export class RoomManager {
  readonly #now: () => number
  readonly #roomOptions: Omit<RoomOptions, 'id'>
  readonly #historyTtlMs: number
  readonly #entries = new Map<string, RoomEntry>()

  constructor(opts: RoomManagerOptions = {}) {
    this.#now = opts.now ?? Date.now
    this.#roomOptions = opts.roomOptions ?? {}
    this.#historyTtlMs = opts.historyTtlMs ?? DEFAULT_HISTORY_TTL_MS
  }

  /**
   * Get the room with this id, lazily creating it if absent. Throws
   * `INVALID_ROOM_ID` if the id does not match the allowed character set.
   */
  getOrCreate(roomId: string): Room {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new ChatError(
        'INVALID_ROOM_ID',
        `Room id '${roomId}' must start with a letter and contain only letters, digits, '-' or '_' (max 64 chars)`,
      )
    }
    let entry = this.#entries.get(roomId)
    if (!entry) {
      entry = {
        room: new Room({ ...this.#roomOptions, id: roomId }),
        lastEmptyAt: undefined,
      }
      this.#entries.set(roomId, entry)
    }
    return entry.room
  }

  /** Returns the room only if it already exists; never creates. */
  get(roomId: string): Room | undefined {
    return this.#entries.get(roomId)?.room
  }

  /**
   * Notify the manager that the given room may have transitioned between
   * empty / non-empty. Called by the Broker after every join and leave so
   * the `lastEmptyAt` timestamp stays accurate without polling.
   */
  recordMembershipChange(roomId: string): void {
    const entry = this.#entries.get(roomId)
    if (!entry) return
    if (entry.room.isEmpty()) {
      if (entry.lastEmptyAt === undefined) entry.lastEmptyAt = this.#now()
    } else {
      entry.lastEmptyAt = undefined
    }
  }

  /**
   * Evict empty rooms older than the configured TTL. Returns the ids of
   * removed rooms (useful for tests and observability).
   */
  gc(): readonly string[] {
    const now = this.#now()
    const removed: string[] = []
    for (const [id, entry] of this.#entries) {
      if (entry.lastEmptyAt !== undefined && now - entry.lastEmptyAt > this.#historyTtlMs) {
        this.#entries.delete(id)
        removed.push(id)
      }
    }
    return removed
  }

  has(roomId: string): boolean {
    return this.#entries.has(roomId)
  }

  size(): number {
    return this.#entries.size
  }
}
