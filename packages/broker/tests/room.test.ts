import { describe, test, expect, beforeEach } from 'bun:test'
import { Room } from '../src/room.ts'
import { ChatError, type ChatErrorCode } from '../src/errors.ts'

function expectChatError(fn: () => unknown, code: ChatErrorCode): void {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(ChatError)
  expect((thrown as ChatError).code).toBe(code)
}

describe('Room', () => {
  let clock = 0
  const now = () => clock
  let room: Room

  beforeEach(() => {
    clock = 1_700_000_000_000
    room = new Room({ now })
  })

  describe('join', () => {
    test('accepts a valid name and records the join timestamp', () => {
      const m = room.join('Alice', 'engineer')
      expect(m.name).toBe('Alice')
      expect(m.description).toBe('engineer')
      expect(m.joinedAt).toBe(clock)
      expect(m.engagement).toBe('engaged')
    })

    test('rejects duplicate names', () => {
      room.join('Alice', 'one')
      expectChatError(() => room.join('Alice', 'two'), 'DUPLICATE_NAME')
    })

    test('rejects the reserved name `everyone`', () => {
      expectChatError(() => room.join('everyone', 'x'), 'RESERVED_NAME')
    })

    test('rejects names that do not match the pattern', () => {
      expectChatError(() => room.join('123Bad', 'x'), 'INVALID_NAME')
      expectChatError(() => room.join('with space', 'x'), 'INVALID_NAME')
      expectChatError(() => room.join('', 'x'), 'INVALID_NAME')
    })

    test('rejects descriptions longer than 280 characters', () => {
      expectChatError(() => room.join('A', 'x'.repeat(281)), 'INVALID_DESCRIPTION')
    })

    test('accepts a description of exactly 280 characters', () => {
      expect(() => room.join('A', 'x'.repeat(280))).not.toThrow()
    })
  })

  describe('leave', () => {
    test('is idempotent for non-members', () => {
      expect(() => room.leave('Ghost')).not.toThrow()
    })

    test('removes the member', () => {
      room.join('Alice', 'x')
      room.leave('Alice')
      expect(room.members()).toHaveLength(0)
    })

    test('a member can re-join after leaving with a new description', () => {
      room.join('Alice', 'first')
      room.leave('Alice')
      const m = room.join('Alice', 'second')
      expect(m.description).toBe('second')
    })
  })

  describe('members', () => {
    test('returns currently-joined members', () => {
      room.join('A', 'one')
      room.join('B', 'two')
      const names = room.members().map(m => m.name)
      expect(new Set(names)).toEqual(new Set(['A', 'B']))
    })

    test('a member who left is no longer listed', () => {
      room.join('A', '')
      room.join('B', '')
      room.leave('A')
      expect(room.members().map(m => m.name)).toEqual(['B'])
    })
  })

  describe('speak', () => {
    test('throws NOT_MEMBER if the speaker is not in the room', () => {
      expectChatError(() => room.speak('Ghost', 'hi'), 'NOT_MEMBER')
    })

    test('appends to history with monotonic ids and ok=true', () => {
      room.join('A', '')
      room.join('B', '')
      const r1 = room.speak('A', 'one')
      const r2 = room.speak('B', 'two')
      expect(r1.ok).toBe(true)
      expect(r1.message.id).toBe(1)
      expect(r2.message.id).toBe(2)
      expect(room.history()).toHaveLength(2)
    })

    test('stamps the room id onto every emitted message', () => {
      const named = new Room({ id: 'project-x', now })
      named.join('A', '')
      const r = named.speak('A', 'hi')
      expect(r.message.roomId).toBe('project-x')
    })

    test('@target appears in delivered set', () => {
      room.join('A', '')
      room.join('B', '')
      room.join('C', '')
      const r = room.speak('A', '@B come over')
      expect(r.delivered).toEqual(['B'])
    })

    test('multiple mentions deliver to each named member', () => {
      room.join('A', '')
      room.join('B', '')
      room.join('C', '')
      const r = room.speak('A', '@B and @C please')
      expect(new Set(r.delivered)).toEqual(new Set(['B', 'C']))
    })

    test('unknown mentions are parsed but not delivered', () => {
      room.join('A', '')
      const r = room.speak('A', '@Ghost where are you')
      expect(r.message.mentions).toEqual(['Ghost'])
      expect(r.delivered).toEqual([])
    })

    test('@everyone delivers to all members except the speaker', () => {
      room.join('A', '')
      room.join('B', '')
      room.join('C', '')
      const r = room.speak('A', '@everyone heads up')
      expect(new Set(r.delivered)).toEqual(new Set(['B', 'C']))
    })

    test('never delivers to the speaker even when they self-@', () => {
      room.join('A', '')
      room.join('B', '')
      const r = room.speak('A', '@A note to self @B fyi')
      expect(r.delivered).toEqual(['B'])
    })

    test('throws ROOM_FULL when the history hard cap is reached', () => {
      const small = new Room({ now, hardCap: 2 })
      small.join('A', '')
      small.speak('A', 'one')
      small.speak('A', 'two')
      expectChatError(() => small.speak('A', 'three'), 'ROOM_FULL')
    })
  })

  describe('engagement', () => {
    test('a freshly-joined member is engaged', () => {
      const small = new Room({ now, engagementWindowMs: 1000 })
      small.join('A', '')
      expect(small.members()[0]!.engagement).toBe('engaged')
    })

    test('a member becomes idle once the engagement window passes', () => {
      const small = new Room({ now, engagementWindowMs: 1000 })
      small.join('A', '')
      clock += 1001
      expect(small.members()[0]!.engagement).toBe('idle')
    })

    test('recordActivity resets the engagement clock', () => {
      const small = new Room({ now, engagementWindowMs: 1000 })
      small.join('A', '')
      clock += 999
      small.recordActivity('A')
      clock += 999
      expect(small.members()[0]!.engagement).toBe('engaged')
    })

    test('recordActivity for a non-member is a no-op', () => {
      const small = new Room({ now })
      expect(() => small.recordActivity('Ghost')).not.toThrow()
    })

    test('leaving and re-joining resets engagement to engaged', () => {
      const small = new Room({ now, engagementWindowMs: 1000 })
      small.join('A', '')
      clock += 2000
      small.leave('A')
      small.join('A', 'new')
      expect(small.members()[0]!.engagement).toBe('engaged')
    })
  })

  describe('history', () => {
    beforeEach(() => {
      room.join('A', '')
      for (let i = 1; i <= 5; i++) room.speak('A', `msg ${i}`)
    })

    test('returns all messages by default', () => {
      expect(room.history()).toHaveLength(5)
    })

    test('sinceId returns only messages with strictly greater ids', () => {
      const out = room.history({ sinceId: 3 })
      expect(out.map(m => m.id)).toEqual([4, 5])
    })

    test('sinceId past the end returns empty', () => {
      expect(room.history({ sinceId: 99 })).toEqual([])
    })

    test('limit truncates from the start of the filtered slice', () => {
      const out = room.history({ limit: 2 })
      expect(out.map(m => m.id)).toEqual([1, 2])
    })

    test('combines sinceId and limit', () => {
      const out = room.history({ sinceId: 1, limit: 2 })
      expect(out.map(m => m.id)).toEqual([2, 3])
    })
  })
})
