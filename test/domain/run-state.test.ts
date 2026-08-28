import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  emptyRunSummary,
  type AvailabilityRun,
  type AvailabilityStatus,
  type RunError,
  type RunStatus,
  type RunSummary,
} from '../../src/domain/availability-contracts.js';
import {
  cancelRun,
  createRecoveryRun,
  finalizeRun,
  pruneFinalizedRuns,
  recordJobFailure,
  recordJobSuccess,
  stableDeduplicate,
  startRun,
  type RunRetentionRecord,
} from '../../src/domain/run-state.js';
import boundaryJson from '../fixtures/boundary-security.v1.json' with { type: 'json' };
import fixtureJson from '../fixtures/run-state.v1.json' with { type: 'json' };
import type { FixtureSet } from '../helpers/fixture-types.js';

type RawAvailabilityRun = Omit<AvailabilityRun, 'summary'> & {
  summary: Partial<RunSummary>;
};

type RunEvent =
  | { type: 'start'; at: string }
  | {
      type: 'job_succeeded';
      job_id: string;
      before: AvailabilityStatus;
      after: AvailabilityStatus;
    }
  | { type: 'job_failed'; job_id: string; code: string; message: string }
  | { type: 'job_check_started'; job_id: string; at: string }
  | { type: 'job_check_completed_stale'; job_id: string; at: string; after: AvailabilityStatus }
  | { type: 'cancel'; at: string }
  | { type: 'finalize'; at: string }
  | { type: 'load' };

type RunInput = {
  initial?: RawAvailabilityRun;
  events?: RunEvent[];
  persisted_before_restart?: RawAvailabilityRun;
  events_after_restart?: RunEvent[];
  cancelled_run?: RawAvailabilityRun;
  recovery_request?: { job_ids: string[]; trigger: string };
  issued_run_id?: string;
  operation?: 'prune';
  retention_days?: number;
  now?: string;
  runs?: RunRetentionRecord[];
};

type RunExpected = {
  status_trace?: RunStatus[];
  final_status?: RunStatus;
  completed_at?: string;
  pending_job_ids?: string[];
  processed_job_ids?: string[];
  processed_after_recovery?: string[];
  error_count?: number;
  errors?: RunError[];
  summary?: Partial<RunSummary>;
  stale_completion_committed?: boolean;
  resurrection_prevented?: boolean;
  loaded_status?: RunStatus;
  replayed_processed_jobs?: string[];
  old_run_status?: RunStatus;
  old_run_unchanged?: boolean;
  new_run_id?: string;
  new_run_status?: RunStatus;
  new_run_pending_job_ids?: string[];
  identities_distinct?: boolean;
  removed_run_ids?: string[];
  retained_run_ids?: string[];
  removed_count?: number;
  unrelated_job_continued?: boolean;
};

type SimulationResult = {
  run: AvailabilityRun;
  statusTrace: RunStatus[];
};

const fixture = fixtureJson as unknown as FixtureSet<RunInput, RunExpected>;

function normalizeRun(raw: RawAvailabilityRun): AvailabilityRun {
  return {
    ...raw,
    job_ids: [...raw.job_ids],
    pending_job_ids: [...raw.pending_job_ids],
    processed_job_ids: [...raw.processed_job_ids],
    errors: raw.errors.map((error) => ({ ...error })),
    summary: { ...emptyRunSummary(), ...raw.summary },
  };
}

function applyEvent(run: AvailabilityRun, event: RunEvent): AvailabilityRun {
  switch (event.type) {
    case 'start':
      return startRun(run, event.at);
    case 'job_succeeded':
      return recordJobSuccess(run, event.job_id, event.before, event.after);
    case 'job_failed':
      return recordJobFailure(run, event.job_id, event.code, event.message);
    case 'job_check_completed_stale':
      return recordJobSuccess(run, event.job_id, 'unchecked', event.after);
    case 'cancel':
      return cancelRun(run, event.at);
    case 'finalize':
      return finalizeRun(run, event.at);
    case 'job_check_started':
    case 'load':
      return run;
  }
}

function simulate(initial: AvailabilityRun, events: readonly RunEvent[]): SimulationResult {
  let run = initial;
  const statusTrace: RunStatus[] = [run.status];
  for (const event of events) {
    run = applyEvent(run, event);
    if (statusTrace.at(-1) !== run.status) statusTrace.push(run.status);
  }
  return { run, statusTrace };
}

function assertRunExpectation(result: SimulationResult, expected: RunExpected): void {
  if (expected.status_trace !== undefined) expect(result.statusTrace).toEqual(expected.status_trace);
  if (expected.final_status !== undefined) expect(result.run.status).toBe(expected.final_status);
  if (expected.completed_at !== undefined) expect(result.run.completed_at).toBe(expected.completed_at);
  if (expected.pending_job_ids !== undefined) {
    expect(result.run.pending_job_ids).toEqual(expected.pending_job_ids);
  }
  if (expected.processed_job_ids !== undefined) {
    expect(result.run.processed_job_ids).toEqual(expected.processed_job_ids);
  }
  if (expected.error_count !== undefined) expect(result.run.errors).toHaveLength(expected.error_count);
  if (expected.errors !== undefined) expect(result.run.errors).toEqual(expected.errors);
  if (expected.summary !== undefined) expect(result.run.summary).toMatchObject(expected.summary);
  if (expected.stale_completion_committed !== undefined) {
    expect(result.run.processed_job_ids.length > 0).toBe(expected.stale_completion_committed);
  }
  if (expected.resurrection_prevented !== undefined) {
    expect(result.run.status === 'cancelled').toBe(expected.resurrection_prevented);
  }
  if (expected.unrelated_job_continued !== undefined) {
    expect(result.run.processed_job_ids.includes('job-open')).toBe(expected.unrelated_job_continued);
  }
}

