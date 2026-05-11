import { describe, test, expect, beforeEach } from 'bun:test'
import { StormGuard } from '../src/storm-guard.ts'

describe('StormGuard', () => {
  let clock = 0
  const now = () => clock
  let guard: StormGuard

  beforeEach(() => {
    clock = 1_700_000_000_000
    guard = new StormGuard({
      now,
      perMemberWakeBudget: 3,
      perMemberWindowMs: 60_000,
      everyoneIntervalMs: 60_000,
    })
  })

  describe('tryDeliverTo', () => {
    test('allows up to the budget then denies', () => {
      for (let i = 0; i < 3; i++) expect(guard.tryDeliverTo('Bob')).toBe(true)
      expect(guard.tryDeliverTo('Bob')).toBe(false)
    })

    test('recovers as the window slides past the oldest delivery', () => {
      for (let i = 0; i < 3; i++) guard.tryDeliverTo('Bob')
      expect(guard.tryDeliverTo('Bob')).toBe(false)
      clock += 60_001
      expect(guard.tryDeliverTo('Bob')).toBe(true)
    })

    test('per-member budgets are independent', () => {
      for (let i = 0; i < 3; i++) guard.tryDeliverTo('Bob')
      expect(guard.tryDeliverTo('Bob')).toBe(false)
      expect(guard.tryDeliverTo('Alice')).toBe(true)
    })

    test('a denied call does not consume budget', () => {
      for (let i = 0; i < 3; i++) guard.tryDeliverTo('Bob')
      expect(guard.tryDeliverTo('Bob')).toBe(false)
      // sliding the window past one entry should yield exactly one new slot
      clock += 60_001
      expect(guard.tryDeliverTo('Bob')).toBe(true)
      expect(guard.tryDeliverTo('Bob')).toBe(true)
      expect(guard.tryDeliverTo('Bob')).toBe(true)
      expect(guard.tryDeliverTo('Bob')).toBe(false)
    })
  })

  describe('forget', () => {
    test('clears a member’s recorded wakes', () => {
      for (let i = 0; i < 3; i++) guard.tryDeliverTo('Bob')
      expect(guard.tryDeliverTo('Bob')).toBe(false)
      guard.forget('Bob')
      expect(guard.tryDeliverTo('Bob')).toBe(true)
    })
  })

  describe('tryTriggerEveryone', () => {
    test('honours the cooldown', () => {
      expect(guard.tryTriggerEveryone()).toBe(true)
      expect(guard.tryTriggerEveryone()).toBe(false)
      clock += 60_001
      expect(guard.tryTriggerEveryone()).toBe(true)
    })

    test('a denied call does not advance the cooldown', () => {
      expect(guard.tryTriggerEveryone()).toBe(true)
      clock += 30_000
      expect(guard.tryTriggerEveryone()).toBe(false)
      clock += 30_001
      expect(guard.tryTriggerEveryone()).toBe(true)
    })
  })
})
