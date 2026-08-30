# Development notes

The current milestone includes the Host runtime collector, a strict Typert
Remote snapshot, and a Web settings contribution under Plugins / Performance.

## What is measured

- Cordis `internal/status` transitions observed after this Bundle attaches.
- Loader-backed entries identified by `entry.id`.
- Dependency-wait and activation segments kept separate.
- Reloads represented by `entry.id + generation`.
- Missing starts represented as `left-censored`, never as a zero duration.
- Entry origin (`builtin` / `user` / `unknown`) resolved from the profile
  manifest, so the ~135 rows the shipped bundles contribute can be separated
  from the plugins the user installed.

Every snapshot is marked `partial`. A normal Bundle cannot observe events that
happened before it loaded, module resolution/import time, a whole Profile cold
start, or the startup critical path.

## Local checks

```powershell
pnpm install
pnpm run check
```

The build has two faces. TypeScript emits the Host entry, public types, and
authored Typert artifacts. tsdown emits the DSH browser module-loader bundle;
React stays a platform external while the strict Zod codec is bundled.

## Test Profile installation

```powershell
pnpm run build
dsh plugin --profile web add .
```

Restart the Profile after installation. Do not also insert `plugin-profiler`
manually into that Profile's `cordis.patch.yml`; doing both creates a duplicate
Loader entry id.

The plugin runs inside DSH and has no standalone process to keep alive.

## Origin resolution

`src/adapters/profile-manifest.ts` reads the profile's `package.json` through
`ctx.baseUrl` — the Loader anchors it at the profile directory as a trailing-slash
file URL. A bundle listed in `dsh.profile.bundles` that also appears in
`dependencies` was installed by the user; the rest resolve from the dsh
installation and count as built-in. An explicit dependency outranks the
`@deepseek-ai/` scope check, so a third-party package published under that scope
is still classified as the user's.

Every failure path degrades to `resolved: false` with a reason rather than
throwing: origin only drives presentation layering, and losing it must not cost
a sample.

## Compatibility boundary

`src/adapters/cordis-internal.ts` is the only file that knows the internal
Cordis state numbers, `internal/status`, or `fiber.entry`.
`src/adapters/profile-manifest.ts` is the only file that knows `ctx.baseUrl`
anchors the profile directory and how a profile manifest is shaped. The current
target is DSH `0.1.1-rc.2`, local scan baseline `b150a551b8`. Revalidate both
adapters when upgrading DSH; the core state machine and the origin index should
remain independent of them.

## Wire version

The snapshot and sample contracts are both at `schemaVersion: 2` (v0.2 added
`sample.origin` and `snapshot.provenance`). Host and client ship from one
package, so a mismatch means a stale build is mounted — the strict Zod codec
rejects it rather than rendering a partial page.
