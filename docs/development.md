# Development notes

The current milestone includes the Host runtime collector, a strict Typert
Remote snapshot, and a Web settings contribution under Plugins / Performance.

## What is measured

- Cordis `internal/status` transitions observed after this Bundle attaches.
- Loader-backed entries identified by `entry.id`.
- Dependency-wait and activation segments kept separate.
- Reloads represented by `entry.id + generation`.
- Missing starts represented as `left-censored`, never as a zero duration.

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

## Compatibility boundary

`src/adapters/cordis-internal.ts` is the only file that knows the internal
Cordis state numbers, `internal/status`, or `fiber.entry`. The current target is
DSH `0.1.1-rc.2`, local scan baseline `b150a551b8`. Revalidate this adapter when
upgrading DSH; the core state machine should remain independent.