describe('durable run-state fixture corpus', () => {
  it.each(fixture.cases)('$id', ({ input, expected }) => {
    if (input.initial !== undefined && input.events !== undefined) {
      const initialSnapshot = structuredClone(input.initial);
      const result = simulate(normalizeRun(input.initial), input.events);
      assertRunExpectation(result, expected);
      expect(input.initial).toEqual(initialSnapshot);
      return;
    }

    if (
      input.persisted_before_restart !== undefined &&
      input.events_after_restart !== undefined
    ) {
      const loaded = normalizeRun(input.persisted_before_restart);
      expect(loaded.status).toBe(expected.loaded_status);
      const result = simulate(loaded, input.events_after_restart);
      expect(result.run.processed_job_ids).toEqual(expected.processed_after_recovery);
      expect(result.run.status).toBe(expected.final_status);
      expect(
        result.run.processed_job_ids.filter((jobId) => jobId === 'job-done').slice(1),
      ).toEqual(expected.replayed_processed_jobs);
      return;
    }

    if (
      input.cancelled_run !== undefined &&
      input.recovery_request !== undefined &&
      input.issued_run_id !== undefined
    ) {
      const oldRun = normalizeRun(input.cancelled_run);
      const oldSnapshot = structuredClone(oldRun);
      const recovered = createRecoveryRun(
        oldRun,
        input.issued_run_id,
        input.recovery_request,
        fixture.frozen_clock,
      );
      expect(oldRun.status).toBe(expected.old_run_status);
      expect(oldRun).toEqual(oldSnapshot);
      expect(oldRun.run_id !== recovered.run_id).toBe(expected.identities_distinct);
      expect(recovered.run_id).toBe(expected.new_run_id);
      expect(recovered.status).toBe(expected.new_run_status);
      expect(recovered.pending_job_ids).toEqual(expected.new_run_pending_job_ids);
      return;
    }

    if (
      input.operation === 'prune' &&
      input.runs !== undefined &&
      input.now !== undefined &&
      input.retention_days !== undefined
    ) {
      const result = pruneFinalizedRuns(input.runs, input.now, input.retention_days);
      expect(result.removed.map((run) => run.run_id)).toEqual(expected.removed_run_ids);
      expect(result.retained.map((run) => run.run_id)).toEqual(expected.retained_run_ids);
      expect(result.removed).toHaveLength(expected.removed_count ?? 0);
      return;
    }

    throw new Error('Unsupported run-state fixture shape');
  });

  it('stable-deduplicates run selections in first-occurrence order', () => {
    type DedupFixture = {
      cases: {
        id: string;
        input: {
          stable_deduplication: { label: string; raw_job_ids?: string[] }[];
        };
        expected: {
          stable_deduplication_results: {
            label: string;
            effective_job_ids?: string[];
          }[];
        };
      }[];
    };
    const boundary = boundaryJson as unknown as DedupFixture;
    const idempotency = boundary.cases.find(
      (item) => item.id === 'security-idempotency-replay-and-conflict',
    );
    const input = idempotency?.input.stable_deduplication.find(
      (item) => item.label === 'first-occurrence-order',
    );
    const expected = idempotency?.expected.stable_deduplication_results.find(
      (item) => item.label === 'first-occurrence-order',
    );
    expect(stableDeduplicate(input?.raw_job_ids ?? [])).toEqual(expected?.effective_job_ids);
  });

  it('does not finalize a running run while work remains pending', () => {
    const raw = fixture.cases.find((item) => item.input.initial !== undefined)?.input.initial;
    if (raw === undefined) throw new Error('run fixture is missing an initial run');
    const running = startRun(normalizeRun(raw), fixture.frozen_clock);
    expect(() => finalizeRun(running, fixture.frozen_clock)).toThrow(
      DomainInvariantError,
    );
  });

  it('records a successfully processed job only once across a same-run retry', () => {
    const raw = fixture.cases.find((item) => item.input.initial !== undefined)?.input.initial;
    if (raw === undefined) throw new Error('run fixture is missing an initial run');
    const running = startRun(normalizeRun(raw), fixture.frozen_clock);
    const first = recordJobSuccess(running, 'job-open', 'unchecked', 'open');
    const retry = recordJobSuccess(first, 'job-open', 'unchecked', 'closed');
    expect(retry.processed_job_ids).toEqual(['job-open']);
    expect(retry.summary).toMatchObject({ checked: 1, open: 1, closed: 0 });
  });
});
