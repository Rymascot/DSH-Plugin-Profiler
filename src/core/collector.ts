import { performance } from 'node:perf_hooks'

import type { Clock, Dispose, LifecycleSource, SampleReporter } from './contracts.js'
import { unresolvedOriginIndex, type OriginIndex } from './provenance.js'
import { ActivationStateMachine } from './state-machine.js'
import type { ProfilerSnapshot } from './types.js'

export const monotonicClock: Clock = {
  now: () => performance.now(),
}

export class ProfilerCollector {
  readonly #stateMachine: ActivationStateMachine
  readonly #source: LifecycleSource
  readonly #clock: Clock
  readonly #reporter: SampleReporter | undefined
  #attachedAtMonotonicMs = 0
  #lastOffsetMs = 0
  #disposeSource: Dispose | undefined
  #started = false
  #active = false

  constructor(
    source: LifecycleSource,
    clock: Clock = monotonicClock,
    reporter?: SampleReporter,
    origin: OriginIndex = unresolvedOriginIndex('未接入 Profile 清单。'),
  ) {
    this.#source = source
    this.#clock = clock
    this.#reporter = reporter
    this.#stateMachine = new ActivationStateMachine(origin)
  }

  start(): Dispose {
    if (this.#started) return () => this.stop()

    this.#started = true
    this.#active = true
    this.#attachedAtMonotonicMs = this.#readInitialClock()
    this.#disposeSource = this.#source.subscribe(signal => {
      if (!this.#active) return

      const offsetMs = this.#readOffset()
      const completedSample = this.#stateMachine.consume(signal, offsetMs)
      if (completedSample === undefined || this.#reporter === undefined) return

      try {
        this.#reporter.sampleCompleted(completedSample)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#stateMachine.recordDiagnostic(
          'reporter-error',
          offsetMs,
          `Sample reporter failed: ${message}`,
          completedSample.entryId,
        )
      }
    })

    return () => this.stop()
  }

  stop(): void {
    if (!this.#active) return
    this.#active = false
    this.#disposeSource?.()
    this.#disposeSource = undefined
  }

  snapshot(): ProfilerSnapshot {
    return this.#stateMachine.snapshot(this.#attachedAtMonotonicMs)
  }

  #readInitialClock(): number {
    const value = this.#clock.now()
    if (Number.isFinite(value)) return value

    this.#stateMachine.recordDiagnostic(
      'invalid-clock',
      0,
      'The monotonic clock returned a non-finite value while attaching.',
    )
    return 0
  }

  #readOffset(): number {
    const now = this.#clock.now()
    if (!Number.isFinite(now)) {
      this.#stateMachine.recordDiagnostic(
        'invalid-clock',
        this.#lastOffsetMs,
        'The monotonic clock returned a non-finite value.',
      )
      return this.#lastOffsetMs
    }

    const offsetMs = now - this.#attachedAtMonotonicMs
    if (offsetMs < this.#lastOffsetMs) {
      this.#stateMachine.recordDiagnostic(
        'clock-regression',
        this.#lastOffsetMs,
        `The monotonic clock moved backwards from ${this.#lastOffsetMs}ms to ${offsetMs}ms.`,
      )
      return this.#lastOffsetMs
    }

    this.#lastOffsetMs = offsetMs
    return offsetMs
  }
}

