import { describe, expect, it, vi } from 'vitest'

import {
  CORDIS_FIBER_STATE,
  createCordisLifecycleSource,
  mapCordisFiberState,
  type CordisContextLike,
} from '../src/adapters/cordis-internal.js'

describe('Cordis internal lifecycle adapter', () => {
  it('maps the six states used by the pinned DSH Cordis version', () => {
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.PENDING)).toBe('pending')
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.LOADING)).toBe('loading')
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.ACTIVE)).toBe('active')
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.FAILED)).toBe('failed')
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.DISPOSED)).toBe('disposed')
    expect(mapCordisFiberState(CORDIS_FIBER_STATE.UNLOADING)).toBe('unloading')
    expect(mapCordisFiberState(99)).toBe('unknown')
  })

  it('subscribes only to internal/status and extracts Loader identity', () => {
    let listener: ((fiber: { state: number; entry: object }, previousState: unknown) => void) | undefined
    const dispose = vi.fn()
    const on = vi.fn((event, callback) => {
      expect(event).toBe('internal/status')
      listener = callback
      return dispose
    })
    const ctx = { on, effect: vi.fn() } as unknown as CordisContextLike
    const received = vi.fn()
    const stop = createCordisLifecycleSource(ctx).subscribe(received)
    const fiber = {
      state: CORDIS_FIBER_STATE.ACTIVE,
      entry: { id: 'example', options: { name: 'dsh-example' } },
    }

    listener?.(fiber, CORDIS_FIBER_STATE.LOADING)
    stop()

    expect(received).toHaveBeenCalledWith({
      fiberToken: fiber,
      entryId: 'example',
      moduleName: 'dsh-example',
      previous: 'loading',
      current: 'active',
    })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps Fibers without Loader entries observable but anonymous', () => {
    let listener: ((fiber: { state: number }, previousState: unknown) => void) | undefined
    const ctx = {
      on: (_event: string, callback: typeof listener) => {
        listener = callback
        return () => undefined
      },
      effect: vi.fn(),
    } as unknown as CordisContextLike
    const received = vi.fn()
    createCordisLifecycleSource(ctx).subscribe(received)
    const fiber = { state: CORDIS_FIBER_STATE.LOADING }

    listener?.(fiber, CORDIS_FIBER_STATE.PENDING)

    expect(received).toHaveBeenCalledWith({
      fiberToken: fiber,
      previous: 'pending',
      current: 'loading',
    })
  })
})
