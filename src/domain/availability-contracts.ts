import {
  AVAILABILITY_STATUSES,
  EVIDENCE_CODES,
  EVIDENCE_OUTCOMES,
  RUN_STATUSES,
  type AvailabilityStatus,
  type EvidenceCode,
  type EvidenceOutcome,
  type RunStatus,
} from '../contracts/contract-version.js';

export {
  AVAILABILITY_STATUSES,
  EVIDENCE_CODES,
  EVIDENCE_OUTCOMES,
  RUN_STATUSES,
};
export type { AvailabilityStatus, EvidenceCode, EvidenceOutcome, RunStatus };

export const OPEN_EVIDENCE: ReadonlySet<EvidenceCode> = new Set([
  'jobposting_active',
  'apply_action_present',
  'platform_open_marker',
]);

export const CLOSED_EVIDENCE: ReadonlySet<EvidenceCode> = new Set([
  'http_404',
  'http_410',
  'valid_through_past',
  'platform_closed_marker',
]);

export const INCONCLUSIVE_EVIDENCE: ReadonlySet<EvidenceCode> = new Set([
  'access_denied',
  'rate_limited',
  'server_error',
  'timeout',
  'network_error',
  'bot_challenge',
  'redirect_mismatch',
  'identity_mismatch',
  'identity_unverified',
  'unsupported_source',
  'parse_error',
]);

export type SourceObservation = {
  platform: string;
  source_identity: string;
  outcome: EvidenceOutcome;
  evidence_code: EvidenceCode;
  checked_at: string;
  http_status: number | null;
};

export type AvailabilityHistoryEntry = {
  run_id: string;
  checked_at: string;
  status: AvailabilityStatus;
  source_outcomes: SourceObservation[];
};

export type AvailabilityState = {
  schema_version: 1;
  job_id: string;
  status: AvailabilityStatus;
  last_checked_at: string | null;
  last_run_id: string | null;
  closure_run_ids: string[];
  sources: SourceObservation[];
  history: AvailabilityHistoryEntry[];
};

export type RunSummary = {
  checked: number;
  open: number;
  likely_closed: number;
  closed: number;
  uncertain: number;
  unchecked: number;
  newly_closed: number;
  reopened: number;
  failed: number;
};

export type RunError = {
  job_id: string;
  code: string;
  message: string;
  occurred_at?: string;
};

export type AvailabilityRun = {
  schema_version: 1;
  run_id: string;
  status: RunStatus;
  trigger: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  job_ids: string[];
  pending_job_ids: string[];
  processed_job_ids: string[];
  errors: RunError[];
  summary: RunSummary;
};

export class DomainInvariantError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainInvariantError';
  }
}

export function evidenceOutcomeForCode(code: EvidenceCode): EvidenceOutcome {
  if (OPEN_EVIDENCE.has(code)) return 'open';
  if (CLOSED_EVIDENCE.has(code)) return 'closed';
  return 'inconclusive';
}

export function isEvidenceConsistencyValid(
  outcome: EvidenceOutcome,
  code: EvidenceCode,
): boolean {
  return evidenceOutcomeForCode(code) === outcome;
}

export function assertEvidenceConsistency(
  outcome: EvidenceOutcome,
  code: EvidenceCode,
): void {
  if (!isEvidenceConsistencyValid(outcome, code)) {
    throw new DomainInvariantError(
      'outcome_evidence_mismatch',
      `Evidence ${code} cannot produce outcome ${outcome}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isEvidenceCode(value: unknown): value is EvidenceCode {
  return typeof value === 'string' && (EVIDENCE_CODES as readonly string[]).includes(value);
}

function isEvidenceOutcome(value: unknown): value is EvidenceOutcome {
  return typeof value === 'string' && (EVIDENCE_OUTCOMES as readonly string[]).includes(value);
}

export function parseSourceObservation(value: unknown): SourceObservation {
  if (!isRecord(value)) {
    throw new DomainInvariantError('invalid_observation', 'Source observation must be an object');
  }
  const keys = [
    'checked_at',
    'evidence_code',
    'http_status',
    'outcome',
    'platform',
    'source_identity',
  ] as const;
  if (!hasExactKeys(value, keys)) {
    throw new DomainInvariantError('invalid_observation', 'Source observation fields do not match v1');
  }
  const { checked_at: checkedAt, evidence_code: code, http_status: httpStatus } = value;
  const { outcome, platform, source_identity: sourceIdentity } = value;
  if (typeof platform !== 'string' || platform.length < 1 || platform.length > 64) {
    throw new DomainInvariantError('invalid_observation', 'Observation platform is invalid');
  }
  if (typeof sourceIdentity !== 'string' || sourceIdentity.length === 0) {
    throw new DomainInvariantError('invalid_observation', 'Observation identity is invalid');
  }
  if (!isEvidenceOutcome(outcome) || !isEvidenceCode(code)) {
    throw new DomainInvariantError('invalid_observation', 'Observation evidence is unsupported');
  }
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) {
    throw new DomainInvariantError('invalid_observation', 'Observation timestamp is invalid');
  }
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || (httpStatus as number) < 100 || (httpStatus as number) > 599)
  ) {
    throw new DomainInvariantError('invalid_observation', 'Observation HTTP status is invalid');
  }
  assertEvidenceConsistency(outcome, code);
  return {
    platform,
    source_identity: sourceIdentity,
    outcome,
    evidence_code: code,
    checked_at: checkedAt,
    http_status: httpStatus as number | null,
  };
}

export function emptyRunSummary(): RunSummary {
  return {
    checked: 0,
    open: 0,
    likely_closed: 0,
    closed: 0,
    uncertain: 0,
    unchecked: 0,
    newly_closed: 0,
    reopened: 0,
    failed: 0,
  };
}
