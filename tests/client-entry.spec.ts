import { describe, expect, it, vi } from 'vitest'

import { apply, type ProfilerClientContext } from '../src/client/index.js'
import type {
  ProfilerClientFiber,
  ProfilerTabInjected,
  RemoteResult,
} from '../src/client/contracts.js'
import { ProfilerCollector } from '../src/core/collector.js'
import TYPERT_REMOTE from '../src/typert.remote-client.js'

function emptySnapshot() {
  const collector = new ProfilerCollector(
    { subscribe: () => () => {} },
    { now: () => 12 },
  )
  collector.start()
  return collector.snapshot()
}

function createClientHarness(result: RemoteResult<unknown>) {
  const events: string[] = []
  const disposeRemote = vi.fn(async () => { events.push('remote:dispose') })
  const disposeScope = vi.fn(async () => { events.push('scope:dispose') })
  const snapshot = vi.fn(async () => result)
  let directNamespaceReads = 0
  let injected: ProfilerTabInjected | undefined
  let tabId: string | undefined
  let mounted = false

  const parentRemote = {
    $mount: vi.fn(async contribution => {
      expect(contribution).toBe(TYPERT_REMOTE)
      mounted = true
      events.push('remote:mount')
      return disposeRemote
    }),
    get pluginProfiler(): never {
      directNamespaceReads += 1
      throw new Error('cannot get property "remote.pluginProfiler" without inject')
    },
  }

  const remoteScope = {} as ProfilerClientFiber
  remoteScope.await = vi.fn(async () => {
    events.push('scope:await')
    return remoteScope
  })
  remoteScope.dispose = disposeScope

  let ctx: ProfilerClientContext
  ctx = {
    remote: parentRemote,
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key),
    },
    slots: {
      inject: vi.fn((_name: string, contribution: () => unknown) => {
        expect(mounted).toBe(true)
        contribution()
      }),
      register: vi.fn((options: {
        id: string
        inject: () => ProfilerTabInjected
      }) => {
        tabId = options.id
        injected = options.inject()
        return () => {}
      }),
    },
    effect: vi.fn((execute: () => unknown) => execute()),
    inject: vi.fn((dependencies, callback) => {
      expect(dependencies).toEqual(['remote.pluginProfiler'])
      expect(mounted).toBe(true)
      events.push('scope:inject')
      callback({
        ...ctx,
        remote: {
          $mount: parentRemote.$mount,
          pluginProfiler: { snapshot },
        },
      })
      return remoteScope
    }),
  } as unknown as ProfilerClientContext

  return {
    ctx,
    events,
    disposeRemote,
    disposeScope,
    snapshot,
    get directNamespaceReads() { return directNamespaceReads },
    get injected() { return injected },
    get tabId() { return tabId },
  }
}

describe('browser plugin entry', () => {
  it('通过声明 remote.pluginProfiler 的子作用域读取快照', async () => {
    const snapshot = emptySnapshot()
    const harness = createClientHarness({ ok: true, value: snapshot })

    const dispose = await apply(harness.ctx)

    expect(harness.tabId).toBe('performance')
    expect(harness.directNamespaceReads).toBe(0)
    await expect(harness.injected?.readSnapshot()).resolves.toEqual(snapshot)
    expect(harness.events.slice(0, 3)).toEqual([
      'remote:mount',
      'scope:inject',
      'scope:await',
    ])

    await dispose()
    expect(harness.events.slice(-2)).toEqual(['scope:dispose', 'remote:dispose'])
    expect(harness.disposeScope).toHaveBeenCalledTimes(1)
    expect(harness.disposeRemote).toHaveBeenCalledTimes(1)
  })

  it('把 Host Remote 错误码和消息传递给界面', async () => {
    const harness = createClientHarness({
      ok: false,
      error: {
        code: 'service-unavailable',
        message: 'Profiler service is not available',
      },
    })
    const dispose = await apply(harness.ctx)

    await expect(harness.injected?.readSnapshot()).rejects.toThrow(
      'pluginProfiler.snapshot failed: service-unavailable: Profiler service is not available',
    )

    await dispose()
  })
})
