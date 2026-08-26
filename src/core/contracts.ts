import type { ActivationSample, LifecycleSignal } from './types.js'

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
