import { describe, test, expect, beforeEach } from 'bun:test'
import { SenderRateLimiter } from '../src/rate-limiter.ts'

describe('SenderRateLimiter', () => {
  let clock = 0
  const now = () => clock
  let limiter: SenderRateLimiter

  beforeEach(() => {
    clock = 1_700_000_000_000
    limiter = new SenderRateLimiter({ now, maxPerWindow: 3, windowMs: 1000 })
  })

  test('allows up to the limit', () => {
    expect(limiter.tryRecord('A')).toBe(true)
    expect(limiter.tryRecord('A')).toBe(true)
    expect(limiter.tryRecord('A')).toBe(true)
  })

  test('rejects beyond the limit within the window', () => {
    for (let i = 0; i < 3; i++) limiter.tryRecord('A')
    expect(limiter.tryRecord('A')).toBe(false)
  })

  test('a rejected call does not consume a slot', () => {
    for (let i = 0; i < 3; i++) limiter.tryRecord('A')
    expect(limiter.tryRecord('A')).toBe(false)
    expect(limiter.tryRecord('A')).toBe(false)
    // After the window slides past the oldest entry, exactly one slot frees up.
    clock += 1001
    expect(limiter.tryRecord('A')).toBe(true)
    expect(limiter.tryRecord('A')).toBe(true)
    expect(limiter.tryRecord('A')).toBe(true)
    expect(limiter.tryRecord('A')).toBe(false)
  })

  test('per-sender state is independent', () => {
    for (let i = 0; i < 3; i++) limiter.tryRecord('A')
    expect(limiter.tryRecord('A')).toBe(false)
    expect(limiter.tryRecord('B')).toBe(true)
  })

  test('forget clears a sender', () => {
    for (let i = 0; i < 3; i++) limiter.tryRecord('A')
    expect(limiter.tryRecord('A')).toBe(false)
    limiter.forget('A')
    expect(limiter.tryRecord('A')).toBe(true)
  })

  test('window slides as time passes', () => {
    for (let i = 0; i < 3; i++) limiter.tryRecord('A')
    clock += 1001
    expect(limiter.tryRecord('A')).toBe(true)
  })
})
