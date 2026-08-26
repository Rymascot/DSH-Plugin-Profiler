import {
  EXCLUDED_MEASUREMENTS,
  PARTIAL_COVERAGE,
  TARGET_DSH,
  type ActivationOutcome,
  type ActivationSample,
  type DiagnosticCode,
  type LifecycleSignal,
  type LifecycleState,
  type ProfilerDiagnostic,
  type ProfilerSnapshot,
  type SegmentTiming,
} from './types.js'

interface MutableRecord {
  readonly runId: string
  readonly entryId: string
  moduleName: string | undefined
  readonly generation: number
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

function serialize(record: MutableRecord): ActivationSample {
  const base = {
    schemaVersion: 1,
    runId: record.runId,
    entryId: record.entryId,
    generation: record.generation,
    firstSeenOffsetMs: record.firstSeenOffsetMs,
    lastSeenOffsetMs: record.lastSeenOffsetMs,
    lastState: record.lastState,
    outcome: record.outcome,
    segments: {
      dependencyWait: { ...record.dependencyWait },
      activation: { ...record.activation },
    },
    coverage: PARTIAL_COVERAGE,
  } as const

  return {
    ...base,
    ...(record.moduleName === undefined ? {} : { moduleName: record.moduleName }),
    ...(record.failureStage === undefined ? {} : { failureStage: record.failureStage }),
  }
}

export class ActivationStateMachine {
  readonly #records: MutableRecord[] = []
  readonly #byFiber = new WeakMap<object, FiberCursor>()
  readonly #generationByEntry = new Map<string, number>()
  readonly #diagnostics: ProfilerDiagnostic[] = []

  consume(signal: LifecycleSignal, offsetMs: number): ActivationSample | undefined {
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

    cursor.record.lastSeenOffsetMs = Math.max(cursor.record.lastSeenOffsetMs, offsetMs)
    cursor.record.lastState = signal.current
    cursor.state = signal.current

    if (signal.current === 'disposed') {
      this.#byFiber.delete(signal.fiberToken)
    }

    if (cursor.record.outcome !== 'in-progress' && !cursor.record.completionReported) {
      cursor.record.completionReported = true
      return serialize(cursor.record)
    }

    return undefined
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

  snapshot(attachedAtMonotonicMs: number): ProfilerSnapshot {
    const byCode = Object.fromEntries(
      DIAGNOSTIC_CODES.map(code => [code, 0]),
    ) as Record<DiagnosticCode, number>

    for (const diagnostic of this.#diagnostics) {
      byCode[diagnostic.code] += 1
    }

    return {
      schemaVersion: 1,
      collector: {
        mode: 'host-runtime',
        coverage: 'partial',
        attachedAtMonotonicMs,
        target: {
          dshVersion: TARGET_DSH.version,
          dshCommit: TARGET_DSH.commit,
        },
        excluded: EXCLUDED_MEASUREMENTS,
      },
      samples: this.#records.map(serialize),
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
