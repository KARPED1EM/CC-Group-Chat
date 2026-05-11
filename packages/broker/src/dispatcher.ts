import {
  JSON_RPC_VERSION,
  JoinParamsSchema,
  LeaveParamsSchema,
  ListMembersParamsSchema,
  METHOD,
  ReadHistoryParamsSchema,
  RequestEnvelopeSchema,
  RPC_ERROR_CODES,
  SpeakParamsSchema,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type RoomEventParams,
} from '@cc-group-chat/shared'
import { Broker, type ConnectionHandle } from './broker.ts'
import { ChatError } from './errors.ts'

/**
 * Parse one inbound JSON-RPC message and dispatch to the broker. Returns the
 * JSON string to send back, or `null` if no response is required.
 *
 * The dispatcher never throws. Every error — parse, envelope, params, broker
 * rejection, unknown method, unexpected — is mapped to a JSON-RPC error
 * response.
 */
export function dispatch(
  broker: Broker,
  handle: ConnectionHandle,
  rawMessage: string,
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch {
    return rpcError(null, RPC_ERROR_CODES.ParseError, 'Parse error')
  }

  const envelope = RequestEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return rpcError(
      extractIdLoose(parsed),
      RPC_ERROR_CODES.InvalidRequest,
      'Invalid request',
      envelope.error.issues,
    )
  }
  const { id, method, params } = envelope.data

  try {
    const result = executeMethod(broker, handle, method, params)
    return rpcSuccess(id, result)
  } catch (err) {
    if (err instanceof ChatError) {
      return rpcError(id, RPC_ERROR_CODES.ChatError, err.message, { code: err.code })
    }
    if (err instanceof MethodNotFoundError) {
      return rpcError(id, RPC_ERROR_CODES.MethodNotFound, err.message)
    }
    if (err instanceof InvalidParamsError) {
      return rpcError(id, RPC_ERROR_CODES.InvalidParams, err.message, err.issues)
    }
    const message = err instanceof Error ? err.message : String(err)
    return rpcError(id, RPC_ERROR_CODES.InternalError, message)
  }
}

/** Wraps a `RoomMessage` push as a JSON-RPC notification. */
export function formatRoomEventNotification(event: RoomEventParams): string {
  const notif: JsonRpcNotification<typeof METHOD.RoomEvent, RoomEventParams> = {
    jsonrpc: JSON_RPC_VERSION,
    method: METHOD.RoomEvent,
    params: event,
  }
  return JSON.stringify(notif)
}

class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`Method not found: ${method}`)
    this.name = 'MethodNotFoundError'
  }
}

class InvalidParamsError extends Error {
  readonly issues: unknown
  constructor(method: string, issues: unknown) {
    super(`Invalid params for ${method}`)
    this.name = 'InvalidParamsError'
    this.issues = issues
  }
}

function executeMethod(
  broker: Broker,
  handle: ConnectionHandle,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case METHOD.Join: {
      const p = JoinParamsSchema.safeParse(params)
      if (!p.success) throw new InvalidParamsError(method, p.error.issues)
      return broker.join(handle, p.data)
    }
    case METHOD.Leave: {
      const p = LeaveParamsSchema.safeParse(params)
      if (!p.success) throw new InvalidParamsError(method, p.error.issues)
      broker.leave(handle)
      return {}
    }
    case METHOD.Speak: {
      const p = SpeakParamsSchema.safeParse(params)
      if (!p.success) throw new InvalidParamsError(method, p.error.issues)
      return broker.speak(handle, p.data)
    }
    case METHOD.ReadHistory: {
      const p = ReadHistoryParamsSchema.safeParse(params)
      if (!p.success) throw new InvalidParamsError(method, p.error.issues)
      return broker.readHistory(handle, p.data)
    }
    case METHOD.ListMembers: {
      const p = ListMembersParamsSchema.safeParse(params)
      if (!p.success) throw new InvalidParamsError(method, p.error.issues)
      return broker.listMembers(handle)
    }
    default:
      throw new MethodNotFoundError(method)
  }
}

function rpcSuccess(id: number | string, result: unknown): string {
  const body: JsonRpcSuccess<unknown> = { jsonrpc: JSON_RPC_VERSION, id, result }
  return JSON.stringify(body)
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const body: JsonRpcError = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  }
  return JSON.stringify(body)
}

function extractIdLoose(x: unknown): number | string | null {
  if (typeof x === 'object' && x !== null && 'id' in x) {
    const id = (x as { id: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}
