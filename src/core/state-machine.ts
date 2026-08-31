import { unresolvedOriginIndex, type OriginIndex } from './provenance.js'
import {
  EXCLUDED_MEASUREMENTS,
  PARTIAL_COVERAGE,
  TARGET_DSH,
  type ActivationOutcome,
  type ActivationSample,
  type BlockingAttribution,
  type DependencyLink,
  type DiagnosticCode,
  type LifecycleSignal,
  type LifecycleState,
  type PluginOrigin,
  type LoaderEntryView,
  type ProfilerDiagnostic,
  type ProfilerSnapshot,
  type SegmentTiming,
  type SelfTime,
} from './types.js'

interface MutableRecord {
  readonly runId: string
  readonly entryId: string
  moduleName: string | undefined
  readonly generation: number
  isGroup: boolean
  parentEntryId: string | undefined
  dependencies: readonly DependencyLink[]
  readonly firstSeenOffsetMs: number
  lastSeenOffsetMs: number
  lastState: LifecycleState
  outcome: ActivationOutcome
  failureStage: 'pending' | 'loading' | 'unknown' | undefined
  dependencyWait: SegmentTiming
  activation: SegmentTiming
  completionReported: boolean
}

interface FiberCursor {
  readonly record: MutableRecord
  state: LifecycleState
}

const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
  'clock-regression',
  'duplicate-transition',
  'invalid-clock',
  'missing-entry-id',
  'reporter-error',
  'transition-gap',
  'unknown-state',
]

function unobserved(): SegmentTiming {
  return {
    startOffsetMs: null,
    endOffsetMs: null,
    durationMs: null,
    completeness: 'unobserved',
  }
}

function leftCensored(endOffsetMs: number): SegmentTiming {
  return {
    startOffsetMs: null,
    endOffsetMs,
    durationMs: null,
    completeness: 'left-censored',
  }
}

function rightCensored(startOffsetMs: number): SegmentTiming {
  return {
    startOffsetMs,
    endOffsetMs: null,
    durationMs: null,
    completeness: 'right-censored',
  }
}

function completed(startOffsetMs: number, endOffsetMs: number): SegmentTiming {
  return {
    startOffsetMs,
    endOffsetMs,
    durationMs: Math.max(0, endOffsetMs - startOffsetMs),
    completeness: 'complete',
  }
}

/** 按 entryId 去重统计各归属的插件数;同一插件重载多次只算一个。 */
function countDistinctEntriesByOrigin(
  samples: readonly ActivationSample[],
): Record<PluginOrigin, number> {
  const seen = new Map<string, PluginOrigin>()
  for (const sample of samples) seen.set(sample.entryId, sample.origin)

  const counts: Record<PluginOrigin, number> = { builtin: 0, user: 0, unknown: 0 }
  for (const origin of seen.values()) counts[origin] += 1
  return counts
}

/** 合并后的区间总长度。子条目可以并发,时长不能直接相加。 */
function mergedLength(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0])
  const first = sorted[0]
  if (first === undefined) return 0

  let total = 0
  let start = first[0]
  let end = first[1]
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart > end) {
      total += end - start
      start = nextStart
      end = nextEnd
    } else if (nextEnd > end) {
      end = nextEnd
    }
  }
  return total + (end - start)
}

/**
 * 需要看别的条目才能得出的结论。
 *
 * 不必等到快照才算:子条目先于父条目结束激活,依赖的提供方也先于被阻塞方就绪,
 * 所以一条记录终结时,它要用到的那些记录都已经躺在数组里了。
 */
class DerivationIndex {
  readonly #childrenByParent = new Map<string, MutableRecord[]>()
  readonly #readyOffsetsByEntry = new Map<string, number[]>()

  constructor(records: readonly MutableRecord[]) {
    for (const record of records) {
      const parentEntryId = record.parentEntryId
      if (parentEntryId !== undefined) {
        const siblings = this.#childrenByParent.get(parentEntryId)
        if (siblings === undefined) this.#childrenByParent.set(parentEntryId, [record])
        else siblings.push(record)
      }

      const readyOffsetMs = record.activation.endOffsetMs
      if (record.outcome === 'active' && readyOffsetMs !== null) {
        const offsets = this.#readyOffsetsByEntry.get(record.entryId)
        if (offsets === undefined) this.#readyOffsetsByEntry.set(record.entryId, [readyOffsetMs])
        else offsets.push(readyOffsetMs)
      }
    }
  }

