import { describe, expect, it, vi } from 'vitest'

import { apply, getProfilerCollector, type CordisContextLike } from '../src/index.js'

describe('Cordis plugin entry', () => {
  it('attaches one collector and removes it with the owning effect', () => {
    const disposeListener = vi.fn()
    let cleanup: (() => void) | undefined
    const ctx = {
      on: vi.fn(() => disposeListener),
      effect: vi.fn((execute: () => () => void) => {
        cleanup = execute()
      }),
    } as unknown as CordisContextLike

    apply(ctx)

    expect(getProfilerCollector(ctx)).toBeDefined()
    expect(ctx.on).toHaveBeenCalledTimes(1)
    cleanup?.()
    expect(disposeListener).toHaveBeenCalledTimes(1)
    expect(getProfilerCollector(ctx)).toBeUndefined()
  })
})
