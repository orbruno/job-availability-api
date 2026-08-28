import {
  DomainInvariantError,
  emptyRunSummary,
  type AvailabilityRun,
  type AvailabilityStatus,
  type RunError,
  type RunStatus,
} from './availability-contracts.js';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
export const RUN_RETENTION_DAYS = 90;

export type RecoveryRunRequest = {
  job_ids: readonly string[];
  trigger: string;
};

export type RunRetentionRecord = {
  run_id: string;
  status: RunStatus;
  completed_at: string | null;
};

export type RunRetentionResult<T extends RunRetentionRecord> = {
  retained: T[];
  removed: T[];
};

function cloneRun(run: AvailabilityRun): AvailabilityRun {
  return {
    ...run,
    job_ids: [...run.job_ids],
    pending_job_ids: [...run.pending_job_ids],
    processed_job_ids: [...run.processed_job_ids],
    errors: run.errors.map((error) => ({ ...error })),
    summary: { ...run.summary },
  };
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new DomainInvariantError('invalid_clock', 'Run transition time is invalid');
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function assertKnownPendingJob(run: AvailabilityRun, jobId: string): void {
  if (!run.job_ids.includes(jobId)) {
    throw new DomainInvariantError('job_not_in_run', 'Job does not belong to the run');
  }
  if (!run.pending_job_ids.includes(jobId) && !run.processed_job_ids.includes(jobId)) {
    throw new DomainInvariantError('invalid_run_state', 'Job is absent from run progress state');
  }
}

function prepareJobTransition(run: AvailabilityRun, jobId: string): AvailabilityRun | null {
  if (isTerminal(run.status)) return null;
  if (run.status !== 'running') {
    throw new DomainInvariantError('run_not_running', 'Jobs can be recorded only on a running run');
  }
  assertKnownPendingJob(run, jobId);
  if (run.processed_job_ids.includes(jobId)) return null;
  return cloneRun(run);
}

export function stableDeduplicate(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function startRun(run: AvailabilityRun, at: string): AvailabilityRun {
  if (run.status !== 'pending') return cloneRun(run);
  assertTimestamp(at);
  return { ...cloneRun(run), status: 'running', started_at: at };
}

export function recordJobSuccess(
  run: AvailabilityRun,
  jobId: string,
  before: AvailabilityStatus,
  after: AvailabilityStatus,
): AvailabilityRun {
  const updated = prepareJobTransition(run, jobId);
  if (updated === null) return cloneRun(run);
  updated.pending_job_ids = updated.pending_job_ids.filter((item) => item !== jobId);
  updated.processed_job_ids.push(jobId);
  updated.summary.checked += 1;
  updated.summary[after] += 1;
  if (after === 'closed' && before !== 'closed') updated.summary.newly_closed += 1;
  if (after === 'open' && (before === 'closed' || before === 'likely_closed')) {
    updated.summary.reopened += 1;
  }
  return updated;
}

export function recordJobFailure(
  run: AvailabilityRun,
  jobId: string,
  code: string,
  message: string,
  occurredAt?: string,
): AvailabilityRun {
  const updated = prepareJobTransition(run, jobId);
  if (updated === null) return cloneRun(run);
  if (occurredAt !== undefined) assertTimestamp(occurredAt);
  const error: RunError =
    occurredAt === undefined
      ? { job_id: jobId, code, message }
      : { job_id: jobId, code, message, occurred_at: occurredAt };
  updated.pending_job_ids = updated.pending_job_ids.filter((item) => item !== jobId);
  updated.processed_job_ids.push(jobId);
  updated.errors.push(error);
  updated.summary.failed += 1;
  return updated;
}

export function cancelRun(run: AvailabilityRun, at: string): AvailabilityRun {
  if (isTerminal(run.status)) return cloneRun(run);
  assertTimestamp(at);
  return { ...cloneRun(run), status: 'cancelled', completed_at: at };
}

export function finalizeRun(run: AvailabilityRun, at: string): AvailabilityRun {
  if (isTerminal(run.status)) return cloneRun(run);
  if (run.status !== 'running') {
    throw new DomainInvariantError('run_not_running', 'Only a running run can be finalized');
  }
  if (run.pending_job_ids.length > 0) {
    throw new DomainInvariantError('run_not_ready', 'A run with pending jobs cannot be finalized');
  }
  assertTimestamp(at);
  return {
    ...cloneRun(run),
    status: run.errors.length === 0 ? 'completed' : 'failed',
    completed_at: at,
  };
}

export function createRecoveryRun(
  cancelledRun: AvailabilityRun,
  issuedRunId: string,
  request: RecoveryRunRequest,
  createdAt: string,
): AvailabilityRun {
  if (cancelledRun.status !== 'cancelled') {
    throw new DomainInvariantError('run_not_cancelled', 'Recovery requires a cancelled prior run');
  }
  if (issuedRunId.length === 0 || issuedRunId === cancelledRun.run_id) {
    throw new DomainInvariantError('invalid_run_id', 'Recovery requires a distinct run identity');
  }
  assertTimestamp(createdAt);
  const jobIds = stableDeduplicate(request.job_ids);
  if (jobIds.length === 0) {
    throw new DomainInvariantError('empty_job_selection', 'Recovery requires at least one job');
  }
  return {
    schema_version: 1,
    run_id: issuedRunId,
    status: 'pending',
    trigger: request.trigger,
    created_at: createdAt,
    started_at: null,
    completed_at: null,
    job_ids: jobIds,
    pending_job_ids: [...jobIds],
    processed_job_ids: [],
    errors: [],
    summary: emptyRunSummary(),
  };
}

export function pruneFinalizedRuns<T extends RunRetentionRecord>(
  runs: readonly T[],
  reference: string,
  retentionDays = RUN_RETENTION_DAYS,
): RunRetentionResult<T> {
  const referenceTime = Date.parse(reference);
  if (!Number.isFinite(referenceTime)) {
    throw new DomainInvariantError('invalid_reference_time', 'Run retention reference is invalid');
  }
  const cutoff = referenceTime - retentionDays * DAY_MILLISECONDS;
  const retained: T[] = [];
  const removed: T[] = [];
  for (const run of runs) {
    const completedTime = run.completed_at === null ? Number.NaN : Date.parse(run.completed_at);
    if (isTerminal(run.status) && Number.isFinite(completedTime) && completedTime < cutoff) {
      removed.push(run);
    } else {
      retained.push(run);
    }
  }
  return { retained, removed };
}
