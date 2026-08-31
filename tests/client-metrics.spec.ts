import { describe, expect, it } from 'vitest'

import {
  describeError,
  fill,
  formatDuration,
  latestByEntry,
  originFilterCounts,
  quantile,
  rankableSelfDuration,
  slowestBySelfTime,
  snapshotFileName,
  timedPluginCounts,
  untimedReasonKey,
  userPluginVerdict,
} from '../src/client/ProfilerSettingsTab.js'
import {
  EXCLUDED_MEASUREMENTS,
  PARTIAL_COVERAGE,
  type ActivationSample,
  type DiagnosticCode,
  type ProfilerSnapshot,
} from '../src/core/types.js'

interface SampleExtras {
  readonly isGroup?: boolean
  readonly outcome?: ActivationSample['outcome']
  readonly generation?: number
}

function sampleWith(
  entryId: string,
  selfDurationMs: number | null,
  extras: SampleExtras = {},
): ActivationSample {
  const generation = extras.generation ?? 1
  return {
    schemaVersion: 4,
    observation: 'lifecycle',
    runId: entryId + ':' + generation,
    entryId,
    moduleName: 'dsh-' + entryId,
    origin: 'user',
    generation,
    isGroup: extras.isGroup ?? false,
    dependencies: [],
    selfTime: {
      durationMs: selfDurationMs,
      basis: selfDurationMs === null ? 'unobserved' : 'exact',
      childEntryCount: 0,
    },
    firstSeenOffsetMs: 0,
    lastSeenOffsetMs: 1,
    lastState: 'active',
    outcome: extras.outcome ?? 'active',
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
      sampleWith('bundle', 500, { isGroup: true }),
      sampleWith('fast', 40),
      sampleWith('slow', 120),
    ]

    expect(rankableSelfDuration(samples[0]!)).toBeNull()
    expect(slowestBySelfTime(samples)?.entryId).toBe('slow')
  })

  it('没有可排名的条目时不给结论', () => {
    expect(slowestBySelfTime([sampleWith('bundle', 500, { isGroup: true })])).toBeUndefined()
    expect(slowestBySelfTime([sampleWith('unmeasured', null)])).toBeUndefined()
    expect(slowestBySelfTime([])).toBeUndefined()
  })
})

describe('计数单位要一致', () => {
  it('按插件数统计,不按记录数——旁边的筛选计数用的就是插件数', () => {
    const samples = [
      sampleWith('a', 4, { generation: 1 }),
      sampleWith('a', 6, { generation: 2 }),
      sampleWith('b', null),
      sampleWith('c', 12),
    ]

    // 4 条记录,但只有 3 个插件;其中 2 个测到了耗时。
    expect(timedPluginCounts(samples)).toEqual({ timed: 2, total: 3 })
  })
})

describe('没有耗时的两种成因要分开解释', () => {
  it('名单上补进来的和错过起点的,理由不一样', () => {
    expect(untimedReasonKey(sampleWith('a', null))).toBe('untimedCensored')
    expect(untimedReasonKey({ ...sampleWith('b', null), observation: 'enumerated' }))
      .toBe('untimedRoster')
  })
})

describe('文案占位符', () => {
  it('填上已知的占位符,原样留下不认识的', () => {
    expect(fill('你装的 {count} 个插件都正常，一共花了 {total}。', { count: 3, total: '12 ms' }))
      .toBe('你装的 3 个插件都正常，一共花了 12 ms。')
    expect(fill('{name} 启动失败了。', {})).toBe('{name} 启动失败了。')
  })
})

describe('每个插件只看最近一次激活', () => {
  it('保留代次最高的那条', () => {
    const samples = [
      sampleWith('a', 10, { generation: 1, outcome: 'failed' }),
      sampleWith('a', 20, { generation: 2 }),
      sampleWith('b', 30),
    ]

    expect(latestByEntry(samples).map(sample => [sample.entryId, sample.generation]))
      .toEqual([['a', 2], ['b', 1]])
  })
})

describe('给用户看的那句结论', () => {
  it('一个插件都没有时不假装有', () => {
    expect(userPluginVerdict([])).toEqual({
      tone: 'none',
      pluginCount: 0,
      failedCount: 0,
      unfinishedCount: 0,
      timedCount: 0,
      totalSelfMs: null,
    })
  })

  it('一个都没测到耗时时,单独记下来——「都正常」不能听着像有数据', () => {
    const verdict = userPluginVerdict([sampleWith('a', null), sampleWith('b', null)])

    expect(verdict.tone).toBe('ok')
    expect(verdict.pluginCount).toBe(2)
    expect(verdict.timedCount).toBe(0)
  })

  it('全部正常且都测到耗时,就给出总和', () => {
    const verdict = userPluginVerdict([sampleWith('a', 4), sampleWith('b', 8)])

    expect(verdict.tone).toBe('ok')
    expect(verdict.pluginCount).toBe(2)
    expect(verdict.totalSelfMs).toBe(12)
  })

  it('有插件没测到耗时就不给总和,免得说小了', () => {
    const verdict = userPluginVerdict([sampleWith('a', 4), sampleWith('b', null)])

    expect(verdict.tone).toBe('ok')
    expect(verdict.pluginCount).toBe(2)
    expect(verdict.totalSelfMs).toBeNull()
  })

  it('只有一个出问题时给名字,多个时给数量', () => {
    const one = userPluginVerdict([
      sampleWith('a', 4),
      sampleWith('b', 8, { outcome: 'failed' }),
    ])
    expect(one.tone).toBe('failed')
    expect(one.onlyName).toBe('dsh-b')

    const many = userPluginVerdict([
      sampleWith('a', 4, { outcome: 'failed' }),
      sampleWith('b', 8, { outcome: 'failed' }),
    ])
    expect(many.tone).toBe('failed')
    expect(many.failedCount).toBe(2)
    expect(many.onlyName).toBeUndefined()
  })

  it('失败比没跑完更要紧,先说失败', () => {
    const verdict = userPluginVerdict([
      sampleWith('a', 4, { outcome: 'in-progress' }),
      sampleWith('b', 8, { outcome: 'failed' }),
    ])

    expect(verdict.tone).toBe('failed')
    expect(verdict.unfinishedCount).toBe(1)
  })

  it('先失败后重载成功的插件算正常,不再报警', () => {
    const verdict = userPluginVerdict([
      sampleWith('a', 4, { generation: 1, outcome: 'failed' }),
      sampleWith('a', 6, { generation: 2 }),
    ])

    expect(verdict.tone).toBe('ok')
    expect(verdict.pluginCount).toBe(1)
    expect(verdict.totalSelfMs).toBe(6)
  })
})

describe('归属筛选计数', () => {
  function snapshotWith(counts: ProfilerSnapshot['provenance']['counts']): ProfilerSnapshot {
    return {
      schemaVersion: 4,
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