  /** 激活耗时减去子条目占用的部分。容器条目的耗时几乎全部来自子条目。 */
  selfTimeOf(record: MutableRecord): SelfTime {
    const { startOffsetMs, endOffsetMs, durationMs } = record.activation
    const children = this.#childrenByParent.get(record.entryId) ?? []
    if (startOffsetMs === null || endOffsetMs === null || durationMs === null) {
      return { durationMs: null, basis: 'unobserved', childEntryCount: children.length }
    }

    const intervals: (readonly [number, number])[] = []
    let incomplete = false
    for (const child of children) {
      const childStart = child.activation.startOffsetMs
      const childEnd = child.activation.endOffsetMs
      if (childStart === null || childEnd === null) {
        // 落在本次激活窗口之外的子条目(例如后来的重载)与这次自身耗时无关。
        if (child.firstSeenOffsetMs <= endOffsetMs) incomplete = true
        continue
      }
      const start = Math.max(childStart, startOffsetMs)
      const end = Math.min(childEnd, endOffsetMs)
      if (end > start) intervals.push([start, end])
    }

    return {
      durationMs: Math.max(0, durationMs - mergedLength(intervals)),
      basis: incomplete ? 'upper-bound' : 'exact',
      childEntryCount: children.length,
    }
  }

  /** 最后一个就绪的依赖,就是把这个条目从 pending 里放出来的那个。 */
  blockedByOf(record: MutableRecord): BlockingAttribution | undefined {
    const unblockedAtOffsetMs = record.activation.startOffsetMs
    if (unblockedAtOffsetMs === null) return undefined

    let latest: BlockingAttribution | undefined
    for (const link of record.dependencies) {
      const providerEntryId = link.providerEntryId
      if (providerEntryId === undefined || providerEntryId === record.entryId) continue

      const providerReadyOffsetMs = this.#readyBefore(providerEntryId, unblockedAtOffsetMs)
      if (providerReadyOffsetMs === null) continue
      if (latest !== undefined && providerReadyOffsetMs <= latest.providerReadyOffsetMs) continue

      latest = {
        service: link.service,
        entryId: providerEntryId,
        providerReadyOffsetMs,
        skewMs: unblockedAtOffsetMs - providerReadyOffsetMs,
      }
    }
    return latest
  }

  #readyBefore(entryId: string, limitOffsetMs: number): number | null {
    let best: number | null = null
    for (const offset of this.#readyOffsetsByEntry.get(entryId) ?? []) {
      if (offset > limitOffsetMs) continue
      if (best === null || offset > best) best = offset
    }
    return best
  }
}

function outcomeOfState(state: LifecycleState): ActivationOutcome {
  if (state === 'active') return 'active'
  if (state === 'failed') return 'failed'
  if (state === 'unloading' || state === 'disposed') return 'disposed-before-terminal'
  return 'in-progress'
}

/**
 * 只在 Loader 名单上见过、一次状态转换都没观测到的条目。
 *
 * 全部计时字段留空。它确实在跑,状态也是真的,但它跑了多久这个工具不知道——把
 * 这种情况和"测到了"混为一谈,就等于开始编数字。
 */
function enumeratedSample(entry: LoaderEntryView, origin: OriginIndex): ActivationSample {
  const base = {
    schemaVersion: 4,
    runId: `${entry.entryId}:0`,
    entryId: entry.entryId,
    origin: origin.originOf(entry.moduleName),
    observation: 'enumerated',
    generation: 0,
    isGroup: entry.isGroup,
    firstSeenOffsetMs: 0,
    lastSeenOffsetMs: 0,
    lastState: entry.state,
    outcome: outcomeOfState(entry.state),
    dependencies: entry.dependencies.map(link => ({ ...link })),
    selfTime: { durationMs: null, basis: 'unobserved', childEntryCount: 0 },
    segments: {
      dependencyWait: unobserved(),
      activation: unobserved(),
    },
    coverage: PARTIAL_COVERAGE,
  } as const

  return {
    ...base,
    ...(entry.moduleName === undefined ? {} : { moduleName: entry.moduleName }),
    ...(entry.parentEntryId === undefined ? {} : { parentEntryId: entry.parentEntryId }),
  }
}

