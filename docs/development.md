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
- Group entries flagged from `entry.options.group`, and the parent entry read
  through `fiber.parent.fiber.entry` — the same path the loader itself uses.
  Without them a container's activation span, which contains every child it
  loaded, outranks the plugins that actually spent the time.
- Self time: activation minus the merged span of the child entries inside it.
  Children run concurrently, so their durations are unioned, never summed. A
  child with no usable interval makes the result an `upper-bound`, not a guess.
- Dependency attribution: the injected service names come from `fiber.inject`,
  and each provider from `fiber.store[name].fiber.entry`. The last provider to
  become ready before the entry left `pending` is the one that released it.
  `blockedBy.skewMs` is the gap between those two moments — near zero when the
  attribution holds, large when the real blocker went unobserved. The number is
  published rather than filtered, so a wrong attribution is visible instead of
  silent.

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

Run both lines from this plugin's own directory. `dsh` is not on PATH — it
resolves through the app workspace, so the CLI call needs `pnpm --dir`:

```powershell
pnpm run build
pnpm --dir D:\DSH\app dsh plugin --profile web add .
```

Restart the Profile after installation. Do not also insert `plugin-profiler`
manually into that Profile's `cordis.patch.yml`; doing both creates a duplicate
Loader entry id.

Installation is a one-time step. `add` writes a `link:` dependency into the
profile manifest and symlinks this directory into the profile's `node_modules`,
so afterwards the profile reads `lib/` in place: rebuild here, restart the
Profile, and the new build is live. Do not rebuild the DSH app for a change made
in this repository — nothing in `D:\DSH\app` depends on it.

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
Cordis state numbers, `internal/status`, or the shape of a Fiber — `entry`,
`parent`, `inject`, and `store`. `store` is written synchronously at the top of
Cordis's `_reload()`, before the `internal/status` emit, and cleared in
`_unload()` before its own emit: it is therefore populated on the transition
into `loading` and gone by `unloading`. That ordering is what makes provider
attribution readable at all, and it is the first thing to re-check on upgrade.
`src/adapters/profile-manifest.ts` is the only file that knows `ctx.baseUrl`
anchors the profile directory and how a profile manifest is shaped. The current
target is DSH `0.1.1-rc.2`, local scan baseline `b150a551b8`. Revalidate both
adapters when upgrading DSH; the core state machine and the origin index should
remain independent of them.

## Wire version

The snapshot and sample contracts are both at `schemaVersion: 3`. v0.2 added
`sample.origin` and `snapshot.provenance`; v0.3 added `sample.isGroup`,
`sample.parentEntryId`, `sample.selfTime`, `sample.dependencies`,
`sample.blockedBy`, and `collector.observedUntilOffsetMs`. Host and client ship
from one package, so a mismatch means a stale build is mounted — the strict Zod
codec rejects it rather than rendering a partial page.

## Deliberately out of scope

Recorded so they do not get re-proposed. Each line is a decision, not a backlog
item.

- **Installed-but-not-running plugin inventory.** It would need a scan of the
  plugin directory — a different data source from the lifecycle stream — and it
  turns the project into an installation manifest. This tool reports what ran.
- **Whole-profile cold start.** A normal Bundle attaches partway through boot, so
  the time before its own activation cannot be reconstructed, only invented.
  Reaching it means changing how the profiler is loaded, not how it collects.
- **Module resolution and import time.** Cordis emits `internal/status` around a
  plugin's lifecycle, not around the loader's `import()`. The event stream simply
  does not carry it.
- **Global P95 as a headline number.** The samples come from different plugins,
  so a percentile over them describes the mix, not any one plugin. It stays next
  to the diagnostics as a tail indicator. A per-plugin percentile needs history
  first.
- **History, trend, and regression detection.** Needs persistence and an identity
  that survives Host restarts. Snapshot export is the deliberate stopgap: two
  exported files can be diffed by hand.
