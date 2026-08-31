import { describe, expect, it, vi } from 'vitest'

import { ProfilerCollector } from '../src/core/collector.js'
import type {
  Clock,
  Dispose,
  LifecycleSource,
  LoaderEntrySource,
} from '../src/core/contracts.js'
import { createOriginIndex } from '../src/core/provenance.js'
import type {
  ActivationSample,
  DependencyLink,
  LifecycleSignal,
  LoaderEntryView,
} from '../src/core/types.js'

class FakeClock implements Clock {
  value = 0

  now(): number {
    return this.value
  }
}

class FakeLifecycleSource implements LifecycleSource {
  listener: ((signal: LifecycleSignal) => void) | undefined

  subscribe(listener: (signal: LifecycleSignal) => void): Dispose {
    this.listener = listener
    return vi.fn()
  }

  emit(signal: LifecycleSignal): void {
    this.listener?.(signal)
  }
}

interface SignalExtras {
  readonly isGroup?: boolean
  readonly parentEntryId?: string
  readonly dependencies?: readonly DependencyLink[]
}

function signal(
  fiberToken: object,
  previous: LifecycleSignal['previous'],
  current: LifecycleSignal['current'],
  entryId: string,
  extras: SignalExtras = {},
): LifecycleSignal {
  return {
    fiberToken,
    previous,
    current,
    entryId,
    moduleName: entryId,
    ...(extras.isGroup === undefined ? {} : { isGroup: extras.isGroup }),
    ...(extras.parentEntryId === undefined ? {} : { parentEntryId: extras.parentEntryId }),
    ...(extras.dependencies === undefined ? {} : { dependencies: extras.dependencies }),
  }
}

function byEntryId(samples: readonly ActivationSample[]): Map<string, ActivationSample> {
  return new Map(samples.map(sample => [sample.entryId, sample]))
}

function startCollector(): {
  readonly source: FakeLifecycleSource
  readonly clock: FakeClock
  readonly collector: ProfilerCollector
} {
  const source = new FakeLifecycleSource()
  const clock = new FakeClock()
  const collector = new ProfilerCollector(source, clock)
  collector.start()
  return { source, clock, collector }
}

describe('自身耗时', () => {
  it('扣掉子条目占用的时间,并且按区间合并而不是相加', () => {
    const { source, clock, collector } = startCollector()
    const group = {}
    const first = {}
    const second = {}

    clock.value = 0
    source.emit(signal(group, 'pending', 'loading', 'bundle', { isGroup: true }))
    clock.value = 10
    source.emit(signal(first, 'pending', 'loading', 'a', { parentEntryId: 'bundle' }))
    clock.value = 30
    source.emit(signal(second, 'pending', 'loading', 'b', { parentEntryId: 'bundle' }))
    clock.value = 40
    source.emit(signal(first, 'loading', 'active', 'a', { parentEntryId: 'bundle' }))
    clock.value = 70
    source.emit(signal(second, 'loading', 'active', 'b', { parentEntryId: 'bundle' }))
    clock.value = 100
    source.emit(signal(group, 'loading', 'active', 'bundle', { isGroup: true }))

    const samples = byEntryId(collector.snapshot().samples)
    expect(samples.get('bundle')?.segments.activation.durationMs).toBe(100)
    // 两个子条目重叠:[10,40] 与 [30,70] 合并后占 60ms,而不是 30+40=70ms。
    expect(samples.get('bundle')?.selfTime).toEqual({
      durationMs: 40,
      basis: 'exact',
      childEntryCount: 2,
    })
    expect(samples.get('bundle')?.isGroup).toBe(true)
    expect(samples.get('a')?.selfTime.durationMs).toBe(30)
    expect(samples.get('a')?.parentEntryId).toBe('bundle')
  })

  it('没有子条目时等于激活耗时', () => {
    const { source, clock, collector } = startCollector()
    const fiber = {}

    clock.value = 100
    source.emit(signal(fiber, 'pending', 'loading', 'solo'))
    clock.value = 137
    source.emit(signal(fiber, 'loading', 'active', 'solo'))

    expect(collector.snapshot().samples[0]?.selfTime).toEqual({
      durationMs: 37,
      basis: 'exact',
      childEntryCount: 0,
    })
  })

  it('子条目缺少计时时只给上界,不假装扣干净了', () => {
    const { source, clock, collector } = startCollector()
    const group = {}
    const child = {}

    clock.value = 0
    source.emit(signal(group, 'pending', 'loading', 'bundle', { isGroup: true }))
    // 这个子条目在 Profiler 挂载之前就开始加载了,没有起点可用。
    clock.value = 20
    source.emit(signal(child, 'loading', 'active', 'c', { parentEntryId: 'bundle' }))
    clock.value = 60
    source.emit(signal(group, 'loading', 'active', 'bundle', { isGroup: true }))

    expect(byEntryId(collector.snapshot().samples).get('bundle')?.selfTime).toEqual({
      durationMs: 60,
      basis: 'upper-bound',
      childEntryCount: 1,
    })
  })

  it('激活本身没测到时不给自身耗时', () => {
    const { source, clock, collector } = startCollector()

    clock.value = 25
    source.emit(signal({}, 'loading', 'active', 'late'))

    expect(collector.snapshot().samples[0]?.selfTime).toEqual({
      durationMs: null,
      basis: 'unobserved',
      childEntryCount: 0,
    })
  })
})

