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

  test('allows deliveries up to the budget', () => {
    for (let i = 0; i < 3; i++) {
      expect(guard.canDeliverTo('Bob')).toBe(true)
      guard.recordDelivery('Bob')
    }
  })

  test('blocks deliveries that exceed the budget within the window', () => {
    for (let i = 0; i < 3; i++) guard.recordDelivery('Bob')
    expect(guard.canDeliverTo('Bob')).toBe(false)
  })

  test('budget recovers as the window slides past the oldest delivery', () => {
    for (let i = 0; i < 3; i++) guard.recordDelivery('Bob')
    expect(guard.canDeliverTo('Bob')).toBe(false)
    clock += 60_001
    expect(guard.canDeliverTo('Bob')).toBe(true)
  })

  test('per-member budgets are independent', () => {
    for (let i = 0; i < 3; i++) guard.recordDelivery('Bob')
    expect(guard.canDeliverTo('Bob')).toBe(false)
    expect(guard.canDeliverTo('Alice')).toBe(true)
  })

  test('forget clears a member’s recorded wakes', () => {
    for (let i = 0; i < 3; i++) guard.recordDelivery('Bob')
    expect(guard.canDeliverTo('Bob')).toBe(false)
    guard.forget('Bob')
    expect(guard.canDeliverTo('Bob')).toBe(true)
  })

  test('@everyone trigger honours the cooldown', () => {
    expect(guard.canTriggerEveryone()).toBe(true)
    guard.recordEveryoneTrigger()
    expect(guard.canTriggerEveryone()).toBe(false)
    clock += 60_001
    expect(guard.canTriggerEveryone()).toBe(true)
  })
})
