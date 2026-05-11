// Wire protocol between the channel server (per Claude Code session) and the
// broker daemon. JSON-RPC 2.0 over a single bidirectional stream:
//   - Client → server requests/responses (with `id`).
//   - Server → client push notifications (no `id`).
//
// Each Claude Code session opens one connection. The connection is anonymous
// until it sends a `join` request; thereafter every subsequent request is
// authenticated as that member.

import { z } from 'zod'
import type { Member, RoomMessage, SpeakResult } from './types.ts'

// ===== JSON-RPC 2.0 envelopes =====

export const JSON_RPC_VERSION = '2.0' as const

export interface JsonRpcRequest<M extends string, P> {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  readonly id: number | string
  readonly method: M
  readonly params: P
}

export interface JsonRpcSuccess<R> {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  readonly id: number | string
  readonly result: R
}

export interface JsonRpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcError {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  /** `null` when the request could not be parsed and no id is available. */
  readonly id: number | string | null
  readonly error: JsonRpcErrorBody
}

export type JsonRpcResponse<R> = JsonRpcSuccess<R> | JsonRpcError

export interface JsonRpcNotification<M extends string, P> {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  readonly method: M
  readonly params: P
}

// ===== Method names =====

export const METHOD = {
  Join: 'join',
  Leave: 'leave',
  Speak: 'speak',
  ReadHistory: 'read_history',
  ListMembers: 'list_members',
  RoomEvent: 'room_event',
} as const

export type MethodName = (typeof METHOD)[keyof typeof METHOD]

// ===== Wire-validation schemas =====

const IdSchema = z.union([z.number(), z.string()])

/**
 * Outer envelope for any inbound JSON-RPC request. `method` is left as a
 * loose `z.string()` so the dispatcher can emit `MethodNotFound` for
 * unknown methods rather than `InvalidRequest`.
 */
export const RequestEnvelopeSchema = z.strictObject({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: IdSchema,
  method: z.string(),
  params: z.unknown(),
})
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>

export const JoinParamsSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** Optional per-user auth token. The broker only enforces it if configured with one. */
  authToken: z.string().optional(),
})
export type JoinParams = z.infer<typeof JoinParamsSchema>

export const LeaveParamsSchema = z.strictObject({})
export type LeaveParams = z.infer<typeof LeaveParamsSchema>

export const SpeakParamsSchema = z.strictObject({
  text: z.string(),
})
export type SpeakParams = z.infer<typeof SpeakParamsSchema>

export const ReadHistoryParamsSchema = z.strictObject({
  sinceId: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
})
export type ReadHistoryParams = z.infer<typeof ReadHistoryParamsSchema>

export const ListMembersParamsSchema = z.strictObject({})
export type ListMembersParams = z.infer<typeof ListMembersParamsSchema>

// ===== Result types (outbound from broker — no runtime validation) =====

export interface JoinResult {
  readonly joinedAt: number
}

export type LeaveResult = Record<string, never>

export type SpeakRpcResult = SpeakResult

export interface ReadHistoryResult {
  readonly messages: readonly RoomMessage[]
}

export interface ListMembersResult {
  readonly members: readonly Member[]
}

/** Push notification from broker to client when the client's member is woken. */
export type RoomEventParams = RoomMessage

// ===== JSON-RPC error codes =====

/**
 * Numeric error codes carried in `JsonRpcError.error.code`.
 *
 * `-32700`..`-32603` are reserved by the JSON-RPC 2.0 spec.
 * `-32000`..`-32099` are reserved for application-defined server errors.
 * We use a single application code (`ChatError`) and put the specific
 * `ChatErrorCode` in `JsonRpcErrorBody.data` so callers can branch on it
 * without parsing the human-readable message.
 */
export const RPC_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ChatError: -32000,
} as const