describe('依赖归因', () => {
  const dependencies: readonly DependencyLink[] = [
    { service: 'db', providerEntryId: 'p-early' },
    { service: 'log', providerEntryId: 'p-late' },
    { service: 'ui', providerEntryId: 'p-later' },
  ]

  it('认定最后就绪的那个依赖为阻塞者,并记下与解除时刻的间隔', () => {
    const { source, clock, collector } = startCollector()
    const early = {}
    const late = {}
    const later = {}
    const waiting = {}

    clock.value = 0
    source.emit(signal(waiting, 'unknown', 'pending', 'x', { dependencies }))
    source.emit(signal(early, 'pending', 'loading', 'p-early'))
    clock.value = 20
    source.emit(signal(early, 'loading', 'active', 'p-early'))
    source.emit(signal(late, 'pending', 'loading', 'p-late'))
    clock.value = 50
    source.emit(signal(late, 'loading', 'active', 'p-late'))
    clock.value = 55
    source.emit(signal(waiting, 'pending', 'loading', 'x', { dependencies }))
    clock.value = 60
    source.emit(signal(waiting, 'loading', 'active', 'x', { dependencies }))
    // 解除之后才就绪的提供方与这次等待无关。
    source.emit(signal(later, 'pending', 'loading', 'p-later'))
    clock.value = 80
    source.emit(signal(later, 'loading', 'active', 'p-later'))

    const sample = byEntryId(collector.snapshot().samples).get('x')
    expect(sample?.segments.dependencyWait.durationMs).toBe(55)
    expect(sample?.blockedBy).toEqual({
      service: 'log',
      entryId: 'p-late',
      providerReadyOffsetMs: 50,
      skewMs: 5,
    })
  })

  it('提供方没就绪过就不归因', () => {
    const { source, clock, collector } = startCollector()
    const waiting = {}

    clock.value = 0
    source.emit(signal(waiting, 'unknown', 'pending', 'x', { dependencies }))
    clock.value = 30
    source.emit(signal(waiting, 'pending', 'loading', 'x', { dependencies }))
    clock.value = 40
    source.emit(signal(waiting, 'loading', 'active', 'x', { dependencies }))

    const sample = byEntryId(collector.snapshot().samples).get('x')
    expect(sample?.blockedBy).toBeUndefined()
    expect(sample?.dependencies).toEqual(dependencies)
  })

  it('不把条目自己算成阻塞者', () => {
    const { source, clock, collector } = startCollector()
    const fiber = {}
    const selfReferencing: readonly DependencyLink[] = [{ service: 'x', providerEntryId: 'x' }]

    clock.value = 0
    source.emit(signal(fiber, 'unknown', 'pending', 'x', { dependencies: selfReferencing }))
    clock.value = 5
    source.emit(signal(fiber, 'pending', 'loading', 'x', { dependencies: selfReferencing }))
    clock.value = 9
    source.emit(signal(fiber, 'loading', 'active', 'x', { dependencies: selfReferencing }))
    // 重载一次:此时 'x' 自己已经就绪过,自引用仍然不该被当成阻塞者。
    clock.value = 12
    source.emit(signal(fiber, 'active', 'loading', 'x', { dependencies: selfReferencing }))
    clock.value = 15
    source.emit(signal(fiber, 'loading', 'active', 'x', { dependencies: selfReferencing }))

    for (const sample of collector.snapshot().samples) {
      expect(sample.blockedBy).toBeUndefined()
    }
  })

  it('依赖表以进入 loading 的那次采样为准', () => {
    const { source, clock, collector } = startCollector()
    const fiber = {}
    const pendingView: readonly DependencyLink[] = [{ service: 'db' }]
    const loadingView: readonly DependencyLink[] = [{ service: 'db', providerEntryId: 'p' }]

    clock.value = 0
    source.emit(signal(fiber, 'unknown', 'pending', 'x', { dependencies: pendingView }))
    clock.value = 10
    source.emit(signal(fiber, 'pending', 'loading', 'x', { dependencies: loadingView }))
    clock.value = 20
    source.emit(signal(fiber, 'loading', 'active', 'x', { dependencies: pendingView }))

    expect(collector.snapshot().samples[0]?.dependencies).toEqual(loadingView)
  })
})

