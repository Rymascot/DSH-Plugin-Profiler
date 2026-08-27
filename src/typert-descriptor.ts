import { profilerSnapshotSchema } from './wire/schema.js'

export const PROFILER_PACKAGE = 'dsh-plugin-profiler'
export const PROFILER_SERVICE = 'pluginProfiler'
export const PROFILER_METHOD = 'snapshot'
export const PROFILER_ENDPOINT = `${PROFILER_SERVICE}/${PROFILER_METHOD}`

/** Strict descriptor shared by the Host registry and browser Remote projection. */
export const PROFILER_INVOCATION = {
  id: `${PROFILER_PACKAGE}#${PROFILER_ENDPOINT}`,
  service: PROFILER_SERVICE,
  namespace: PROFILER_SERVICE,
  method: PROFILER_METHOD,
  invocation: { kind: 'direct' as const },
  parameters: [],
  result: {
    mode: 'strict' as const,
    typeSymbol: `${PROFILER_PACKAGE}/types#ProfilerSnapshot`,
    schema: profilerSnapshotSchema,
  },
  sourceLocation: {
    file: 'src/host/gateway.ts',
    line: 31,
    column: 3,
  },
}
