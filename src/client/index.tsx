import type { ReactNode } from 'react'

import { parseProfilerSnapshot } from '../wire/schema.js'
import TYPERT_REMOTE from '../typert.remote-client.js'
import { ProfilerSettingsTab } from './ProfilerSettingsTab.js'
import type {
  ProfilerClientContext,
  ProfilerClientFiber,
  ProfilerTabInjected,
} from './contracts.js'
import { en, zh } from './locales.js'
import { PROFILER_STYLE_ID, PROFILER_STYLES } from './styles.js'

export type {
  ProfilerClientContext,
  ProfilerClientFiber,
  ProfilerSettingsTabProps,
  ProfilerTabInjected,
} from './contracts.js'
export {
  activationDurations,
  formatDuration,
  ProfilerSettingsTab,
  quantile,
} from './ProfilerSettingsTab.js'

export const NS = 'settings.pluginProfiler'
export const inject = [
  'slots',
  'locale',
  'remote',
]

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = 'style[data-plugin-css="' + PROFILER_STYLE_ID + '"]'
  if (document.querySelector(selector) !== null) return () => {}

  const element = document.createElement('style')
  element.dataset.plugin = 'dsh-plugin-profiler'
  element.dataset.pluginCss = PROFILER_STYLE_ID
  element.textContent = PROFILER_STYLES
  document.head.appendChild(element)
  return () => { element.remove() }
}

/** 挂载 Remote 描述符，并向设置页面注册“性能”页签。 */
export async function apply(ctx: ProfilerClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  let remoteScope: ProfilerClientFiber | undefined

  try {
    ctx.effect(installStyles, 'dsh-plugin-profiler: client styles')
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'dsh-plugin-profiler: client dictionaries',
    )

    const t = ctx.locale.bind(NS)
    remoteScope = ctx.inject(['remote.pluginProfiler'], (scope) => {
      const readSnapshot: ProfilerTabInjected['readSnapshot'] = async () => {
        const result = await scope.remote.pluginProfiler.snapshot()
        if (!result.ok) {
          throw new Error(
            'pluginProfiler.snapshot failed: ' + result.error.code + ': ' + result.error.message,
          )
        }
        return parseProfilerSnapshot(result.value)
      }

      scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
        name: 'settings.plugins.tab',
        id: 'performance',
        order: 20,
        label: () => t('tab'),
        locale: NS,
        inject: () => ({ readSnapshot }),
      }, ProfilerSettingsTab))
    })
    await remoteScope.await()
  } catch (error) {
    await remoteScope?.dispose()
    await disposeRemote()
    throw error
  }

  return async () => {
    await remoteScope?.dispose()
    await disposeRemote()
  }
}

export type ProfilerClientRender = ReactNode
