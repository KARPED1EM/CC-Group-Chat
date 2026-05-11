import { describe, test, expect } from 'bun:test'
import {
  JSON_RPC_VERSION,
  JoinParamsSchema,
  LeaveParamsSchema,
  ListMembersParamsSchema,
  ReadHistoryParamsSchema,
  RequestEnvelopeSchema,
  SpeakParamsSchema,
} from '../src/protocol.ts'

describe('RequestEnvelopeSchema', () => {
  test('accepts a well-formed request', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '2.0', id: 1, method: 'speak', params: { text: 'hi' },
    }).success).toBe(true)
  })

  test('accepts a string id', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '2.0', id: 'abc', method: 'join', params: {},
    }).success).toBe(true)
  })

  test('rejects the wrong jsonrpc version', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '1.0', id: 1, method: 'speak', params: {},
    }).success).toBe(false)
  })

  test('rejects a missing id', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '2.0', method: 'speak', params: {},
    }).success).toBe(false)
  })

  test('rejects extra envelope keys', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '2.0', id: 1, method: 'speak', params: {}, extra: 'no',
    }).success).toBe(false)
  })

  test('accepts any string method (dispatcher decides validity)', () => {
    expect(RequestEnvelopeSchema.safeParse({
      jsonrpc: '2.0', id: 1, method: 'totally_made_up', params: {},
    }).success).toBe(true)
  })
})

describe('JoinParamsSchema', () => {
  test('accepts valid params', () => {
    expect(JoinParamsSchema.safeParse({ roomId: 'main', name: 'A', description: 'x' }).success).toBe(true)
  })

  test('rejects missing description', () => {
    expect(JoinParamsSchema.safeParse({ roomId: 'main', name: 'A' }).success).toBe(false)
  })

  test('rejects non-string fields', () => {
    expect(JoinParamsSchema.safeParse({ name: 42, description: '' }).success).toBe(false)
  })

  test('rejects extra keys', () => {
    expect(JoinParamsSchema.safeParse({ roomId: 'main', name: 'A', description: '', extra: 1 }).success).toBe(false)
  })
})

describe('SpeakParamsSchema', () => {
  test('accepts string text', () => {
    expect(SpeakParamsSchema.safeParse({ text: 'hi' }).success).toBe(true)
  })

  test('rejects empty object', () => {
    expect(SpeakParamsSchema.safeParse({}).success).toBe(false)
  })
})

describe('ReadHistoryParamsSchema', () => {
  test('accepts empty object', () => {
    expect(ReadHistoryParamsSchema.safeParse({}).success).toBe(true)
  })

  test('accepts non-negative integer sinceId', () => {
    expect(ReadHistoryParamsSchema.safeParse({ sinceId: 0 }).success).toBe(true)
    expect(ReadHistoryParamsSchema.safeParse({ sinceId: 42 }).success).toBe(true)
  })

  test('rejects negative sinceId', () => {
    expect(ReadHistoryParamsSchema.safeParse({ sinceId: -1 }).success).toBe(false)
  })

  test('rejects non-integer sinceId', () => {
    expect(ReadHistoryParamsSchema.safeParse({ sinceId: 1.5 }).success).toBe(false)
  })

  test('accepts positive limit', () => {
    expect(ReadHistoryParamsSchema.safeParse({ limit: 1 }).success).toBe(true)
  })

  test('rejects zero or negative limit', () => {
    expect(ReadHistoryParamsSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(ReadHistoryParamsSchema.safeParse({ limit: -1 }).success).toBe(false)
  })
})

describe('LeaveParamsSchema and ListMembersParamsSchema', () => {
  test('accept empty object', () => {
    expect(LeaveParamsSchema.safeParse({}).success).toBe(true)
    expect(ListMembersParamsSchema.safeParse({}).success).toBe(true)
  })

  test('reject any extra keys', () => {
    expect(LeaveParamsSchema.safeParse({ foo: 1 }).success).toBe(false)
    expect(ListMembersParamsSchema.safeParse({ foo: 1 }).success).toBe(false)
  })
})

describe('JSON_RPC_VERSION', () => {
  test('is the literal "2.0"', () => {
    expect(JSON_RPC_VERSION).toBe('2.0')
  })
})
