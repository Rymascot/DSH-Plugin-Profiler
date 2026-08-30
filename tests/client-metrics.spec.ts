import { describe, expect, it } from 'vitest'

import {
  describeError,
  formatDuration,
  originFilterCounts,
  quantile,
  rankableSelfDuration,
  slowestBySelfTime,
  snapshotFileName,
} from '../src/client/ProfilerSettingsTab.js'
import {
  EXCLUDED_MEASUREMENTS,
  PARTIAL_COVERAGE,
  type ActivationSample,
  type DiagnosticCode,
  type ProfilerSnapshot,
} from '../src/core/types.js'

function sampleWith(
  entryId: string,
  selfDurationMs: number | null,
  isGroup = false,
): ActivationSample {
  return {
    schemaVersion: 3,
    runId: entryId + ':1',
    entryId,
    moduleName: 'dsh-' + entryId,
    origin: 'user',
    generation: 1,
    isGroup,
    dependencies: [],
    selfTime: {
      durationMs: selfDurationMs,
      basis: selfDurationMs === null ? 'unobserved' : 'exact',
      childEntryCount: 0,
    },
    firstSeenOffsetMs: 0,
    lastSeenOffsetMs: 1,
    lastState: 'active',
    outcome: 'active',
    segments: {
      dependencyWait: {
        startOffsetMs: null,
        endOffsetMs: null,
        durationMs: null,
        completeness: 'unobserved',
      },
      activation: {
        startOffsetMs: 0,
        endOffsetMs: selfDurationMs,
        durationMs: selfDurationMs,
        completeness: selfDurationMs === null ? 'left-censored' : 'complete',
      },
    },
    coverage: PARTIAL_COVERAGE,
  }
}

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

  it('导出文件名带上时间,方便把两次启动放在一起比较', () => {
    expect(snapshotFileName(new Date('2026-08-30T12:34:56.789Z')))
      .toBe('dsh-profiler-2026-08-30T12-34-56-789Z.json')
  })
})

describe('最慢插件', () => {
  it('不让容器条目冒充最慢的插件', () => {
    const samples = [
      sampleWith('bundle', 500, true),
      sampleWith('fast', 40),
      sampleWith('slow', 120),
    ]

    expect(rankableSelfDuration(samples[0]!)).toBeNull()
    expect(slowestBySelfTime(samples)?.entryId).toBe('slow')
  })

  it('没有可排名的条目时不给结论', () => {
    expect(slowestBySelfTime([sampleWith('bundle', 500, true)])).toBeUndefined()
    expect(slowestBySelfTime([sampleWith('unmeasured', null)])).toBeUndefined()
    expect(slowestBySelfTime([])).toBeUndefined()
  })
})

describe('归属筛选计数', () => {
  function snapshotWith(counts: ProfilerSnapshot['provenance']['counts']): ProfilerSnapshot {
    return {
      schemaVersion: 3,
      provenance: { resolved: true, bundles: [], counts },
      collector: {
        mode: 'host-runtime',
        coverage: 'partial',
        attachedAtMonotonicMs: 0,
        observedUntilOffsetMs: 0,
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
