// Run with: bun test
import { describe, expect, test } from 'bun:test'

import { computeNextRunAt, computeStaleAfterAt, isRunWindowExpired } from './cronMonitorService'

const at = (iso: string): Date => new Date(iso)

describe('computeStaleAfterAt', () => {
  test('deadline is the next occurrence plus the run windows and grace', () => {
    // Hourly cron, 60s start window, 60s ping window, 5 min grace.
    const from = at('2026-08-15T10:00:30.000Z')
    const deadline = computeStaleAfterAt('0 * * * *', 60, 60, from, 300_000)

    expect(computeNextRunAt('0 * * * *', from).toISOString()).toBe('2026-08-15T11:00:00.000Z')
    // 11:00:00 + 60s + 60s + 300s
    expect(deadline.toISOString()).toBe('2026-08-15T11:07:00.000Z')
  })

  test('deadline always lands after the occurrence being scheduled', () => {
    const from = at('2026-08-15T10:00:00.000Z')
    const deadline = computeStaleAfterAt('*/5 * * * *', 0, 0, from, 0)
    expect(deadline.getTime()).toBeGreaterThan(from.getTime())
  })

  test('negative grace cannot pull the deadline before the occurrence', () => {
    const from = at('2026-08-15T10:00:00.000Z')
    const deadline = computeStaleAfterAt('*/5 * * * *', 0, 0, from, -999_999)
    expect(deadline.toISOString()).toBe('2026-08-15T10:05:00.000Z')
  })
})

describe('isRunWindowExpired', () => {
  const triggered = '2026-08-15T10:00:00.000Z'

  test('a run inside its window is not expired', () => {
    expect(isRunWindowExpired(triggered, 60, 60, at('2026-08-15T10:01:00.000Z'), 300_000)).toBe(
      false,
    )
  })

  test('a run past start + ping + grace is expired', () => {
    // 60 + 60 + 300 = 420s -> expires at 10:07:00
    expect(isRunWindowExpired(triggered, 60, 60, at('2026-08-15T10:07:01.000Z'), 300_000)).toBe(
      true,
    )
    expect(isRunWindowExpired(triggered, 60, 60, at('2026-08-15T10:06:59.000Z'), 300_000)).toBe(
      false,
    )
  })

  test('a payload drained from a stuck queue hours later is expired', () => {
    expect(isRunWindowExpired(triggered, 60, 60, at('2026-08-15T14:00:00.000Z'), 300_000)).toBe(
      true,
    )
  })

  test('null windows fall back to 60s each', () => {
    expect(isRunWindowExpired(triggered, null, null, at('2026-08-15T10:02:01.000Z'), 0)).toBe(true)
    expect(isRunWindowExpired(triggered, null, null, at('2026-08-15T10:01:59.000Z'), 0)).toBe(false)
  })

  test('an unparseable timestamp is never treated as expired', () => {
    expect(isRunWindowExpired('not-a-date', 60, 60)).toBe(false)
  })
})
