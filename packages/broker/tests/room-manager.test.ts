import { describe, test, expect, beforeEach } from 'bun:test'
import { ChatError, type ChatErrorCode } from '../src/errors.ts'
import { RoomManager } from '../src/room-manager.ts'

function expectChatError(fn: () => unknown, code: ChatErrorCode): void {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(ChatError)
  expect((thrown as ChatError).code).toBe(code)
}

describe('RoomManager', () => {
  let clock = 0
  const now = () => clock
  let manager: RoomManager

  beforeEach(() => {
    clock = 1_700_000_000_000
    manager = new RoomManager({ now, historyTtlMs: 60_000 })
  })

  describe('getOrCreate', () => {
    test('creates a new room on first call', () => {
      const r = manager.getOrCreate('alpha')
      expect(r.id).toBe('alpha')
      expect(manager.has('alpha')).toBe(true)
    })

    test('returns the same room instance on repeated calls', () => {
      const r1 = manager.getOrCreate('alpha')
      const r2 = manager.getOrCreate('alpha')
      expect(r1).toBe(r2)
    })

    test('rejects an invalid room id', () => {
      expectChatError(() => manager.getOrCreate('1bad'), 'INVALID_ROOM_ID')
      expectChatError(() => manager.getOrCreate('has space'), 'INVALID_ROOM_ID')
      expectChatError(() => manager.getOrCreate(''), 'INVALID_ROOM_ID')
    })

    test('creates distinct rooms for distinct ids', () => {
      const a = manager.getOrCreate('a')
      const b = manager.getOrCreate('b')
      expect(a).not.toBe(b)
      expect(manager.size()).toBe(2)
    })
  })

  describe('get', () => {
    test('returns undefined when the room does not exist', () => {
      expect(manager.get('missing')).toBeUndefined()
    })

    test('returns the room once created', () => {
      const r = manager.getOrCreate('alpha')
      expect(manager.get('alpha')).toBe(r)
    })
  })

  describe('gc', () => {
    test('keeps rooms while they have members', () => {
      const r = manager.getOrCreate('alpha')
      r.join('A', '')
      manager.recordMembershipChange('alpha')
      clock += 999_999  // way past TTL
      expect(manager.gc()).toEqual([])
      expect(manager.has('alpha')).toBe(true)
    })

    test('removes an empty room after the TTL elapses', () => {
      const r = manager.getOrCreate('alpha')
      r.join('A', '')
      manager.recordMembershipChange('alpha')
      r.leave('A')
      manager.recordMembershipChange('alpha')
      clock += 60_001
      expect(manager.gc()).toEqual(['alpha'])
      expect(manager.has('alpha')).toBe(false)
    })

    test('does not remove an empty room before the TTL', () => {
      const r = manager.getOrCreate('alpha')
      r.join('A', '')
      manager.recordMembershipChange('alpha')
      r.leave('A')
      manager.recordMembershipChange('alpha')
      clock += 1_000  // far less than 60_000
      expect(manager.gc()).toEqual([])
      expect(manager.has('alpha')).toBe(true)
    })

    test('a re-join resets the empty timer', () => {
      const r = manager.getOrCreate('alpha')
      r.join('A', '')
      manager.recordMembershipChange('alpha')
      r.leave('A')
      manager.recordMembershipChange('alpha')
      clock += 30_000  // halfway to TTL

      r.join('B', '')
      manager.recordMembershipChange('alpha')
      clock += 60_001  // would have expired the original empty window

      expect(manager.gc()).toEqual([])
      expect(manager.has('alpha')).toBe(true)
    })

    test('rooms re-created at the same id start with fresh history', () => {
      const r1 = manager.getOrCreate('alpha')
      r1.join('A', '')
      manager.recordMembershipChange('alpha')
      r1.speak('A', 'first life')
      r1.leave('A')
      manager.recordMembershipChange('alpha')
      clock += 60_001
      manager.gc()

      const r2 = manager.getOrCreate('alpha')
      expect(r2).not.toBe(r1)
      expect(r2.history()).toEqual([])
    })
  })
})
