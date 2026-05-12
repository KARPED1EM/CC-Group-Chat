import type { Member, RoomBatch, RoomMessage, SpeakResult } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import { SenderRateLimiter, type SenderRateLimiterOptions } from './rate-limiter.ts'
import type { RoomOptions } from './room.ts'
import { RoomManager } from './room-manager.ts'

/** Callback the broker invokes to push a batch of room events to a single connection. */
export type PushFn = (batch: RoomBatch) => void

/** Opaque per-connection identifier returned by `Broker.connect`. */
export type ConnectionHandle = symbol

interface ConnectionState {
  memberName: string | undefined
  roomId: string | undefined
  readonly send: PushFn
}

interface PendingBatch {
  readonly roomId: string
  readonly messages: RoomMessage[]
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface BrokerOptions {
  /**
   * Defaults applied to every room (clock, hard cap, engagement window). The
   * `now` field doubles as the RoomManager's clock used for GC timing.
   */
  readonly room?: Omit<RoomOptions, 'id'>
  /** Empty rooms older than this are garbage-collected. Default 7 days. */
  readonly historyTtlMs?: number
  /**
   * If set, `join` requires this exact token in its params. If absent, the
   * broker accepts joins regardless of the token field (used in unit tests
   * that exercise the room state machine without the auth handshake).
   */
  readonly authToken?: string
  /**
   * Options for the per-sender rate limiter (max messages / window). The
   * limiter's clock comes from `room.now` if set, otherwise `Date.now`.
   */
  readonly rateLimit?: Omit<SenderRateLimiterOptions, 'now'>
  /**
   * Push batching window in milliseconds. Multiple messages for the same
   * recipient arriving within this window are coalesced into one push.
   * Default `50`. Set to `0` for synchronous delivery (used by tests).
   */
  readonly pushBatchMs?: number
}

export interface JoinRequestParams {
  readonly roomId: string
  readonly name: string
  readonly description: string
  readonly authToken?: string
}

const DEFAULT_PUSH_BATCH_MS = 50

/**
 * Multi-room, multi-connection façade.
 *
 * Each Claude Code session opens one connection and joins exactly one
 * (room, name) pair. Subsequent speak / read_history / list_members /
 * leave calls implicitly operate on that bound room. Messages destined
 * for a single recipient are coalesced through a per-connection batching
 * window before being pushed, so an orchestrator that receives N answers
 * in quick succession wakes once.
 *
 * The broker enforces a per-sender rate limit: at most N messages per
 * window. If a sender exceeds the limit, `speak` returns `ok: false,
 * reason: 'rate_limited'`; the message is not stored and not pushed.
 * This is the only mechanism by which messages are dropped; there is no
 * recipient-side throttle.
 */
export class Broker {
  readonly #rooms: RoomManager
  readonly #authToken: string | undefined
  readonly #rateLimiter: SenderRateLimiter
  readonly #pushBatchMs: number
  readonly #connections = new Map<ConnectionHandle, ConnectionState>()
  /** Maps (roomId, memberName) to the connection handle currently bound to it. */
  readonly #memberToHandle = new Map<string, ConnectionHandle>()
  readonly #pendingBatches = new Map<ConnectionHandle, PendingBatch>()
  #nextHandleId = 1

