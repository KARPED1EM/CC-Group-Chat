import type { Member, RoomMessage, SpeakResult } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import type { RoomOptions } from './room.ts'
import { RoomManager } from './room-manager.ts'

/** Callback the broker invokes to push a room event to a single connection. */
export type PushFn = (event: RoomMessage) => void

/** Opaque per-connection identifier returned by `Broker.connect`. */
export type ConnectionHandle = symbol

interface ConnectionState {
  /** Member name bound after `join`. */
  memberName: string | undefined
  /** Room id bound after `join`. */
  roomId: string | undefined
  readonly send: PushFn
}

export interface BrokerOptions {
  /**
   * Defaults applied to every room (clock, hard cap, storm guard). The
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
}

export interface JoinRequestParams {
  readonly roomId: string
  readonly name: string
  readonly description: string
  readonly authToken?: string
}

/**
 * Multi-room, multi-connection façade.
 *
 * Each Claude Code session opens one connection and joins exactly one
 * (room, name) pair. Subsequent speak / read_history / list_members /
 * leave calls implicitly operate on that bound room. Push events for a
 * message are routed only to the handles bound to the same room.
 *
 * Cross-room visibility is impossible by design: a connection has no API
 * for naming another room id, and the broker rejects requests whose handle
 * is bound to a different room.
 */
export class Broker {
  readonly #rooms: RoomManager
  readonly #authToken: string | undefined
  readonly #connections = new Map<ConnectionHandle, ConnectionState>()
  /** Maps (roomId, memberName) to the connection handle currently bound to it. */
  readonly #memberToHandle = new Map<string, ConnectionHandle>()
  #nextHandleId = 1

  constructor(opts: BrokerOptions = {}) {
    this.#rooms = new RoomManager({
      now: opts.room?.now,
      roomOptions: opts.room,
      historyTtlMs: opts.historyTtlMs,
    })
    this.#authToken = opts.authToken
  }

  /** Run a sweep of the underlying room manager. Exposed so daemons can schedule it. */
  gc(): readonly string[] {
    return this.#rooms.gc()
  }

  /** Exposed for tests and ops. Do not use for application routing. */
  get rooms(): RoomManager {
    return this.#rooms
  }

  connect(send: PushFn): ConnectionHandle {
    const handle: ConnectionHandle = Symbol(`conn#${this.#nextHandleId++}`)
    this.#connections.set(handle, { memberName: undefined, roomId: undefined, send })
    return handle
  }

  disconnect(handle: ConnectionHandle): void {
    const conn = this.#connections.get(handle)
    if (!conn) return
    if (conn.roomId !== undefined && conn.memberName !== undefined) {
      const room = this.#rooms.get(conn.roomId)
      if (room) {
        room.leave(conn.memberName)
        this.#rooms.recordMembershipChange(conn.roomId)
      }
      this.#memberToHandle.delete(membershipKey(conn.roomId, conn.memberName))
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
    conn.memberName = undefined
    conn.roomId = undefined
  }

  speak(handle: ConnectionHandle, params: { readonly text: string }): SpeakResult {
    const { roomId, memberName } = this.#requireJoined(handle)
    const room = this.#requireRoom(roomId)
    room.recordActivity(memberName)
    const result = room.speak(memberName, params.text)
    for (const target of result.delivered) this.#push(roomId, target, result.message)
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

  #push(roomId: string, memberName: string, event: RoomMessage): void {
    const handle = this.#memberToHandle.get(membershipKey(roomId, memberName))
    if (!handle) return
    const conn = this.#connections.get(handle)
    conn?.send(event)
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
      // Should not happen — the room exists for as long as a connection is
      // bound to it. Treat as internal invariant breach.
      throw new ChatError('NOT_MEMBER', `Room '${roomId}' has been evicted`)
    }
    return room
  }
}

function membershipKey(roomId: string, memberName: string): string {
  // Room ids and member names both match `[A-Za-z][A-Za-z0-9_-]*`, so the
  // `:` separator cannot collide with their content.
  return `${roomId}:${memberName}`
}
