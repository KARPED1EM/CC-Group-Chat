import type { Member, RoomMessage, SpeakResult } from '@cc-group-chat/shared'
import { ChatError } from './errors.ts'
import { Room, type RoomOptions } from './room.ts'

/** Callback the broker invokes to push a room event to a single connection. */
export type PushFn = (event: RoomMessage) => void

/** Opaque per-connection identifier returned by `Broker.connect`. */
export type ConnectionHandle = symbol

interface ConnectionState {
  memberName: string | undefined
  readonly send: PushFn
}

export interface BrokerOptions {
  /** Options forwarded to the underlying `Room` (clock, hard cap, storm guard). */
  readonly room?: RoomOptions
}

/**
 * Multi-connection façade around `Room`.
 *
 * Each Claude Code session opens one connection, joins under a name, and
 * thereafter speaks / reads / lists / leaves through that handle. Room push
 * events are routed to the connection bound to the targeted member.
 *
 * The broker holds the canonical mapping `connection ⇄ member`. A `Room`
 * member name is only ever bound to one connection at a time; conversely
 * a connection can be bound to at most one member.
 */
export class Broker {
  readonly #room: Room
  readonly #connections = new Map<ConnectionHandle, ConnectionState>()
  readonly #memberToHandle = new Map<string, ConnectionHandle>()
  #nextHandleId = 1

  constructor(opts: BrokerOptions = {}) {
    this.#room = new Room(opts.room)
  }

  /** Register a new connection. Returns its handle. */
  connect(send: PushFn): ConnectionHandle {
    const handle: ConnectionHandle = Symbol(`conn#${this.#nextHandleId++}`)
    this.#connections.set(handle, { memberName: undefined, send })
    return handle
  }

  /**
   * Drop a connection. If it was bound to a member, the member implicitly
   * leaves the room. Unknown handles are a no-op (the broker tolerates
   * out-of-order disconnects from the transport layer).
   */
  disconnect(handle: ConnectionHandle): void {
    const conn = this.#connections.get(handle)
    if (!conn) return
    if (conn.memberName !== undefined) {
      this.#room.leave(conn.memberName)
      this.#memberToHandle.delete(conn.memberName)
    }
    this.#connections.delete(handle)
  }

  join(handle: ConnectionHandle, params: { readonly name: string; readonly description: string }): { joinedAt: number } {
    const conn = this.#requireConnected(handle)
    if (conn.memberName !== undefined) {
      throw new ChatError(
        'ALREADY_JOINED',
        `This connection is already joined as '${conn.memberName}'`,
      )
    }
    const member = this.#room.join(params.name, params.description)
    conn.memberName = member.name
    this.#memberToHandle.set(member.name, handle)
    return { joinedAt: member.joinedAt }
  }

  /** Idempotent. Calling on a connection that has not joined is a no-op. */
  leave(handle: ConnectionHandle): void {
    const conn = this.#requireConnected(handle)
    if (conn.memberName === undefined) return
    this.#room.leave(conn.memberName)
    this.#memberToHandle.delete(conn.memberName)
    conn.memberName = undefined
  }

  speak(handle: ConnectionHandle, params: { readonly text: string }): SpeakResult {
    const conn = this.#requireJoined(handle)
    const result = this.#room.speak(conn.memberName, params.text)
    for (const target of result.delivered) this.#push(target, result.message)
    return result
  }

  readHistory(
    handle: ConnectionHandle,
    params: { readonly sinceId?: number; readonly limit?: number },
  ): { messages: readonly RoomMessage[] } {
    this.#requireJoined(handle)
    return { messages: this.#room.history(params) }
  }

  listMembers(handle: ConnectionHandle): { members: readonly Member[] } {
    this.#requireJoined(handle)
    return { members: this.#room.members() }
  }

  #push(memberName: string, event: RoomMessage): void {
    const handle = this.#memberToHandle.get(memberName)
    if (!handle) return
    const conn = this.#connections.get(handle)
    conn?.send(event)
  }

  #requireConnected(handle: ConnectionHandle): ConnectionState {
    const conn = this.#connections.get(handle)
    if (!conn) throw new ChatError('NOT_CONNECTED', 'Unknown connection handle')
    return conn
  }

  #requireJoined(handle: ConnectionHandle): ConnectionState & { memberName: string } {
    const conn = this.#requireConnected(handle)
    if (conn.memberName === undefined) {
      throw new ChatError('NOT_JOINED', 'Call join before this method')
    }
    return conn as ConnectionState & { memberName: string }
  }
}
