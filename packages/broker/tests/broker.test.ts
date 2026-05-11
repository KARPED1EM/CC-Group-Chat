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
  })

  describe('engagement tracking', () => {
    test('list_members reports engaged immediately after join', () => {
      const a = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      expect(broker.listMembers(a).members[0]!.engagement).toBe('engaged')
    })

    test('a peer becomes idle after the engagement window with no activity', () => {
      const tight = new Broker({ room: { now, engagementWindowMs: 1_000 } })
      const a = tight.connect(() => {})
      const b = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.join(b, { roomId: 'main', name: 'B', description: '' })
      clock += 1_500
      tight.listMembers(a)  // a still active by calling list_members
      const members = tight.listMembers(a).members
      const a_state = members.find(m => m.name === 'A')!.engagement
      const b_state = members.find(m => m.name === 'B')!.engagement
      expect(a_state).toBe('engaged')
      expect(b_state).toBe('idle')
    })

    test('speak counts as activity for the speaker', () => {
      const tight = new Broker({ room: { now, engagementWindowMs: 1_000 } })
      const a = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      clock += 1_500
      tight.speak(a, { text: 'hi' })
      expect(tight.listMembers(a).members[0]!.engagement).toBe('engaged')
    })

    test('read_history counts as activity', () => {
      const tight = new Broker({ room: { now, engagementWindowMs: 1_000 } })
      const a = tight.connect(() => {})
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      clock += 1_500
      tight.readHistory(a, {})
      expect(tight.listMembers(a).members[0]!.engagement).toBe('engaged')
    })
  })

  describe('multi-room isolation', () => {
    function rec(): { received: RoomMessage[]; push: PushFn } {
      const received: RoomMessage[] = []
      return { received, push: m => { received.push(m) } }
    }

    test('members in distinct rooms cannot see each other via list_members', () => {
      const aRec = rec(), bRec = rec()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      broker.join(a, { roomId: 'auth', name: 'A', description: '' })
      broker.join(b, { roomId: 'mod', name: 'B', description: '' })
      expect(broker.listMembers(a).members.map(m => m.name)).toEqual(['A'])
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('a @mention does not cross rooms even with matching name', () => {
      const aRec = rec(), bRec = rec(), cRec = rec()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      const c = broker.connect(cRec.push)
      broker.join(a, { roomId: 'auth', name: 'A', description: '' })
      broker.join(b, { roomId: 'auth', name: 'B', description: '' })
      broker.join(c, { roomId: 'mod', name: 'B', description: '' })  // same name, different room
      broker.speak(a, { text: '@B come here' })
      expect(bRec.received).toHaveLength(1)
      expect(cRec.received).toHaveLength(0)
    })

    test('@everyone is scoped to the speaker’s room', () => {
      const aRec = rec(), bRec = rec(), cRec = rec()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      const c = broker.connect(cRec.push)
      broker.join(a, { roomId: 'r1', name: 'A', description: '' })
      broker.join(b, { roomId: 'r1', name: 'B', description: '' })
      broker.join(c, { roomId: 'r2', name: 'C', description: '' })
      broker.speak(a, { text: '@everyone hi' })
      expect(bRec.received).toHaveLength(1)
      expect(cRec.received).toHaveLength(0)
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
      expect(r.message.roomId).toBe('project-x')
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
      const authed = new Broker({ room: { now }, authToken: 'secret' })
      const h = authed.connect(() => {})
      expect(() => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'secret' })).not.toThrow()
    })

    test('rejects a join with a wrong token (BAD_AUTH)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret' })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'wrong' }),
        'BAD_AUTH',
      )
    })

    test('rejects a join that omits the token (BAD_AUTH)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret' })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '' }),
        'BAD_AUTH',
      )
    })

    test('a broker without a configured token accepts joins regardless of the token field', () => {
      const open = new Broker({ room: { now } })
      const h1 = open.connect(() => {})
      const h2 = open.connect(() => {})
      expect(() => open.join(h1, { roomId: 'main', name: 'A', description: '', authToken: 'any' })).not.toThrow()
      expect(() => open.join(h2, { roomId: 'main', name: 'B', description: '' })).not.toThrow()
    })

    test('BAD_AUTH does not bind the connection (it can retry with the right token)', () => {
      const authed = new Broker({ room: { now }, authToken: 'secret' })
      const h = authed.connect(() => {})
      expectChatError(
        () => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'wrong' }),
        'BAD_AUTH',
      )
      // Should be able to retry with the right token
      expect(() => authed.join(h, { roomId: 'main', name: 'A', description: '', authToken: 'secret' })).not.toThrow()
    })
  })

  describe('speak and push routing', () => {
    test('pushes the message to a mentioned member', () => {
      const aRec = recorder()
      const bRec = recorder()
      const a = broker.connect(aRec.push)
      const b = broker.connect(bRec.push)
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      broker.speak(a, { text: '@B come over' })
      expect(bRec.received).toHaveLength(1)
      expect(bRec.received[0]!.from).toBe('A')
      expect(bRec.received[0]!.text).toBe('@B come over')
      expect(aRec.received).toHaveLength(0)
    })

    test('@everyone pushes to all members except the speaker', () => {
      const recs = [recorder(), recorder(), recorder()]
      const handles = recs.map(r => broker.connect(r.push))
      broker.join(handles[0]!, { roomId: 'main', name: 'A', description: '' })
      broker.join(handles[1]!, { roomId: 'main', name: 'B', description: '' })
      broker.join(handles[2]!, { roomId: 'main', name: 'C', description: '' })
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
      tight.join(a, { roomId: 'main', name: 'A', description: '' })
      tight.join(b, { roomId: 'main', name: 'B', description: '' })
      tight.speak(a, { text: '@B one' })
      const r2 = tight.speak(a, { text: '@B two' })
      expect(r2.throttled).toEqual(['B'])
      // Only the first message reached B; the throttled one did not.
      expect(bRec.received).toHaveLength(1)
    })

    test('does not push to unknown @-targets', () => {
      const aRec = recorder()
      const a = broker.connect(aRec.push)
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
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
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
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
      broker.join(a, { roomId: 'main', name: 'A', description: '' })
      broker.join(b, { roomId: 'main', name: 'B', description: '' })
      broker.disconnect(a)
      expect(broker.listMembers(b).members.map(m => m.name)).toEqual(['B'])
    })

    test('after leave, the same connection can join under a new name', () => {
      const h = broker.connect(() => {})
      broker.join(h, { roomId: 'main', name: 'Alice', description: 'first' })
      broker.leave(h)
      const r = broker.join(h, { roomId: 'main', name: 'Bob', description: 'second' })
      expect(r.joinedAt).toBe(clock)
    })

    test('disconnect frees the member name for someone else', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'Alice', description: '' })
      broker.disconnect(a)
      expect(() => broker.join(b, { roomId: 'main', name: 'Alice', description: '' })).not.toThrow()
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

    test('listMembers reflects the current roster', () => {
      const a = broker.connect(() => {})
      const b = broker.connect(() => {})
      broker.join(a, { roomId: 'main', name: 'A', description: 'one' })
      broker.join(b, { roomId: 'main', name: 'B', description: 'two' })
      const names = broker.listMembers(a).members.map(m => m.name)
      expect(new Set(names)).toEqual(new Set(['A', 'B']))
    })
  })
})