function serialize(
  record: MutableRecord,
  origin: OriginIndex,
  index: DerivationIndex,
): ActivationSample {
  const blockedBy = index.blockedByOf(record)
  const base = {
    schemaVersion: 4,
    runId: record.runId,
    entryId: record.entryId,
    origin: origin.originOf(record.moduleName),
    observation: 'lifecycle',
    generation: record.generation,
    isGroup: record.isGroup,
    firstSeenOffsetMs: record.firstSeenOffsetMs,
    lastSeenOffsetMs: record.lastSeenOffsetMs,
    lastState: record.lastState,
    outcome: record.outcome,
    dependencies: record.dependencies.map(link => ({ ...link })),
    selfTime: index.selfTimeOf(record),
    segments: {
      dependencyWait: { ...record.dependencyWait },
      activation: { ...record.activation },
    },
    coverage: PARTIAL_COVERAGE,
  } as const

  return {
    ...base,
    ...(record.moduleName === undefined ? {} : { moduleName: record.moduleName }),
    ...(record.parentEntryId === undefined ? {} : { parentEntryId: record.parentEntryId }),
    ...(record.failureStage === undefined ? {} : { failureStage: record.failureStage }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  }
}

export class ActivationStateMachine {
  readonly #origin: OriginIndex
  readonly #records: MutableRecord[] = []
  readonly #byFiber = new WeakMap<object, FiberCursor>()
  readonly #generationByEntry = new Map<string, number>()
  readonly #diagnostics: ProfilerDiagnostic[] = []

  constructor(origin: OriginIndex = unresolvedOriginIndex('未接入 Profile 清单。')) {
    this.#origin = origin
  }

  /**
   * 消费一次状态转换。
   *
   * `reportCompleted` 为 false 时不序列化终结的记录:派生结论要扫一遍全部记录,而
   * 这段代码跑在 Host 启动的热路径上,没人接收就不该算。快照读取时照样会补上。
   */
  consume(
    signal: LifecycleSignal,
    offsetMs: number,
    reportCompleted = true,
  ): ActivationSample | undefined {
    if (signal.entryId === undefined || signal.entryId.trim() === '') {
      this.recordDiagnostic(
        'missing-entry-id',
        offsetMs,
        'Ignored a Fiber without a Loader entry id.',
      )
      return undefined
    }

    if (signal.current === 'unknown') {
      this.recordDiagnostic(
        'unknown-state',
        offsetMs,
        'Ignored an unknown Cordis Fiber state.',
        signal.entryId,
      )
      return undefined
    }

    const existing = this.#byFiber.get(signal.fiberToken)
    const startsNewGeneration = existing === undefined || this.#startsNewGeneration(existing, signal.current)
    const cursor = startsNewGeneration
      ? this.#createCursor(signal, offsetMs)
      : existing

    if (!startsNewGeneration && cursor.state !== signal.previous && signal.previous !== 'unknown') {
      this.recordDiagnostic(
        'transition-gap',
        offsetMs,
        `Observed ${signal.previous} -> ${signal.current}, but the last recorded state was ${cursor.state}.`,
        signal.entryId,
      )
    }

    if (!startsNewGeneration) {
      this.#advance(cursor, signal.current, offsetMs)
    }

    if (cursor.record.moduleName === undefined && signal.moduleName !== undefined) {
      cursor.record.moduleName = signal.moduleName
    }
    if (cursor.record.parentEntryId === undefined && signal.parentEntryId !== undefined) {
      cursor.record.parentEntryId = signal.parentEntryId
    }
    if (signal.isGroup === true) cursor.record.isGroup = true
    this.#absorbDependencies(cursor.record, signal)

    cursor.record.lastSeenOffsetMs = Math.max(cursor.record.lastSeenOffsetMs, offsetMs)
    cursor.record.lastState = signal.current
    cursor.state = signal.current

    if (signal.current === 'disposed') {
      this.#byFiber.delete(signal.fiberToken)
    }

    if (cursor.record.outcome !== 'in-progress' && !cursor.record.completionReported) {
      cursor.record.completionReported = true
      if (reportCompleted) {
        return serialize(cursor.record, this.#origin, new DerivationIndex(this.#records))
      }
    }

    return undefined
  }

  /**
   * 依赖表在离开 pending 的那一刻最完整:Cordis 此时刚把提供方快照写进 `fiber.store`,
   * 卸载时又会清空。所以进入 loading 的采样优先,其余只用来填补空缺。
   */
  #absorbDependencies(record: MutableRecord, signal: LifecycleSignal): void {
    const dependencies = signal.dependencies
    if (dependencies === undefined || dependencies.length === 0) return
    if (record.dependencies.length > 0 && signal.current !== 'loading') return
    record.dependencies = dependencies
  }

  recordDiagnostic(
    code: DiagnosticCode,
    offsetMs: number,
    message: string,
    entryId?: string,
  ): void {
    this.#diagnostics.push({
      code,
      offsetMs,
      message,
      ...(entryId === undefined ? {} : { entryId }),
    })
  }

  /**
   * @param loaderEntries - 当前 Loader 名单。名单上有、但事件流里从没出现过的条目
   * 会被补进来,标成 `enumerated`。少了这一步,先于 Profiler 启动完的插件会彻底消失
   * ——页面于是把"我没看见"讲成了"它不存在"。
   */
  snapshot(
    attachedAtMonotonicMs: number,
    observedUntilOffsetMs: number,
    loaderEntries: readonly LoaderEntryView[] = [],
  ): ProfilerSnapshot {
    const byCode = Object.fromEntries(
      DIAGNOSTIC_CODES.map(code => [code, 0]),
    ) as Record<DiagnosticCode, number>

    for (const diagnostic of this.#diagnostics) {
      byCode[diagnostic.code] += 1
    }

    const index = new DerivationIndex(this.#records)
    const samples = this.#records.map(record => serialize(record, this.#origin, index))

    const observed = new Set(this.#records.map(record => record.entryId))
    for (const entry of loaderEntries) {
      if (observed.has(entry.entryId)) continue
      samples.push(enumeratedSample(entry, this.#origin))
    }

    return {
      schemaVersion: 4,
      provenance: {
        ...this.#origin.source,
        counts: countDistinctEntriesByOrigin(samples),
      },
      collector: {
        mode: 'host-runtime',
        coverage: 'partial',
        attachedAtMonotonicMs,
        observedUntilOffsetMs,
        target: {
          dshVersion: TARGET_DSH.version,
          dshCommit: TARGET_DSH.commit,
        },
        excluded: EXCLUDED_MEASUREMENTS,
      },
      samples,
      diagnostics: {
        total: this.#diagnostics.length,
        byCode,
        entries: this.#diagnostics.map(diagnostic => ({ ...diagnostic })),
      },
    }
  }

  #startsNewGeneration(cursor: FiberCursor, current: LifecycleState): boolean {
    if (current === 'pending') return cursor.state !== 'pending'
    if (current !== 'loading') return false

    return cursor.state === 'active'
      || cursor.state === 'failed'
      || cursor.state === 'unloading'
      || cursor.state === 'disposed'
  }

  #createCursor(signal: LifecycleSignal, offsetMs: number): FiberCursor {
    const entryId = signal.entryId!
    const previousGeneration = this.#generationByEntry.get(entryId) ?? 0
    const generation = previousGeneration + 1
    this.#generationByEntry.set(entryId, generation)

    const record: MutableRecord = {
      runId: `${entryId}:${generation}`,
      entryId,
      moduleName: signal.moduleName,
      generation,
      isGroup: signal.isGroup === true,
      parentEntryId: signal.parentEntryId,
      dependencies: signal.dependencies ?? [],
      firstSeenOffsetMs: offsetMs,
      lastSeenOffsetMs: offsetMs,
      lastState: signal.current,
      outcome: 'in-progress',
      failureStage: undefined,
      dependencyWait: unobserved(),
      activation: unobserved(),
      completionReported: false,
    }

    if (signal.current === 'pending') {
      record.dependencyWait = rightCensored(offsetMs)
    } else if (signal.current === 'loading') {
      record.dependencyWait = leftCensored(offsetMs)
      record.activation = rightCensored(offsetMs)
    } else if (signal.current === 'active' || signal.current === 'failed') {
      record.activation = leftCensored(offsetMs)
      record.outcome = signal.current
      if (signal.current === 'failed') record.failureStage = 'unknown'
    } else if (signal.current === 'unloading' || signal.current === 'disposed') {
      record.outcome = 'disposed-before-terminal'
    }

    const cursor = { record, state: signal.current }
    this.#records.push(record)
    this.#byFiber.set(signal.fiberToken, cursor)
    return cursor
  }

  #advance(cursor: FiberCursor, current: LifecycleState, offsetMs: number): void {
    const record = cursor.record

    if (current === cursor.state) {
      this.recordDiagnostic(
        'duplicate-transition',
        offsetMs,
        `Observed duplicate ${current} state.`,
        record.entryId,
      )
      return
    }

    if (current === 'loading') {
      if (cursor.state === 'pending' && record.dependencyWait.startOffsetMs !== null) {
        record.dependencyWait = completed(record.dependencyWait.startOffsetMs, offsetMs)
      } else {
        record.dependencyWait = leftCensored(offsetMs)
      }
      record.activation = rightCensored(offsetMs)
      return
    }

    if (current === 'active' || current === 'failed') {
      if (cursor.state === 'loading' && record.activation.startOffsetMs !== null) {
        record.activation = completed(record.activation.startOffsetMs, offsetMs)
        if (current === 'failed') record.failureStage = 'loading'
      } else {
        record.activation = cursor.state === 'pending' ? unobserved() : leftCensored(offsetMs)
        if (current === 'failed') {
          record.failureStage = cursor.state === 'pending' ? 'pending' : 'unknown'
        }
        if (cursor.state === 'pending' && record.dependencyWait.startOffsetMs !== null) {
          record.dependencyWait = {
            startOffsetMs: record.dependencyWait.startOffsetMs,
            endOffsetMs: offsetMs,
            durationMs: null,
            completeness: 'right-censored',
          }
        }
      }
      record.outcome = current
      return
    }

    if (current === 'unloading' || current === 'disposed') {
      if (record.outcome === 'in-progress') {
        record.outcome = 'disposed-before-terminal'
      }
    }
  }
}
