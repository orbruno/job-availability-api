import {
  DomainInvariantError,
  assertEvidenceConsistency,
  type AvailabilityHistoryEntry,
  type AvailabilityState,
  type AvailabilityStatus,
  type SourceObservation,
} from './availability-contracts.js';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
export const HISTORY_RETENTION_DAYS = 90;

export type AvailabilityClock = {
  now: () => string;
};

export function defaultAvailabilityState(jobId: string): AvailabilityState {
  return {
    schema_version: 1,
    job_id: jobId,
    status: 'unchecked',
    last_checked_at: null,
    last_run_id: null,
    closure_run_ids: [],
    sources: [],
    history: [],
  };
}

export function aggregateSourceStatus(
  observations: readonly SourceObservation[],
): AvailabilityStatus {
  if (observations.length === 0) return 'unchecked';
  const outcomes = new Set(
    observations.map((observation) => {
      assertEvidenceConsistency(observation.outcome, observation.evidence_code);
      return observation.outcome;
    }),
  );
  if (outcomes.has('open')) return 'open';
  if (outcomes.size === 1 && outcomes.has('closed')) return 'closed';
  return 'uncertain';
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkedAt(
  observations: readonly SourceObservation[],
  clock: AvailabilityClock,
): string {
  let selected: SourceObservation | undefined;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const value = timestamp(observation.checked_at);
    if (value !== null && value > selectedTime) {
      selected = observation;
      selectedTime = value;
    }
  }
  const result = selected?.checked_at ?? clock.now();
  if (timestamp(result) === null) {
    throw new DomainInvariantError('invalid_clock', 'Availability clock returned an invalid time');
  }
  return result;
}

export function retainedHistory(
  history: readonly AvailabilityHistoryEntry[],
  reference: string,
  retentionDays = HISTORY_RETENTION_DAYS,
): AvailabilityHistoryEntry[] {
  const referenceTime = timestamp(reference);
  if (referenceTime === null) {
    throw new DomainInvariantError('invalid_reference_time', 'History reference time is invalid');
  }
  const cutoff = referenceTime - retentionDays * DAY_MILLISECONDS;
  return history.filter((entry) => {
    const entryTime = timestamp(entry.checked_at);
    return entryTime !== null && entryTime >= cutoff;
  });
}

function transition(
  previous: AvailabilityState,
  runId: string,
  aggregate: AvailabilityStatus,
): { status: AvailabilityStatus; closureRunIds: string[] } {
  let closureRunIds = [...previous.closure_run_ids];
  if (aggregate === 'open') {
    return { status: 'open', closureRunIds: [] };
  }
  if (aggregate === 'closed') {
    if (!closureRunIds.includes(runId)) closureRunIds.push(runId);
    closureRunIds = closureRunIds.slice(-2);
    return {
      status: closureRunIds.length >= 2 ? 'closed' : 'likely_closed',
      closureRunIds,
    };
  }
  if (aggregate === 'uncertain') {
    return { status: 'uncertain', closureRunIds };
  }
  return { status: previous.status, closureRunIds };
}

export function applyObservations(
  previous: AvailabilityState,
  runId: string,
  observations: readonly SourceObservation[],
  clock: AvailabilityClock,
): AvailabilityState {
  if (runId.length === 0) {
    throw new DomainInvariantError('invalid_run_id', 'Run ID cannot be empty');
  }
  const aggregate = aggregateSourceStatus(observations);
  const nextCheckedAt = checkedAt(observations, clock);
  const { status, closureRunIds } = transition(previous, runId, aggregate);
  const priorRuns = previous.history.filter((entry) => entry.run_id !== runId);
  const history = retainedHistory(priorRuns, nextCheckedAt);
  history.push({
    run_id: runId,
    checked_at: nextCheckedAt,
    status,
    source_outcomes: observations.map((item) => ({ ...item })),
  });
  return {
    schema_version: 1,
    job_id: previous.job_id,
    status,
    last_checked_at: nextCheckedAt,
    last_run_id: runId,
    closure_run_ids: closureRunIds,
    sources: observations.map((item) => ({ ...item })),
    history,
  };
}
