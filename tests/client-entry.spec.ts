import { describe, expect, it, vi } from 'vitest'

import { apply, type ProfilerClientContext } from '../src/client/index.js'
import type { ProfilerTabInjected } from '../src/client/contracts.js'
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

describe('browser plugin entry', () => {
  it('mounts its Remote descriptor before registering the Performance tab', async () => {
    const snapshot = emptySnapshot()
    const disposeRemote = vi.fn(async () => {})
    let mounted = false
    let injected: ProfilerTabInjected | undefined
    let tabId: string | undefined

    const ctx = {
      remote: {
        $mount: vi.fn(async contribution => {
          expect(contribution).toBe(TYPERT_REMOTE)
          mounted = true
          return disposeRemote
        }),
        pluginProfiler: {
          snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
        },
      },
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
    } as unknown as ProfilerClientContext

    const dispose = await apply(ctx)

    expect(tabId).toBe('performance')
    await expect(injected?.readSnapshot()).resolves.toEqual(snapshot)
    await dispose()
    expect(disposeRemote).toHaveBeenCalledTimes(1)
  })
})
