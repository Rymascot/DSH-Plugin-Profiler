import type { Dispose, LifecycleSource } from '../core/contracts.js'
import type { LifecycleSignal, LifecycleState } from '../core/types.js'

export const CORDIS_FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

interface CordisEntryLike {
  readonly id?: unknown
  readonly options?: {
    readonly name?: unknown
  }
}

interface CordisFiberLike {
  readonly state?: unknown
  readonly entry?: CordisEntryLike
}

export interface CordisContextLike {
  on(
    event: 'internal/status',
    listener: (fiber: CordisFiberLike, previousState: unknown) => void,
  ): (() => unknown)
  effect(execute: () => Dispose, label?: string): unknown
  provide(name: string, value: object): (() => unknown)
}

export function mapCordisFiberState(value: unknown): LifecycleState {
  if (value === CORDIS_FIBER_STATE.PENDING) return 'pending'
  if (value === CORDIS_FIBER_STATE.LOADING) return 'loading'
  if (value === CORDIS_FIBER_STATE.ACTIVE) return 'active'
  if (value === CORDIS_FIBER_STATE.FAILED) return 'failed'
  if (value === CORDIS_FIBER_STATE.DISPOSED) return 'disposed'
  if (value === CORDIS_FIBER_STATE.UNLOADING) return 'unloading'
  return 'unknown'
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

export function createCordisLifecycleSource(ctx: CordisContextLike): LifecycleSource {
  if (typeof ctx.on !== 'function') {
    throw new TypeError('DSH Plugin Profiler requires a Cordis context with ctx.on().')
  }

  return {
    subscribe(listener): Dispose {
      const dispose = ctx.on('internal/status', (fiber, previousState) => {
        if (typeof fiber !== 'object' || fiber === null) return

        try {
          const entryId = nonEmptyString(fiber.entry?.id)
          const moduleName = nonEmptyString(fiber.entry?.options?.name)
          const signal: LifecycleSignal = {
            fiberToken: fiber,
            previous: mapCordisFiberState(previousState),
            current: mapCordisFiberState(fiber.state),
            ...(entryId === undefined ? {} : { entryId }),
            ...(moduleName === undefined ? {} : { moduleName }),
          }
          listener(signal)
        } catch {
          // This adapter touches version-sensitive internal objects. A malformed
          // event must not take down the DSH Host process.
        }
      })

      return () => {
        dispose()
      }
    },
  }
}
