import { describe, expect, it, vi } from 'vitest'

import type { Clock, Dispose, LifecycleSource } from '../src/core/contracts.js'
import { ProfilerCollector } from '../src/core/collector.js'
import { createOriginIndex } from '../src/core/provenance.js'
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
  moduleName = 'dsh-demo',
): LifecycleSignal {
  return { fiberToken, previous, current, entryId, moduleName }
}

const webProfileOrigin = createOriginIndex({
  profileName: 'dsh-profile-web',
  bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-profiler'],
  dependencies: ['dsh-plugin-profiler'],
})

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

describe('ProfilerCollector 归属分层', () => {
  it('给每个样本标注归属,并按 entryId 去重计数', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock, undefined, webProfileOrigin)
    const mine = {}
    const builtin = {}

    collector.start()
    clock.value = 1
    source.emit(signal(mine, 'pending', 'loading', 'profiler', 'dsh-plugin-profiler'))
    source.emit(signal(builtin, 'pending', 'loading', 'llm', '@deepseek-ai/dsh-llm'))
    clock.value = 4
    source.emit(signal(mine, 'loading', 'active', 'profiler', 'dsh-plugin-profiler'))
    source.emit(signal(builtin, 'loading', 'active', 'llm', '@deepseek-ai/dsh-llm'))
    // 同一个插件重载一次:样本变两条,但计数仍应只算一个插件。
    clock.value = 5
    source.emit(signal(mine, 'active', 'loading', 'profiler', 'dsh-plugin-profiler'))
    clock.value = 6
    source.emit(signal(mine, 'loading', 'active', 'profiler', 'dsh-plugin-profiler'))

    const snapshot = collector.snapshot()
    expect(snapshot.samples.map(sample => [sample.entryId, sample.origin])).toEqual([
      ['profiler', 'user'],
      ['llm', 'builtin'],
      ['profiler', 'user'],
    ])
    expect(snapshot.provenance.counts).toEqual({ builtin: 1, user: 1, unknown: 0 })
    expect(snapshot.provenance.resolved).toBe(true)
    expect(snapshot.provenance.profileName).toBe('dsh-profile-web')
  })

  it('没有归属索引时全部标为未判定', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(source, clock)
    const fiber = {}

    collector.start()
    clock.value = 1
    source.emit(signal(fiber, 'pending', 'loading'))
    clock.value = 2
    source.emit(signal(fiber, 'loading', 'active'))

    const snapshot = collector.snapshot()
    expect(snapshot.samples.map(sample => sample.origin)).toEqual(['unknown'])
    expect(snapshot.provenance.resolved).toBe(false)
    expect(snapshot.provenance.counts).toEqual({ builtin: 0, user: 0, unknown: 1 })
  })
})
