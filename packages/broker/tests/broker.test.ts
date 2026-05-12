import { describe, test, expect, beforeEach } from 'bun:test'
import type { RoomBatch } from '@cc-group-chat/shared'
import { Broker, type PushFn } from '../src/broker.ts'
import { ChatError, type ChatErrorCode } from '../src/errors.ts'

function expectChatError(fn: () => unknown, code: ChatErrorCode): void {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(ChatError)
  expect((thrown as ChatError).code).toBe(code)
}

function recorder(): { batches: RoomBatch[]; push: PushFn } {
  const batches: RoomBatch[] = []
  return { batches, push: b => { batches.push(b) } }
}

describe('Broker', () => {
  let clock = 0
  const now = () => clock
  let broker: Broker

  beforeEach(() => {
    clock = 1_700_000_000_000
    // Synchronous push for deterministic tests.
    broker = new Broker({ room: { now }, pushBatchMs: 0 })
  })

  describe('connect / disconnect', () => {
    test('connect returns a unique handle each time', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      expect(a).not.toBe(b)
    })

    test('disconnect on an unknown handle is a no-op', () => {
      expect(() => broker.disconnect(Symbol('fake'))).not.toThrow()
    })

    test('methods on an unknown handle throw NOT_CONNECTED', () => {
      const fake: symbol = Symbol('fake')
      expectChatError(() => broker.join(fake, { roomId: 'main', name: 'A', description: '' }), 'NOT_CONNECTED')
      expectChatError(() => broker.speak(fake, { text: 'hi' }), 'NOT_CONNECTED')
      expectChatError(() => broker.leave(fake), 'NOT_CONNECTED')
      expectChatError(() => broker.listMembers(fake), 'NOT_CONNECTED')
      expectChatError(() => broker.readHistory(fake, {}), 'NOT_CONNECTED')
    })
  })

  describe('join', () => {
    test('binds the member name to the connection and returns join time', () => {
      const h = broker.connect(() => {})
      const r = broker.join(h, { roomId: 'main', name: 'Alice', description: 'engineer' })
      expect(r.joinedAt).toBe(clock)
    })

    test('a second join on the same connection throws ALREADY_JOINED', () => {
      const h = broker.connect(() => {})
      broker.join(h, { roomId: 'main', name: 'Alice', description: '' })
      expectChatError(
        () => broker.join(h, { roomId: 'main', name: 'Bob', description: '' }),
        'ALREADY_JOINED',
      )
    })

    test('two connections cannot share a name (propagates DUPLICATE_NAME)', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'Alice', description: '' })
      expectChatError(
        () => broker.join(b, { roomId: 'main', name: 'Alice', description: '' }),
        'DUPLICATE_NAME',
      )
    })

    test('rejects an invalid room id at join', () => {
      const h = broker.connect(() => {})
      expectChatError(
        () => broker.join(h, { roomId: '1bad', name: 'A', description: '' }),
        'INVALID_ROOM_ID',
      )
    })
  })

  describe('auth token', () => {
    test('a broker configured with a token accepts matching joins', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret', pushBatchMs: 0 })
      const h = authed.connect(() => {})
      expect(() => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'secret' })).not.toThrow()
    })

    test('rejects a join with a wrong token (BAD_AUTH)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret', pushBatchMs: 0 })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'wrong' }),
        'BAD_AUTH',
      )
    })

    test('rejects a join that omits the token (BAD_AUTH)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret', pushBatchMs: 0 })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '' }),
        'BAD_AUTH',
      )
    })

    test('a broker without a configured token accepts joins regardless', () => {
      const open = new Broker({ room: { now }, pushBatchMs: 0 })
      const h = open.connect(() => {})
      expect(() => open.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'any' })).not.toThrow()
    })

    test('BAD_AUTH does not bind the connection (it can retry)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret', pushBatchMs: 0 })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'wrong' }),
        'BAD_AUTH',
      )
      expect(() => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'secret' })).not.toThrow()
    })
  })

  describe('speak (sync push for tests)', () => {
    test('pushes a one-message batch to the mentioned member', () => {
      const aRec = recorder()
      const bRec = recorder()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      const r = broker.speak(a, { text: '@B come over' })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.delivered).toEqual(['B'])
      expect(bRec.batches).toHaveLength(1)
      expect(bRec.batches[0]!.messages[0]!.text).toBe('@B come over')
      expect(bRec.batches[0]!.roomId).toBe('main')
      expect(aRec.batches).toHaveLength(0)
    })

    test('throws NOT_JOINED if speak is called before join', () => {
      const h = broker.connect(() => {})
      expectChatError(() => broker.speak(h, { text: 'hi' }), 'NOT_JOINED')
    })

    test('does not push to unknown @-targets', () => {
      const aRec = recorder()
      const a = broker.connect(aRec.push)
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      const r = broker.speak(a, { text: '@Ghost where are you' })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.delivered).toEqual([])
      expect(aRec.batches).toHaveLength(0)
    })
  })

  describe('multi-room isolation', () => {
    test('@mention does not cross rooms even with matching name', () => {
      const aRec = recorder(), bRec = recorder(), cRec = recorder()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      const c = broker.connect(cRec.push)
      broker.join(a, { roomId: 'r1', name: 'A', description: '' })
      broker.join(b, { roomId: 'r1', name: 'B', description: '' })
      broker.join(c, { roomId: 'r2', name: 'B', description: '' })
      broker.speak(a, { text: '@B come here' })
      expect(bRec.batches).toHaveLength(1)
      expect(cRec.batches).toHaveLength(0)
    })

    test('history is per-room', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'r1', name: 'A', description: '' })
      broker.join(b, { roomId: 'r2', name: 'B', description: '' })
      broker.speak(a, { text: 'in r1' })
      broker.speak(b, { text: 'in r2' })
      expect(broker.readHistory(a, {}).messages.map(m => m.text)).toEqual(['in r1'])
      expect(broker.readHistory(b, {}).messages.map(m => m.text)).toEqual(['in r2'])
    })

    test('messages carry the originating room id', () => {
      const a = broker.connect(() => {})
      broker.join(a, { roomId: 'project-x', name: 'A', description: '' })
      const r = broker.speak(a, { text: 'hello' })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.message.roomId).toBe('project-x')
    })
  })

  describe('leave / disconnect lifecycle', () => {
    test('explicit leave removes the member', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      broker.leave(a)
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('disconnect implicitly leaves the joined member', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      broker.disconnect(a)
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('disconnect frees the member name for someone else', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'Alice', description: '' })
      broker.disconnect(a)
      expect(() => broker.join(b, { roomId: 'main', name: 'Alice', description: '' })).not.toThrow()
    })
  })

  describe('rate limiting', () => {
    test('speak past the per-sender limit returns ok=false', () => {
      const tight = new Broker({
        room: { now },
        rateLimit: { maxPerWindow: 2, windowMs: 1000 },
        pushBatchMs: 0,
      })
      const a = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      expect(tight.speak(a, { text: '1' }).ok).toBe(true)
      expect(tight.speak(a, { text: '2' }).ok).toBe(true)
      const r3 = tight.speak(a, { text: '3' })
      expect(r3.ok).toBe(false)
      if (r3.ok) throw new Error('unreachable')
      expect(r3.reason).toBe('rate_limited')
    })

    test('rate-limited message is not stored in history', () => {
      const tight = new Broker({
        room: { now },
        rateLimit: { maxPerWindow: 1, windowMs: 1000 },
        pushBatchMs: 0,
      })
      const a = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.speak(a, { text: 'in' })
      tight.speak(a, { text: 'dropped' })  // rate-limited
      const history = tight.readHistory(a, {}).messages
      expect(history.map(m => m.text)).toEqual(['in'])
    })

    test('rate-limited message is not pushed to recipients', () => {
      const tight = new Broker({
        room: { now },
        rateLimit: { maxPerWindow: 1, windowMs: 1000 },
        pushBatchMs: 0,
      })
      const bRec = recorder()
      const a = tight.connect(() => {})
      const b = tight.connect(bRec.push)
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.join(b, { roomId: 'main', name: 'B', description: '' })
      tight.speak(a, { text: '@B first' })
      tight.speak(a, { text: '@B blocked' })
      expect(bRec.batches).toHaveLength(1)
    })

    test('per-sender rate limits are independent', () => {
      const tight = new Broker({
        room: { now },
        rateLimit: { maxPerWindow: 1, windowMs: 1000 },
        pushBatchMs: 0,
      })
      const a = tight.connect(() => {})
      const b = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.join(b, { roomId: 'main', name: 'B', description: '' })
      tight.speak(a, { text: 'a1' })
      tight.speak(a, { text: 'a2' })  // rate-limited
      expect(tight.speak(b, { text: 'b1' }).ok).toBe(true)
    })

    test('leaving and re-joining clears the rate-limit budget', () => {
      const tight = new Broker({
        room: { now },
        rateLimit: { maxPerWindow: 1, windowMs: 1000 },
        pushBatchMs: 0,
      })
      const a = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.speak(a, { text: '1' })
      expect(tight.speak(a, { text: '2' }).ok).toBe(false)
      tight.leave(a)
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      expect(tight.speak(a, { text: 'fresh' }).ok).toBe(true)
    })
  })

  describe('push batching', () => {
    test('two messages within the window arrive as one batch', async () => {
      const batched = new Broker({ room: { now }, pushBatchMs: 20 })
      const bRec = recorder()
      const a = batched.connect(() => {})
      const b = batched.connect(bRec.push)
      batched.join(a, { roomId: 'main', name: 'A', description: '' })
      batched.join(b, { roomId: 'main', name: 'B', description: '' })
      batched.speak(a, { text: '@B first' })
      batched.speak(a, { text: '@B second' })
      // Wait past the flush window
      await new Promise(r => setTimeout(r, 40))
      expect(bRec.batches).toHaveLength(1)
      expect(bRec.batches[0]!.messages).toHaveLength(2)
      expect(bRec.batches[0]!.messages.map(m => m.text)).toEqual(['@B first', '@B second'])
    })

    test('batches separate for different recipients', async () => {
      const batched = new Broker({ room: { now }, pushBatchMs: 20 })
      const bRec = recorder(), cRec = recorder()
      const a = batched.connect(() => {})
      const b = batched.connect(bRec.push)
      const c = batched.connect(cRec.push)
      batched.join(a, { roomId: 'main', name: 'A', description: '' })
      batched.join(b, { roomId: 'main', name: 'B', description: '' })
      batched.join(c, { roomId: 'main', name: 'C', description: '' })
      batched.speak(a, { text: '@B hi' })
      batched.speak(a, { text: '@C hello' })
      await new Promise(r => setTimeout(r, 40))
      expect(bRec.batches).toHaveLength(1)
      expect(cRec.batches).toHaveLength(1)
      expect(bRec.batches[0]!.messages.map(m => m.text)).toEqual(['@B hi'])
      expect(cRec.batches[0]!.messages.map(m => m.text)).toEqual(['@C hello'])
    })

    test('disconnect cancels a pending batch', async () => {
      const batched = new Broker({ room: { now }, pushBatchMs: 50 })
      const bRec = recorder()
      const a = batched.connect(() => {})
      const b = batched.connect(bRec.push)
      batched.join(a, { roomId: 'main', name: 'A', description: '' })
      batched.join(b, { roomId: 'main', name: 'B', description: '' })
      batched.speak(a, { text: '@B hi' })
      batched.disconnect(b)
      await new Promise(r => setTimeout(r, 80))
      expect(bRec.batches).toHaveLength(0)
    })
  })

  describe('readHistory and listMembers', () => {
    test('both require a joined connection', () => {
      const h = broker.connect(() => {})
      expectChatError(() => broker.readHistory(h, {}), 'NOT_JOINED')
      expectChatError(() => broker.listMembers(h), 'NOT_JOINED')
    })

    test('history reflects past speak calls', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      broker.speak(a, { text: 'one' })
      broker.speak(b, { text: 'two' })
      expect(broker.readHistory(a, {}).messages.map(m => m.text)).toEqual(['one', 'two'])
    })

    test('listMembers reflects the current roster with engagement', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: 'one' })
      broker.join(b, { roomId: 'main', name: 'B', description: 'two' })
      const ms = broker.listMembers(a).members
      expect(new Set(ms.map(m => m.name))).toEqual(new Set(['A', 'B']))
      expect(ms.every(m => m.engagement === 'engaged')).toBe(true)
    })
  })
})
