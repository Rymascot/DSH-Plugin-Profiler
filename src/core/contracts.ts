import type { ActivationSample, LifecycleSignal, LoaderEntryView } from './types.js'

export type Dispose = () => void

export interface Clock {
  now(): number
}

export interface LifecycleSource {
  subscribe(listener: (signal: LifecycleSignal) => void): Dispose
}

export interface SampleReporter {
  sampleCompleted(sample: ActivationSample): void
}

/**
 * 当前 Loader 名单。每次读快照都重新问一次,不做缓存:Cordis 自己维护着条目和
 * Fiber 状态,再存一份只会多出一个需要同步的真相。
 */
export interface LoaderEntrySource {
  entries(): readonly LoaderEntryView[]
}

/** 读不到 Loader 时的降级实现:退回只靠事件流。 */
export const noLoaderEntries: LoaderEntrySource = { entries: () => [] }
