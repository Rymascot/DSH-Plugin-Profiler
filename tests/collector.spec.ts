import { describe, expect, it, vi } from 'vitest'

import type { Clock, Dispose, LifecycleSource } from '../src/core/contracts.js'
import { ProfilerCollector } from '../src/core/collector.js'
import type { LifecycleSignal } from '../src/core/types.js'

class FakeClock implements Clock {
  value = 0

  now(): number {
    return this.value
  }
}

class FakeLifecycleSource implements LifecycleSource {
  listener: ((signal: LifecycleSignal) => void) | undefined
  readonly dispose = vi.fn()

  subscribe(listener: (signal: LifecycleSignal) => void): Dispose {
    this.listener = listener
    return this.dispose
  }

  emit(signal: LifecycleSignal): void {
    this.listener?.(signal)
  }
}

function signal(
  fiberToken: object,
  previous: LifecycleSignal['previous'],
  current: LifecycleSignal['current'],
  entryId = 'demo',
): LifecycleSignal {
  return { fiberToken, previous, current, entryId, moduleName: 'dsh-demo' }
}

describe('ProfilerCollector', () => {
  it('measures a complete loading-to-active activation segment', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)
    const fiber = {}

    collector.start()
    clock.value = 100
    source.emit(signal(fiber, 'pending', 'loading'))
    clock.value = 137
    source.emit(signal(fiber, 'loading', 'active'))

    const [sample] = collector.snapshot().samples
    expect(sample?.outcome).toBe('active')
    expect(sample?.segments.activation).toEqual({
      startOffsetMs: 100,
      endOffsetMs: 137,
      durationMs: 37,
      completeness: 'complete',
    })
    expect(sample?.coverage.overall).toBe('partial')
  })

  it('separates dependency waiting from activation time', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)
    const fiber = {}

    collector.start()
    clock.value = 10
    source.emit(signal(fiber, 'active', 'pending'))
    clock.value = 30
    source.emit(signal(fiber, 'pending', 'loading'))
    clock.value = 50
    source.emit(signal(fiber, 'loading', 'active'))

    const [sample] = collector.snapshot().samples
    expect(sample?.segments.dependencyWait.durationMs).toBe(20)
    expect(sample?.segments.activation.durationMs).toBe(20)
  })

  it('does not invent a duration when the first observed state is terminal', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)

    collector.start()
    clock.value = 25
    source.emit(signal({}, 'loading', 'active'))

    const [sample] = collector.snapshot().samples
    expect(sample?.segments.activation.durationMs).toBeNull()
    expect(sample?.segments.activation.completeness).toBe('left-censored')
  })

  it('keeps concurrent Fibers independent', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)
    const first = {}
    const second = {}

    collector.start()
    clock.value = 1
    source.emit(signal(first, 'pending', 'loading', 'first'))
    clock.value = 5
    source.emit(signal(second, 'pending', 'loading', 'second'))
    clock.value = 11
    source.emit(signal(first, 'loading', 'active', 'first'))
    clock.value = 20
    source.emit(signal(second, 'loading', 'active', 'second'))

    const samples = collector.snapshot().samples
    expect(samples.map(sample => [sample.entryId, sample.segments.activation.durationMs])).toEqual([
      ['first', 10],
      ['second', 15],
    ])
  })

  it('creates a new generation when the same entry reloads', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)
    const fiber = {}

    collector.start()
    clock.value = 1
    source.emit(signal(fiber, 'pending', 'loading'))
    clock.value = 2
    source.emit(signal(fiber, 'loading', 'active'))
    clock.value = 3
    source.emit(signal(fiber, 'active', 'loading'))
    clock.value = 7
    source.emit(signal(fiber, 'loading', 'failed'))

    const samples = collector.snapshot().samples
    expect(samples.map(sample => [sample.generation, sample.outcome])).toEqual([
      [1, 'active'],
      [2, 'failed'],
    ])
  })

  it('disposes its lifecycle subscription exactly once', () => {
    const source = new FakeLifecycleSource()
    const collector = new ProfilerCollector(source, new FakeClock())
    const stop = collector.start()

    stop()
    stop()

    expect(source.dispose).toHaveBeenCalledTimes(1)
  })
})

