import { PROFILER_INVOCATION, PROFILER_PACKAGE } from './typert-descriptor.js'

/** Browser-side Remote descriptor mounted by the plugin's own client entry. */
export const TYPERT_REMOTE = {
  package: PROFILER_PACKAGE,
  descriptors: [PROFILER_INVOCATION],
}

export default TYPERT_REMOTE