describe('流式上报', () => {
  it('一条记录终结时,派生结论就已经算得出来', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const received: ActivationSample[] = []
    const collector = new ProfilerCollector(source, clock, {
      sampleCompleted: sample => { received.push(sample) },
    })
    const group = {}
    const child = {}

    collector.start()
    clock.value = 0
    source.emit(signal(group, 'pending', 'loading', 'bundle', { isGroup: true }))
    clock.value = 10
    source.emit(signal(child, 'pending', 'loading', 'a', { parentEntryId: 'bundle' }))
    clock.value = 40
    source.emit(signal(child, 'loading', 'active', 'a', { parentEntryId: 'bundle' }))
    clock.value = 100
    source.emit(signal(group, 'loading', 'active', 'bundle', { isGroup: true }))

    // 子条目先于容器结束,所以容器上报时它的耗时已经可以被扣掉。
    expect(received.map(sample => [sample.entryId, sample.selfTime.durationMs])).toEqual([
      ['a', 30],
      ['bundle', 70],
    ])
  })
})

describe('观测窗口', () => {
  it('记录从挂载到读取快照之间的时长', () => {
    const { source, clock, collector } = startCollector()

    clock.value = 40
    source.emit(signal({}, 'pending', 'loading', 'a'))
    clock.value = 250

    expect(collector.snapshot().collector.observedUntilOffsetMs).toBe(250)
  })
})

describe('用 Loader 名单补全事件流看不见的插件', () => {
  function loaderWith(...entries: readonly LoaderEntryView[]): LoaderEntrySource {
    return { entries: () => entries }
  }

  function entryView(
    entryId: string,
    overrides: Partial<LoaderEntryView> = {},
  ): LoaderEntryView {
    return {
      entryId,
      moduleName: entryId,
      isGroup: false,
      state: 'active',
      dependencies: [],
      ...overrides,
    }
  }

  it('把名单上有、但一次转换都没观测到的条目补进来,并且不给它编耗时', () => {
    const source = new FakeLifecycleSource()
    const collector = new ProfilerCollector(
      source,
      new FakeClock(),
      undefined,
      undefined,
      loaderWith(entryView('quiet', { isGroup: true, parentEntryId: 'root' })),
    )

    collector.start()

    const [sample] = collector.snapshot().samples
    expect(sample?.entryId).toBe('quiet')
    expect(sample?.observation).toBe('enumerated')
    expect(sample?.generation).toBe(0)
    expect(sample?.outcome).toBe('active')
    expect(sample?.isGroup).toBe(true)
    expect(sample?.parentEntryId).toBe('root')
    expect(sample?.selfTime).toEqual({
      durationMs: null,
      basis: 'unobserved',
      childEntryCount: 0,
    })
    expect(sample?.segments.activation.completeness).toBe('unobserved')
    expect(sample?.segments.dependencyWait.completeness).toBe('unobserved')
  })

  it('事件流已经采到的插件不会被名单重复添加一次', () => {
    const source = new FakeLifecycleSource()
    const clock = new FakeClock()
    const collector = new ProfilerCollector(
      source,
      clock,
      undefined,
      undefined,
      loaderWith(entryView('seen'), entryView('quiet')),
    )
    const fiber = {}

    collector.start()
    clock.value = 10
    source.emit(signal(fiber, 'pending', 'loading', 'seen'))
    clock.value = 30
    source.emit(signal(fiber, 'loading', 'active', 'seen'))

    const samples = collector.snapshot().samples
    expect(samples.map(sample => [sample.entryId, sample.observation])).toEqual([
      ['seen', 'lifecycle'],
      ['quiet', 'enumerated'],
    ])
    expect(samples[0]?.selfTime.durationMs).toBe(20)
  })

  it('补进来的条目照样参与归属判定和计数', () => {
    const origin = createOriginIndex({
      profileName: 'dsh-profile-web',
      bundles: ['@deepseek-ai/dsh-base', 'dshmarket'],
      dependencies: ['dshmarket'],
    })
    const collector = new ProfilerCollector(
      new FakeLifecycleSource(),
      new FakeClock(),
      undefined,
      origin,
      loaderWith(
        entryView('market', { moduleName: 'dshmarket' }),
        entryView('llm', { moduleName: '@deepseek-ai/dsh-llm' }),
      ),
    )

    collector.start()

    const snapshot = collector.snapshot()
    expect(snapshot.samples.map(sample => [sample.entryId, sample.origin])).toEqual([
      ['market', 'user'],
      ['llm', 'builtin'],
    ])
    // 这个计数就是页面上"你装的 N 个插件"那句话的依据,补全前它只会数到 0。
    expect(snapshot.provenance.counts).toEqual({ builtin: 1, user: 1, unknown: 0 })
  })

  it('读不到 Loader 时退回只靠事件流,不报错', () => {
    const { collector } = startCollector()

    expect(collector.snapshot().samples).toEqual([])
  })
})
