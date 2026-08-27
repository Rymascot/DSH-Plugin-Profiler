import { PROFILER_INVOCATION, PROFILER_PACKAGE } from './typert-descriptor.js'

/**
 * Host reflection contribution discovered through the package's ./typert export.
 *
 * It is intentionally authored in this standalone repository because DSH's
 * workspace-only generator is not part of the external-plugin build surface.
 */
export const TYPERT = {
  package: PROFILER_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: [PROFILER_INVOCATION],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
