import { z } from 'zod'

import type { ProfilerSnapshot } from '../core/types.js'

const nullableFiniteNumber = z.number().finite().nullable()
const nonnegativeFiniteNumber = z.number().finite().nonnegative()

export const segmentTimingSchema = z.object({
  startOffsetMs: nullableFiniteNumber,
  endOffsetMs: nullableFiniteNumber,
  durationMs: nullableFiniteNumber,
  completeness: z.enum(['complete', 'left-censored', 'right-censored', 'unobserved']),
})

export const pluginOriginSchema = z.enum(['builtin', 'user', 'unknown'])

export const bundleOriginSchema = z.object({
  packageName: z.string().min(1),
  origin: z.enum(['builtin', 'user']),
})

export const profileProvenanceSchema = z.object({
  resolved: z.boolean(),
  reason: z.string().optional(),
  profileName: z.string().min(1).optional(),
  bundles: z.array(bundleOriginSchema),
  counts: z.object({
    builtin: z.number().int().nonnegative(),
    user: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
})

export const activationSampleSchema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  entryId: z.string().min(1),
  moduleName: z.string().min(1).optional(),
  origin: pluginOriginSchema,
  generation: z.number().int().positive(),
  firstSeenOffsetMs: nonnegativeFiniteNumber,
  lastSeenOffsetMs: nonnegativeFiniteNumber,
  lastState: z.enum([
    'pending',
    'loading',
    'active',
    'failed',
    'disposed',
    'unloading',
    'unknown',
  ]),
  outcome: z.enum(['active', 'failed', 'in-progress', 'disposed-before-terminal']),
  failureStage: z.enum(['pending', 'loading', 'unknown']).optional(),
  segments: z.object({
    dependencyWait: segmentTimingSchema,
    activation: segmentTimingSchema,
  }),
  coverage: z.object({
    overall: z.literal('partial'),
    collectorAttachedAfterBootStarted: z.literal(true),
    moduleImportObserved: z.literal(false),
    loaderBackedEntryOnly: z.literal(true),
  }),
})

export const profilerDiagnosticSchema = z.object({
  code: z.enum([
    'clock-regression',
    'duplicate-transition',
    'invalid-clock',
    'missing-entry-id',
    'reporter-error',
    'transition-gap',
    'unknown-state',
  ]),
  offsetMs: nonnegativeFiniteNumber,
  message: z.string(),
  entryId: z.string().min(1).optional(),
})

export const profilerSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  provenance: profileProvenanceSchema,
  collector: z.object({
    mode: z.literal('host-runtime'),
    coverage: z.literal('partial'),
    attachedAtMonotonicMs: nonnegativeFiniteNumber,
    target: z.object({
      dshVersion: z.string().min(1),
      dshCommit: z.string().min(1),
    }),
    excluded: z.tuple([
      z.literal('events-before-profiler-attach'),
      z.literal('module-resolution-and-import'),
      z.literal('fibers-without-loader-entry'),
      z.literal('whole-profile-cold-start'),
      z.literal('critical-path'),
    ]),
  }),
  samples: z.array(activationSampleSchema),
  diagnostics: z.object({
    total: z.number().int().nonnegative(),
    byCode: z.object({
      'clock-regression': z.number().int().nonnegative(),
      'duplicate-transition': z.number().int().nonnegative(),
      'invalid-clock': z.number().int().nonnegative(),
      'missing-entry-id': z.number().int().nonnegative(),
      'reporter-error': z.number().int().nonnegative(),
      'transition-gap': z.number().int().nonnegative(),
      'unknown-state': z.number().int().nonnegative(),
    }),
    entries: z.array(profilerDiagnosticSchema),
  }),
})

/** Validate an untrusted Remote payload against the profiler wire contract. */
export function parseProfilerSnapshot(value: unknown): ProfilerSnapshot {
  return profilerSnapshotSchema.parse(value) as ProfilerSnapshot
}
