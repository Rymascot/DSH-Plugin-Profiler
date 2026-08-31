import { describe, expect, it, vi } from 'vitest'

import {
  CORDIS_FIBER_STATE,
  createCordisLifecycleSource,
  readLoaderEntries,
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

/** 把一个假 Fiber 送进适配器,返回它产出的信号。 */
function emitFiber(fiber: object): Record<string, unknown> {
  let listener: ((fiber: object, previousState: unknown) => void) | undefined
  const ctx = {
    on: (_event: string, callback: typeof listener) => {
      listener = callback
      return () => undefined
    },
    effect: vi.fn(),
  } as unknown as CordisContextLike
  const received = vi.fn()

  createCordisLifecycleSource(ctx).subscribe(received)
  listener?.(fiber, CORDIS_FIBER_STATE.PENDING)

  return received.mock.calls[0]?.[0] as Record<string, unknown>
}

describe('Cordis 结构关系与依赖提供方', () => {
  it('读出父条目,并把注入的服务映射到提供它的条目', () => {
    const signal = emitFiber({
      state: CORDIS_FIBER_STATE.LOADING,
      entry: { id: 'child', options: { name: 'dsh-child', group: false } },
      parent: { fiber: { entry: { id: 'bundle' } } },
      inject: { db: {}, log: null },
      store: { db: { name: 'db', fiber: { entry: { id: 'p1' } } } },
    })

    expect(signal).toEqual({
      fiberToken: expect.anything(),
      entryId: 'child',
      moduleName: 'dsh-child',
      parentEntryId: 'bundle',
      dependencies: [
        { service: 'db', providerEntryId: 'p1' },
        // 提供方还没进 store 时只留服务名,不猜。
        { service: 'log' },
      ],
      previous: 'pending',
      current: 'loading',
    })
    expect(signal['isGroup']).toBeUndefined()
  })

  it('把 Loader 的分组条目标成容器', () => {
    const signal = emitFiber({
      state: CORDIS_FIBER_STATE.LOADING,
      entry: { id: 'bundle', options: { name: '@deepseek-ai/dsh-base', group: true } },
    })

    expect(signal['isGroup']).toBe(true)
    expect(signal['dependencies']).toBeUndefined()
  })

  it('读不到解析后的依赖表时退回条目自己声明的 inject', () => {
    expect(emitFiber({
      state: CORDIS_FIBER_STATE.LOADING,
      entry: { id: 'a', options: { name: 'dsh-a', inject: ['db', ' ', 'log'] } },
    })['dependencies']).toEqual([{ service: 'db' }, { service: 'log' }])

    expect(emitFiber({
      state: CORDIS_FIBER_STATE.LOADING,
      entry: {
        id: 'b',
        options: { name: 'dsh-b', inject: { required: ['db'], optional: ['log'] } },
      },
    })['dependencies']).toEqual([{ service: 'db' }, { service: 'log' }])
  })

  it('从 Loader 名单读出条目,跳过没有 Fiber 的那些', () => {
    const ctx = {
      on: vi.fn(),
      effect: vi.fn(),
      loader: {
        *entries() {
          yield {
            id: 'running',
            options: { name: 'dsh-running', group: true },
            fiber: {
              state: CORDIS_FIBER_STATE.ACTIVE,
              parent: { fiber: { entry: { id: 'bundle' } } },
              inject: { db: {} },
              store: { db: { name: 'db', fiber: { entry: { id: 'p1' } } } },
            },
          }
          // 条目在配置里,但没跑起来(比如被禁用)。这个工具只报告跑过的东西。
          yield { id: 'disabled', options: { name: 'dsh-disabled' } }
          // 没有 id 的条目本来就无法辨认。
          yield { options: { name: 'dsh-anonymous' }, fiber: { state: CORDIS_FIBER_STATE.ACTIVE } }
        },
      },
    } as unknown as CordisContextLike

    expect(readLoaderEntries(ctx)).toEqual([{
      entryId: 'running',
      moduleName: 'dsh-running',
      isGroup: true,
      parentEntryId: 'bundle',
      state: 'active',
      dependencies: [{ service: 'db', providerEntryId: 'p1' }],
    }])
  })

  it('没有 loader 或者名单读到一半炸了,都不让 Host 挂掉', () => {
    expect(readLoaderEntries({ on: vi.fn(), effect: vi.fn() } as unknown as CordisContextLike))
      .toEqual([])

    const exploding = {
      on: vi.fn(),
      effect: vi.fn(),
      loader: {
        *entries() {
          yield { id: 'ok', options: { name: 'dsh-ok' }, fiber: { state: CORDIS_FIBER_STATE.ACTIVE } }
          throw new Error('loader internals changed')
        },
      },
    } as unknown as CordisContextLike

    // 炸之前读到的那些留着,比整个丢掉有用。
    expect(readLoaderEntries(exploding).map(entry => entry.entryId)).toEqual(['ok'])
  })

  it('卸载清空 store 之后仍保留服务名,只是没有提供方', () => {
    expect(emitFiber({
      state: CORDIS_FIBER_STATE.DISPOSED,
      entry: { id: 'a', options: { name: 'dsh-a' } },
      inject: { db: {} },
      store: undefined,
    })['dependencies']).toEqual([{ service: 'db' }])
  })
})
