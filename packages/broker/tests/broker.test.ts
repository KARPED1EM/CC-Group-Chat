import { describe, test, expect, beforeEach } from 'bun:test'
import type { RoomMessage } from '@cc-group-chat/shared'
import { Broker, type PushFn } from '../src/broker.ts'
import { ChatError, type ChatErrorCode } from '../src/errors.ts'
import { StormGuard } from '../src/storm-guard.ts'

function expectChatError(fn: () => unknown, code: ChatErrorCode): void {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(ChatError)
  expect((thrown as ChatError).code).toBe(code)
}

function recorder(): { received: RoomMessage[]; push: PushFn } {
  const received: RoomMessage[] = []
  return { received, push: m => { received.push(m) } }
}

describe('Broker', () => {
  let clock = 0
  const now = () => clock
  let broker: Broker

  beforeEach(() => {
    clock = 1_700_000_000_000
    broker = new Broker({ room: { now } })
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
      expectChatError(() => broker.join(fake, { name: 'A', description: '' }), 'NOT_CONNECTED')
      expectChatError(() => broker.speak(fake, { text: 'hi' }), 'NOT_CONNECTED')
      expectChatError(() => broker.leave(fake), 'NOT_CONNECTED')
      expectChatError(() => broker.listMembers(fake), 'NOT_CONNECTED')
      expectChatError(() => broker.readHistory(fake, {}), 'NOT_CONNECTED')
    })
  })

  describe('join', () => {
    test('binds the member name to the connection and returns join time', () => {
      const h = broker.connect(() => {})
      const r = broker.join(h, { name: 'Alice', description: 'engineer' })
      expect(r.joinedAt).toBe(clock)
    })

    test('a second join on the same connection throws ALREADY_JOINED', () => {
      const h = broker.connect(() => {})
      broker.join(h, { name: 'Alice', description: '' })
      expectChatError(
        () => broker.join(h, { name: 'Bob', description: '' }),
        'ALREADY_JOINED',
      )
    })

    test('two connections cannot share a name (propagates DUPLICATE_NAME)', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { name: 'Alice', description: '' })
      expectChatError(
        () => broker.join(b, { name: 'Alice', description: '' }),
        'DUPLICATE_NAME',
      )
    })
  })

  describe('speak and push routing', () => {
    test('pushes the message to a mentioned member', () => {
      const aRec = recorder()
      const bRec = recorder()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      broker.join(a, { name: 'A', description: '' })
      broker.join(b, { name: 'B', description: '' })
      broker.speak(a, { text: '@B come over' })
      expect(bRec.received).toHaveLength(1)
      expect(bRec.received[0]!.from).toBe('A')
      expect(bRec.received[0]!.text).toBe('@B come over')
      expect(aRec.received).toHaveLength(0)
    })

    test('@everyone pushes to all members except the speaker', () => {
      const recs = [recorder(), recorder(), recorder()]
      const handles = recs.map(r => broker.connect(r.push))
      broker.join(handles[0]!, { name: 'A', description: '' })
      broker.join(handles[1]!, { name: 'B', description: '' })
      broker.join(handles[2]!, { name: 'C', description: '' })
      broker.speak(handles[0]!, { text: '@everyone heads up' })
      expect(recs[0]!.received).toHaveLength(0)
      expect(recs[1]!.received).toHaveLength(1)
      expect(recs[2]!.received).toHaveLength(1)
    })

    test('does not push to throttled targets', () => {
      const tightGuard = new StormGuard({
        now,
        perMemberWakeBudget: 1,
        perMemberWindowMs: 60_000,
      })
      const tight = new Broker({ room: { now, stormGuard: tightGuard } })
      const bRec = recorder()
      const a = tight.connect(() => {})
      const b = tight.connect(bRec.push)
      tight.join(a, { name: 'A', description: '' })
      tight.join(b, { name: 'B', description: '' })
      tight.speak(a, { text: '@B one' })
      const r2 = tight.speak(a, { text: '@B two' })
      expect(r2.throttled).toEqual(['B'])
      // Only the first message reached B; the throttled one did not.
      expect(bRec.received).toHaveLength(1)
    })

    test('does not push to unknown @-targets', () => {
      const aRec = recorder()
      const a = broker.connect(aRec.push)
      broker.join(a, { name: 'A', description: '' })
      const r = broker.speak(a, { text: '@Ghost where are you' })
      expect(r.delivered).toEqual([])
      expect(aRec.received).toHaveLength(0)
    })

    test('throws NOT_JOINED if speak called before join', () => {
      const h = broker.connect(() => {})
      expectChatError(() => broker.speak(h, { text: 'hi' }), 'NOT_JOINED')
    })
  })

  describe('leave and disconnect', () => {
    test('explicit leave removes the member', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { name: 'A', description: '' })
      broker.join(b, { name: 'B', description: '' })
      broker.leave(a)
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('leave on a connection that never joined is a no-op', () => {
      const h = broker.connect(() => {})
      expect(() => broker.leave(h)).not.toThrow()
    })

    test('disconnect implicitly leaves the joined member', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { name: 'A', description: '' })
      broker.join(b, { name: 'B', description: '' })
      broker.disconnect(a)
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('after leave, the same connection can join under a new name', () => {
      const h = broker.connect(() => {})
      broker.join(h, { name: 'Alice', description: 'first' })
      broker.leave(h)
      const r = broker.join(h, { name: 'Bob', description: 'second' })
      expect(r.joinedAt).toBe(clock)
    })

    test('disconnect frees the member name for someone else', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { name: 'Alice', description: '' })
      broker.disconnect(a)
      expect(() => broker.join(b, { name: 'Alice', description: '' })).not.toThrow()
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
      broker.join(a, { name: 'A', description: '' })
      broker.join(b, { name: 'B', description: '' })
      broker.speak(a, { text: 'one' })
      broker.speak(b, { text: 'two' })
      expect(broker.readHistory(a, {}).messages.map(m => m.text)).toEqual(['one', 'two'])
    })

    test('listMembers reflects the current roster', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { name: 'A', description: 'one' })
      broker.join(b, { name: 'B', description: 'two' })
      const names = broker.listMembers(a).members.map(m => m.name)
      expect(new Set(names)).toEqual(new Set(['A', 'B']))
    })
  })
})
