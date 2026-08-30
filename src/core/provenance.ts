import type { BundleOrigin, PluginOrigin, ProvenanceSource } from './types.js'

/**
 * 从 Profile 的 package.json 读出的事实,不含任何文件系统细节。
 *
 * `bundles` 来自 `dsh.profile.bundles`,`dependencies` 来自顶层 `dependencies`。
 * 安装自带的 Bundle 从 DSH 安装目录解析,不会写进 `dependencies`;用户装的插件
 * 由 pnpm 写进 `dependencies`。这个差异就是归属判定的依据。
 */
export interface ProfileManifestFacts {
  readonly profileName?: string
  readonly bundles: readonly string[]
  readonly dependencies: readonly string[]
}

/** DSH 自身发布的包前缀。两个自带 Bundle 插入的条目全部落在这个前缀下。 */
export const BUILTIN_SCOPE = '@deepseek-ai/'

/** 把模块说明符还原成包名:`@scope/pkg/sub` -> `@scope/pkg`。 */
export function packageNameOf(specifier: string): string {
  const normalized = specifier.trim()
  if (normalized === '') return ''
  const parts = normalized.split('/')
  if (normalized.startsWith('@')) {
    const scope = parts[0] ?? ''
    const name = parts[1] ?? ''
    return name === '' ? '' : scope + '/' + name
  }
  return parts[0] ?? ''
}

export interface OriginIndex {
  /** 快照里与样本无关的归属描述,计数由状态机在序列化时补齐。 */
  readonly source: ProvenanceSource
  originOf(moduleName: string | undefined): PluginOrigin
}

/** 读不到 Profile 清单时的降级索引:全部归为未知,界面据此隐藏筛选。 */
export function unresolvedOriginIndex(reason: string): OriginIndex {
  return {
    source: { resolved: false, reason, bundles: [] },
    originOf: () => 'unknown',
  }
}

/**
 * 建立模块名到归属的索引。
 *
 * 判定顺序有意让"用户显式安装"优先于包名前缀:用户完全可以装一个挂在
 * `@deepseek-ai/*` 名下的插件,那时 `dependencies` 才是权威,前缀只是兜底。
 */
export function createOriginIndex(facts: ProfileManifestFacts): OriginIndex {
  const dependencies = new Set(facts.dependencies)
  const bundles: BundleOrigin[] = facts.bundles.map(packageName => ({
    packageName,
    origin: dependencies.has(packageName) ? 'user' : 'builtin',
  }))

  return {
    source: {
      resolved: true,
      ...(facts.profileName === undefined ? {} : { profileName: facts.profileName }),
      bundles,
    },
    originOf(moduleName: string | undefined): PluginOrigin {
      if (moduleName === undefined) return 'unknown'
      const packageName = packageNameOf(moduleName)
      if (packageName === '') return 'unknown'
      if (dependencies.has(packageName)) return 'user'
      if (packageName.startsWith(BUILTIN_SCOPE)) return 'builtin'
      return 'unknown'
    },
  }
}
