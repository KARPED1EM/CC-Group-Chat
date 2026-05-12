import { describe, test, expect, beforeEach } from 'bun:test'
import { JSON_RPC_VERSION, METHOD, RPC_ERROR_CODES } from '@cc-group-chat/shared'
import { Broker, type ConnectionHandle } from '../src/broker.ts'
import { dispatch, formatRoomBatchNotification } from '../src/dispatcher.ts'

interface RpcSuccess { jsonrpc: string; id: number | string; result: unknown }
interface RpcError { jsonrpc: string; id: number | string | null; error: { code: number; message: string; data?: unknown } }

describe('dispatch', () => {
  let broker: Broker
  let handle: ConnectionHandle

  beforeEach(() => {
    broker = new Broker({ room: { now: () => 1_700_000_000_000 }, pushBatchMs: 0 })
    handle = broker.connect(() => {})
  })

  function send(req: unknown): RpcSuccess | RpcError {
    const raw = dispatch(broker, handle, JSON.stringify(req))
    if (raw === null) throw new Error('expected a response')
    return JSON.parse(raw) as RpcSuccess | RpcError
  }

  function sendRaw(raw: string): RpcSuccess | RpcError {
    const out = dispatch(broker, handle, raw)
    if (out === null) throw new Error('expected a response')
    return JSON.parse(out) as RpcSuccess | RpcError
  }

  test('routes join and returns success with joinedAt', () => {
    const r = send({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' } }) as RpcSuccess
    expect(r).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { joinedAt: 1_700_000_000_000 },
    })
  })

  test('routes speak after join and returns SpeakOk', () => {
    send({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' } })
    const r = send({ jsonrpc: '2.0', id: 2, method: 'speak', params: { text: 'hi' } }) as RpcSuccess
    const result = r.result as { ok: boolean; message: { text: string }; delivered: string[] }
    expect(result.ok).toBe(true)
    expect(result.message.text).toBe('hi')
    expect(result.delivered).toEqual([])
  })

  test('returns ParseError for invalid JSON', () => {
    const r = sendRaw('{not json') as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.ParseError)
    expect(r.id).toBeNull()
  })

  test('returns InvalidRequest for missing jsonrpc field but echoes the id', () => {
    const r = send({ id: 1, method: 'speak', params: {} }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.InvalidRequest)
    expect(r.id).toBe(1)
  })

  test('returns InvalidRequest with id: null when the input has no usable id', () => {
    const r = sendRaw('"just a string"') as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.InvalidRequest)
    expect(r.id).toBeNull()
  })

  test('returns MethodNotFound for an unknown method', () => {
    const r = send({ jsonrpc: '2.0', id: 9, method: 'unknown_method', params: {} }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.MethodNotFound)
    expect(r.id).toBe(9)
  })

  test('returns InvalidParams for a wrongly-typed join name', () => {
    const r = send({ jsonrpc: '2.0', id: 3, method: 'join', params: { roomId: 'main', name: 42, description: '' } }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.InvalidParams)
  })

  test('maps ChatError to ChatError code with data.code', () => {
    const r = send({ jsonrpc: '2.0', id: 1, method: 'speak', params: { text: 'hi' } }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.ChatError)
    expect((r.error.data as { code: string }).code).toBe('NOT_JOINED')
  })

  test('extra keys on the envelope are rejected as InvalidRequest', () => {
    const r = send({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' }, extra: 'x' }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.InvalidRequest)
  })

  test('extra keys on params are rejected as InvalidParams', () => {
    const r = send({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '', extra: 1 } }) as RpcError
    expect(r.error.code).toBe(RPC_ERROR_CODES.InvalidParams)
  })

  test('leave returns an empty object', () => {
    send({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' } })
    const r = send({ jsonrpc: '2.0', id: 2, method: 'leave', params: {} }) as RpcSuccess
    expect(r.result).toEqual({})
  })
})

describe('formatRoomBatchNotification', () => {
  test('formats a JSON-RPC notification with method=room_batch and no id', () => {
    const batch = {
      roomId: 'main',
      messages: [
        { id: 1, roomId: 'main', from: 'A', text: 'hi', at: 0, mentions: [] },
      ],
    }
    const parsed = JSON.parse(formatRoomBatchNotification(batch)) as Record<string, unknown>
    expect(parsed).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: METHOD.RoomBatch,
      params: batch,
    })
    expect(parsed.id).toBeUndefined()
  })

  test('serialises multi-message batches in order', () => {
    const batch = {
      roomId: 'main',
      messages: [
        { id: 5, roomId: 'main', from: 'A', text: 'one', at: 0, mentions: [] },
        { id: 6, roomId: 'main', from: 'B', text: 'two', at: 0, mentions: [] },
      ],
    }
    const parsed = JSON.parse(formatRoomBatchNotification(batch)) as { params: { messages: { id: number }[] } }
    expect(parsed.params.messages.map(m => m.id)).toEqual([5, 6])
  })
})
