import { describe, expect, it } from 'vitest'

import {
  describeError,
  formatDuration,
  originFilterCounts,
  quantile,
} from '../src/client/ProfilerSettingsTab.js'
import {
  EXCLUDED_MEASUREMENTS,
  type DiagnosticCode,
  type ProfilerSnapshot,
} from '../src/core/types.js'

const EMPTY_DIAGNOSTIC_COUNTS: Record<DiagnosticCode, number> = {
  'clock-regression': 0,
  'duplicate-transition': 0,
  'invalid-clock': 0,
  'missing-entry-id': 0,
  'reporter-error': 0,
  'transition-gap': 0,
  'unknown-state': 0,
}

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

describe('归属筛选计数', () => {
  function snapshotWith(counts: ProfilerSnapshot['provenance']['counts']): ProfilerSnapshot {
    return {
      schemaVersion: 2,
      provenance: { resolved: true, bundles: [], counts },
      collector: {
        mode: 'host-runtime',
        coverage: 'partial',
        attachedAtMonotonicMs: 0,
        target: { dshVersion: '0.1.1-rc.2', dshCommit: 'b150a551b8' },
        excluded: EXCLUDED_MEASUREMENTS,
      },
      samples: [],
      diagnostics: { total: 0, byCode: EMPTY_DIAGNOSTIC_COUNTS, entries: [] },
    }
  }

  it('把"全部"算成三类之和', () => {
    expect(originFilterCounts(snapshotWith({ builtin: 135, user: 1, unknown: 0 })))
      .toEqual({ all: 136, builtin: 135, user: 1, unknown: 0 })
  })

  it('全部未判定时"全部"仍等于总数', () => {
    expect(originFilterCounts(snapshotWith({ builtin: 0, user: 0, unknown: 7 })))
      .toEqual({ all: 7, builtin: 0, user: 0, unknown: 7 })
  })
})
