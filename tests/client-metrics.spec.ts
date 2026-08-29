import { describe, expect, it } from 'vitest'

import { describeError, formatDuration, quantile } from '../src/client/ProfilerSettingsTab.js'

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

  it('保留远程调用的真实错误信息', () => {
    expect(describeError(new Error('service-unavailable: service missing')))
      .toBe('service-unavailable: service missing')
    expect(describeError('连接已断开')).toBe('连接已断开')
  })
})
