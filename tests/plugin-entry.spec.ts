import { describe, expect, it, vi } from 'vitest'

import {
  apply,
  getProfilerCollector,
  getProfilerGateway,
  type CordisContextLike,
} from '../src/index.js'

describe('Cordis plugin entry', () => {
  it('attaches one collector and removes it with the owning effect', () => {
    const disposeListener = vi.fn()
    const disposeService = vi.fn()
    let cleanup: (() => void) | undefined
    const ctx = {
      on: vi.fn(() => disposeListener),
      provide: vi.fn(() => disposeService),
      effect: vi.fn((execute: () => () => void) => {
        cleanup = execute()
      }),
    } as unknown as CordisContextLike

    apply(ctx)

    expect(getProfilerCollector(ctx)).toBeDefined()
    expect(getProfilerGateway(ctx)).toBeDefined()
    expect(ctx.on).toHaveBeenCalledTimes(1)
    expect(ctx.provide).toHaveBeenCalledWith('pluginProfiler', getProfilerGateway(ctx))
    expect(getProfilerGateway(ctx)?.snapshot().schemaVersion).toBe(1)
    cleanup?.()
    expect(disposeService).toHaveBeenCalledTimes(1)
    expect(disposeListener).toHaveBeenCalledTimes(1)
    expect(getProfilerCollector(ctx)).toBeUndefined()
    expect(getProfilerGateway(ctx)).toBeUndefined()
  })
})
