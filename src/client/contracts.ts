import type { ComponentType } from 'react'

import type { ProfilerSnapshot } from '../core/types.js'
import type { TYPERT_REMOTE } from '../typert.remote-client.js'
import type { ProfilerLocaleKey } from './locales.js'

export interface RemoteFailure {
  readonly code: string
  readonly message: string
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

export interface ProfilerRemoteNamespace {
  snapshot(): Promise<RemoteResult<unknown>>
}

export interface ProfilerClientRemote {
  readonly pluginProfiler: ProfilerRemoteNamespace
  $mount(contribution: typeof TYPERT_REMOTE): Promise<() => Promise<void>>
}

export interface ProfilerLocale {
  register(
    namespace: string,
    dictionaries: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>,
  ): () => unknown
  bind(namespace: string): (key: ProfilerLocaleKey) => string
}

export interface ProfilerTabInjected {
  readSnapshot(): Promise<ProfilerSnapshot>
}

export interface ProfilerSlots {
  inject(name: 'settings.plugins.tab', contribution: () => unknown): unknown
  register(
    options: {
      readonly name: 'settings.plugins.tab'
      readonly id: string
      readonly order: number
      readonly label: () => string
      readonly locale: string
      readonly inject: () => ProfilerTabInjected
    },
    component: ComponentType<ProfilerSettingsTabProps>,
  ): unknown
}

/** Client 子作用域的最小生命周期接口。 */
export interface ProfilerClientFiber {
  await(): Promise<ProfilerClientFiber>
  dispose(): Promise<void>
}

export interface ProfilerClientContext {
  readonly remote: ProfilerClientRemote
  readonly locale: ProfilerLocale
  readonly slots: ProfilerSlots
  effect(execute: () => unknown, label?: string): unknown
  inject(
    dependencies: readonly string[],
    apply: (scope: ProfilerClientContext) => unknown,
  ): ProfilerClientFiber
}

export type ProfilerSettingsTabProps = ProfilerTabInjected & {
  readonly t: (key: ProfilerLocaleKey) => string
}
