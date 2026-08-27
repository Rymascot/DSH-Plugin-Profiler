import { describe, expect, it } from 'vitest'

import { formatDuration, quantile } from '../src/client/ProfilerSettingsTab.js'

describe('client performance metrics', () => {
  it('calculates interpolated median and p95 without mutating the input', () => {
    const values = [40, 10, 20, 30]

    expect(quantile(values, 0.5)).toBe(25)
    expect(quantile(values, 0.95)).toBeCloseTo(38.5)
    expect(values).toEqual([40, 10, 20, 30])
  })

  it('formats missing, short, and longer durations', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(2.25)).toBe('2.3 ms')
    expect(formatDuration(18.8)).toBe('19 ms')
  })
})