  constructor(opts: BrokerOptions = {}) {
    const now = opts.room?.now ?? Date.now
    this.#rooms = new RoomManager({
      now,
      roomOptions: opts.room,
      historyTtlMs: opts.historyTtlMs,
    })
    this.#authToken = opts.authToken
    this.#rateLimiter = new SenderRateLimiter({ now, ...opts.rateLimit })
    this.#pushBatchMs = opts.pushBatchMs ?? DEFAULT_PUSH_BATCH_MS
  }

  get rooms(): RoomManager {
    return this.#rooms
  }

  gc(): readonly string[] {
    return this.#rooms.gc()
  }

  connect(send: PushFn): ConnectionHandle {
    const handle: ConnectionHandle = Symbol(`conn#${this.#nextHandleId++}`)
    this.#connections.set(handle, { memberName: undefined, roomId: undefined, send })
    return handle
  }

  disconnect(handle: ConnectionHandle): void {
    const conn = this.#connections.get(handle)
    if (!conn) return
    this.#cancelPendingBatch(handle)
    if (conn.roomId !== undefined && conn.memberName !== undefined) {
      const room = this.#rooms.get(conn.roomId)
      if (room) {
        room.leave(conn.memberName)
        this.#rooms.recordMembershipChange(conn.roomId)
      }
      this.#memberToHandle.delete(membershipKey(conn.roomId, conn.memberName))
      this.#rateLimiter.forget(conn.memberName)
    }
    this.#connections.delete(handle)
  }

  join(handle: ConnectionHandle, params: JoinRequestParams): { joinedAt: number } {
    const conn = this.#requireConnected(handle)
    if (conn.memberName !== undefined) {
      throw new ChatError(
        'ALREADY_JOINED',
        `This connection is already joined as '${conn.memberName}' in room '${conn.roomId ?? '?'}'`,
      )
    }
    if (this.#authToken !== undefined && params.authToken !== this.#authToken) {
      throw new ChatError('BAD_AUTH', 'Auth token missing or does not match the broker')
    }
    const room = this.#rooms.getOrCreate(params.roomId)
    const member = room.join(params.name, params.description)
    conn.roomId = params.roomId
    conn.memberName = member.name
    this.#memberToHandle.set(membershipKey(params.roomId, member.name), handle)
    this.#rooms.recordMembershipChange(params.roomId)
    return { joinedAt: member.joinedAt }
  }

  leave(handle: ConnectionHandle): void {
    const conn = this.#requireConnected(handle)
    if (conn.roomId === undefined || conn.memberName === undefined) return
    const room = this.#rooms.get(conn.roomId)
    if (room) {
      room.leave(conn.memberName)
      this.#rooms.recordMembershipChange(conn.roomId)
    }
    this.#memberToHandle.delete(membershipKey(conn.roomId, conn.memberName))
    this.#rateLimiter.forget(conn.memberName)
    conn.memberName = undefined
    conn.roomId = undefined
  }

  speak(handle: ConnectionHandle, params: { readonly text: string }): SpeakResult {
    const { roomId, memberName } = this.#requireJoined(handle)
    if (!this.#rateLimiter.tryRecord(memberName)) {
      return { ok: false, reason: 'rate_limited' }
    }
    const room = this.#requireRoom(roomId)
    room.recordActivity(memberName)
    const result = room.speak(memberName, params.text)
    for (const target of result.delivered) this.#enqueuePush(roomId, target, result.message)
    return result
  }

  readHistory(
    handle: ConnectionHandle,
    params: { readonly sinceId?: number; readonly limit?: number },
  ): { messages: readonly RoomMessage[] } {
    const { roomId, memberName } = this.#requireJoined(handle)
    const room = this.#requireRoom(roomId)
    room.recordActivity(memberName)
    return { messages: room.history(params) }
  }

  listMembers(handle: ConnectionHandle): { members: readonly Member[] } {
    const { roomId, memberName } = this.#requireJoined(handle)
    const room = this.#requireRoom(roomId)
    room.recordActivity(memberName)
    return { members: room.members() }
  }

  #enqueuePush(roomId: string, memberName: string, message: RoomMessage): void {
    const handle = this.#memberToHandle.get(membershipKey(roomId, memberName))
    if (!handle) return

    if (this.#pushBatchMs === 0) {
      this.#sendBatch(handle, { roomId, messages: [message] })
      return
    }

    let pending = this.#pendingBatches.get(handle)
    if (!pending) {
      pending = { roomId, messages: [], timer: undefined }
      this.#pendingBatches.set(handle, pending)
    }
    pending.messages.push(message)
    if (pending.timer === undefined) {
      pending.timer = setTimeout(() => this.#flushBatch(handle), this.#pushBatchMs)
    }
  }

  #flushBatch(handle: ConnectionHandle): void {
    const pending = this.#pendingBatches.get(handle)
    if (!pending) return
    this.#pendingBatches.delete(handle)
    if (pending.messages.length === 0) return
    this.#sendBatch(handle, { roomId: pending.roomId, messages: pending.messages })
  }

  #cancelPendingBatch(handle: ConnectionHandle): void {
    const pending = this.#pendingBatches.get(handle)
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    this.#pendingBatches.delete(handle)
  }

  #sendBatch(handle: ConnectionHandle, batch: RoomBatch): void {
    const conn = this.#connections.get(handle)
    if (!conn) return
    conn.send(batch)
  }

  #requireConnected(handle: ConnectionHandle): ConnectionState {
    const conn = this.#connections.get(handle)
    if (!conn) throw new ChatError('NOT_CONNECTED', 'Unknown connection handle')
    return conn
  }

  #requireJoined(handle: ConnectionHandle): ConnectionState & { roomId: string; memberName: string } {
    const conn = this.#requireConnected(handle)
    if (conn.memberName === undefined || conn.roomId === undefined) {
      throw new ChatError('NOT_JOINED', 'Call join before this method')
    }
    return conn as ConnectionState & { roomId: string; memberName: string }
  }

  #requireRoom(roomId: string) {
    const room = this.#rooms.get(roomId)
    if (!room) {
      throw new ChatError('NOT_MEMBER', `Room '${roomId}' has been evicted`)
    }
    return room
  }
}

function membershipKey(roomId: string, memberName: string): string {
  return `${roomId}:${memberName}`
}
