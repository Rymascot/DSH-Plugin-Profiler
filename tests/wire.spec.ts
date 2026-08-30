import { describe, expect, it } from 'vitest'

import { ProfilerCollector } from '../src/core/collector.js'
import { TYPERT } from '../src/typert.host.js'
import TYPERT_REMOTE from '../src/typert.remote-client.js'
import { parseProfilerSnapshot, profilerSnapshotSchema } from '../src/wire/schema.js'

function emptySnapshot() {
  const collector = new ProfilerCollector(
    { subscribe: () => () => {} },
    { now: () => 42 },
  )
  collector.start()
  return collector.snapshot()
}

describe('profiler Remote wire contract', () => {
  it('accepts a collector snapshot and rejects incompatible schema versions', () => {
    const snapshot = emptySnapshot()

    expect(parseProfilerSnapshot(snapshot)).toEqual(snapshot)
    expect(() => profilerSnapshotSchema.parse({ ...snapshot, schemaVersion: 2 })).toThrow()
    expect(() => profilerSnapshotSchema.parse({ ...snapshot, schemaVersion: 4 })).toThrow()
  })

  it('publishes matching Host and Client descriptors', () => {
    const host = TYPERT.invocations[0]
    const remote = TYPERT_REMOTE.descriptors[0]

    expect(host).toBe(remote)
    expect(host?.id).toBe('dsh-plugin-profiler#pluginProfiler/snapshot')
    expect(host?.result.mode).toBe('strict')
    expect(TYPERT.package).toBe('dsh-plugin-profiler')
    expect(TYPERT_REMOTE.package).toBe('dsh-plugin-profiler')
  })
})
