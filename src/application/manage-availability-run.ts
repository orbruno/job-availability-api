import { randomBytes } from 'node:crypto';

import {
  applyObservations,
} from '../domain/availability-state.js';
import {
  classifyAvailability,
  type ClassificationInput,
} from '../domain/classify-availability.js';
import {
  type AvailabilityRun,
  type AvailabilityState,
  type AvailabilityStatus,
  type SourceObservation,
  DomainInvariantError,
  emptyRunSummary,
} from '../domain/availability-contracts.js';
import {
  cancelRun,
  finalizeRun,
  pruneFinalizedRuns,
  recordJobFailure,
  recordJobSuccess,
  stableDeduplicate,
  startRun,
} from '../domain/run-state.js';
import { sourceIdentity } from '../domain/source-identity.js';
import { SafeFetcher } from '../infrastructure/http/safe-fetch.js';
import {
  CheckCommitPendingError,
  FileAvailabilityRepository,
  type JobMetadata,
  type PerJobEvidence,
} from '../infrastructure/persistence/file-availability-repository.js';
import { MutationCoordinator } from './mutation-coordinator.js';
import type { IdempotencyOperationContext } from './idempotency-store.js';
import { ServiceError, serviceError } from './service-error.js';

export const SERVICE_VERSION = '0.1.0';
const PUBLIC_SOURCE_LIMIT = 20;
const PUBLIC_RUN_COLLECTION_LIMIT = 100;

export type PublicSourceEvidence = {
  platform: string | null;
  outcome: SourceObservation['outcome'] | null;
  evidence_code: SourceObservation['evidence_code'] | null;
  checked_at: string | null;
  http_status: number | null;
};

export type PublicRun = {
  schema_version: 1;
  run_id: string;
  status: AvailabilityRun['status'];
  trigger: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  job_count: number;
  pending_count: number;
  processed_count: number;
  error_count: number;
  summary: AvailabilityRun['summary'];
  pending_job_ids: string[];
  pending_job_ids_truncated: boolean;
  processed_job_ids: string[];
  processed_job_ids_truncated: boolean;
  errors: { job_id: string | null; code: string; occurred_at: string }[];
  errors_truncated: boolean;
};

export type PublicJobAvailability = {
  schema_version: 1;
  job_id: string;
  status: AvailabilityStatus;
  last_checked_at: string | null;
  last_run_id: string | null;
  closure_run_ids: string[];
  sources: PublicSourceEvidence[];
  sources_truncated: boolean;
};

export type ObservePostingRequest = {
  schema_version: 1;
  platform: string;
  url: string;
  expected_title: string;
  expected_company?: string;
};

export type CheckJobResponse = {
  schema_version: 1;
  run_id: string;
  job_id: string;
  before: AvailabilityStatus;
  after: AvailabilityStatus;
  checked_at: string;
  sources: PublicSourceEvidence[];
  sources_truncated: boolean;
};

export type CheckJobOperationResult = CheckJobResponse & {
  retry_count: number;
};

export type ServiceClock = {
  now: () => Date;
};

type CheckAdmission =
  | { existing: CheckJobOperationResult; metadata: null; failure: null }
  | { existing: null; metadata: JobMetadata; failure: null }
  | { existing: null; metadata: null; failure: unknown };

function utc(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function projectSources(sources: readonly SourceObservation[]): {
  sources: PublicSourceEvidence[];
  sources_truncated: boolean;
} {
  const ordered = sources
    .map((source, index) => ({ source, index, time: Date.parse(source.checked_at) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.time);
      const rightValid = Number.isFinite(right.time);
      if (leftValid && rightValid && left.time !== right.time) return right.time - left.time;
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      return left.index - right.index;
    });
  return {
    sources: ordered.slice(0, PUBLIC_SOURCE_LIMIT).map(({ source }) => ({
      platform: source.platform,
      outcome: source.outcome,
      evidence_code: source.evidence_code,
      checked_at: utc(source.checked_at) ?? null,
      http_status: source.http_status,
    })),
    sources_truncated: ordered.length > PUBLIC_SOURCE_LIMIT,
  };
}

export function projectRun(run: AvailabilityRun): PublicRun {
  const createdAt = utc(run.created_at);
  if (createdAt === null) throw serviceError(503, 'service_unavailable', 'Persisted run time is invalid.');
  const recentProcessed = run.processed_job_ids.slice(-PUBLIC_RUN_COLLECTION_LIMIT);
  const recentErrors = run.errors.slice(-PUBLIC_RUN_COLLECTION_LIMIT).map((error) => ({
    job_id: error.job_id.length === 0 ? null : error.job_id,
    code: /^[a-z][a-z0-9_]{0,63}$/u.test(error.code) ? error.code : 'internal_error',
    occurred_at: utc(error.occurred_at ?? run.completed_at ?? run.created_at) ?? new Date(0).toISOString(),
  }));
  return {
    schema_version: 1,
    run_id: run.run_id,
    status: run.status,
    trigger: run.trigger,
    created_at: createdAt,
    started_at: utc(run.started_at),
    completed_at: utc(run.completed_at),
    job_count: run.job_ids.length,
    pending_count: run.pending_job_ids.length,
    processed_count: run.processed_job_ids.length,
    error_count: run.errors.length,
    summary: { ...run.summary },
    pending_job_ids: run.pending_job_ids.slice(0, PUBLIC_RUN_COLLECTION_LIMIT),
    pending_job_ids_truncated: run.pending_job_ids.length > PUBLIC_RUN_COLLECTION_LIMIT,
    processed_job_ids: recentProcessed,
    processed_job_ids_truncated: run.processed_job_ids.length > PUBLIC_RUN_COLLECTION_LIMIT,
    errors: recentErrors,
    errors_truncated: run.errors.length > PUBLIC_RUN_COLLECTION_LIMIT,
  };
}

export function projectJobAvailability(state: AvailabilityState): PublicJobAvailability {
  const projected = projectSources(state.sources);
  return {
    schema_version: 1,
    job_id: state.job_id,
    status: state.status,
    last_checked_at: utc(state.last_checked_at),
    last_run_id: state.last_run_id,
    closure_run_ids: [...state.closure_run_ids],
    ...projected,
  };
}

function issueRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z');
  return `availability-${stamp}-${randomBytes(6).toString('hex')}`;
}

function pendingRun(runId: string, trigger: string, jobIds: string[], at: string): AvailabilityRun {
  return {
    schema_version: 1,
    run_id: runId,
    status: 'pending',
    trigger,
    created_at: at,
    started_at: null,
    completed_at: null,
    job_ids: [...jobIds],
    pending_job_ids: [...jobIds],
    processed_job_ids: [],
    errors: [],
    summary: emptyRunSummary(),
  };
}

export class AvailabilityService {
  readonly #coordinator: MutationCoordinator;
  readonly #clock: ServiceClock;
  readonly #checks = new Map<string, Promise<CheckJobOperationResult>>();

  public constructor(
    private readonly repository: FileAvailabilityRepository,
    private readonly fetcher: SafeFetcher,
    options: { coordinator?: MutationCoordinator; clock?: ServiceClock } = {},
  ) {
    this.#coordinator = options.coordinator ?? new MutationCoordinator();
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  public async observe(request: ObservePostingRequest): Promise<{
    schema_version: 1;
    service_version: string;
    duration_ms: number;
    observation: PublicSourceEvidence;
    retry_count: number;
  }> {
    const started = this.#clock.now().getTime();
    const classification = await this.#classify({
      platform: request.platform,
      url: request.url,
      expected_title: request.expected_title,
      ...(request.expected_company === undefined ? {} : { expected_company: request.expected_company }),
    });
    const projected = projectSources([classification.observation]).sources[0];
    if (projected === undefined) throw serviceError(500, 'internal_error', 'Observation projection failed.');
    return {
      schema_version: 1,
      service_version: SERVICE_VERSION,
      duration_ms: Math.min(60_000, Math.max(0, this.#clock.now().getTime() - started)),
      observation: projected,
      retry_count: classification.retryCount,
    };
  }

  public async createRun(
    requestedJobIds: readonly string[],
    trigger: string,
    operationIdentity?: IdempotencyOperationContext,
  ): Promise<PublicRun> {
    if (requestedJobIds.length < 1 || requestedJobIds.length > 100) {
      throw serviceError(400, 'invalid_request', 'A manual run requires between 1 and 100 requested jobs.');
    }
    const canonical = await this.repository.resolveJobIds(requestedJobIds);
    const jobIds = stableDeduplicate(canonical);
    if (jobIds.length === 0 || jobIds.length > 100) {
      throw serviceError(400, 'invalid_request', 'A manual run requires between 1 and 100 jobs.');
    }
    return await this.#create(jobIds, trigger, operationIdentity);
  }

  public async canonicalJobId(requestedJobId: string): Promise<string> {
    return await this.repository.resolveJobId(requestedJobId);
  }

  public async canonicalJobIds(requestedJobIds: readonly string[]): Promise<string[]> {
    return stableDeduplicate(await this.repository.resolveJobIds(requestedJobIds));
  }

  public async createScheduledRun(operationIdentity?: IdempotencyOperationContext): Promise<PublicRun> {
    const inventory = stableDeduplicate(await this.repository.inventory());
    if (inventory.length === 0) throw serviceError(409, 'no_jobs_available', 'No canonical jobs are available.');
    if (inventory.length > 1_000) {
      throw serviceError(409, 'inventory_limit_exceeded', 'The canonical inventory exceeds the scheduled-run limit.');
    }
    return await this.#create(inventory, 'schedule', operationIdentity);
  }

  public async getRun(runId: string): Promise<PublicRun> {
    return await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      return projectRun(await this.repository.requireRun(runId));
    });
  }

  public async getJobAvailability(requestedJobId: string): Promise<PublicJobAvailability> {
    const jobId = await this.repository.resolveJobId(requestedJobId);
    return await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      return projectJobAvailability(await this.repository.readAvailability(jobId));
    });
  }

  public async checkJob(runId: string, requestedJobId: string): Promise<CheckJobOperationResult> {
    const jobId = await this.repository.resolveJobId(requestedJobId);
    const key = `${runId}\u0000${jobId}`;
    const active = this.#checks.get(key);
    if (active !== undefined) return await active;
    const operation = this.#performCheck(runId, jobId);
    this.#checks.set(key, operation);
    try {
      return await operation;
    } finally {
      this.#checks.delete(key);
    }
  }

  public async finalize(runId: string): Promise<PublicRun> {
    return await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      const run = await this.repository.requireRun(runId);
      if (run.status === 'cancelled') throw serviceError(409, 'run_cancelled', 'The run is cancelled and terminal.');
      if (run.status === 'completed' || run.status === 'failed') return projectRun(run);
      if (run.pending_job_ids.length > 0) {
        throw serviceError(409, 'run_has_pending_jobs', 'The run still has pending jobs.');
      }
      const updated = finalizeRun(run, this.#clock.now().toISOString());
      await this.repository.writeRun(updated);
      return projectRun(updated);
    });
  }

  public async cancel(runId: string): Promise<PublicRun> {
    return await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      const run = await this.repository.requireRun(runId);
      if (run.status === 'cancelled') return projectRun(run);
      if (run.status === 'completed' || run.status === 'failed') {
        throw serviceError(409, 'run_terminal', 'The run is already terminal.');
      }
      const updated = cancelRun(run, this.#clock.now().toISOString());
      await this.repository.writeRun(updated);
      return projectRun(updated);
    });
  }

  public async recoverableRuns(): Promise<PublicRun[]> {
    return (await this.repository.listRuns())
      .filter((run) => run.status === 'running' || run.status === 'pending')
      .map((run) => projectRun(run));
  }

  async #create(
    jobIds: string[],
    trigger: string,
    operationIdentity?: IdempotencyOperationContext,
  ): Promise<PublicRun> {
    return await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      const now = this.#clock.now();
      await this.#prune(now.toISOString());
      let runId = operationIdentity === undefined
        ? issueRunId(now)
        : `availability-${operationIdentity.admittedAt.replace(/[-:.]/gu, '')}-${operationIdentity.keyDigest}`;
      const existing = await this.repository.readRun(runId);
      if (existing !== null) {
        if (existing.trigger === trigger && JSON.stringify(existing.job_ids) === JSON.stringify(jobIds)) {
          return projectRun(existing);
        }
        throw serviceError(409, 'idempotency_conflict', 'The durable operation identity belongs to another run.');
      }
      while (await this.repository.readRun(runId) !== null) runId = issueRunId(this.#clock.now());
      const run = startRun(pendingRun(runId, trigger, jobIds, now.toISOString()), now.toISOString());
      await this.repository.writeRun(run);
      return projectRun(run);
    });
  }

  async #performCheck(runId: string, jobId: string): Promise<CheckJobOperationResult> {
    const admission: CheckAdmission = await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      const run = await this.repository.requireRun(runId);
      if (!run.job_ids.includes(jobId)) throw serviceError(409, 'job_not_checkable', 'The job does not belong to this run.');
      if (run.status === 'cancelled') throw serviceError(409, 'run_cancelled', 'The run is cancelled and terminal.');
      if (run.processed_job_ids.includes(jobId)) {
        const evidence = await this.repository.readEvidence(runId, jobId);
        if (evidence === null) throw serviceError(503, 'service_unavailable', 'Committed run evidence is unavailable.');
        return { existing: this.#evidenceResponse(runId, evidence), metadata: null, failure: null };
      }
      if (run.status !== 'running') throw serviceError(409, 'run_terminal', 'The run is not accepting job checks.');
      try {
        return { existing: null, metadata: await this.repository.readJobMetadata(jobId), failure: null };
      } catch (failure) {
        return { existing: null, metadata: null, failure };
      }
    });
    if (admission.existing !== null) return admission.existing;
    if (admission.failure !== null) {
      await this.#recordOperationalFailure(runId, jobId);
      throw this.#committedFailure(admission.failure);
    }
    if (admission.metadata === null) {
      await this.#recordOperationalFailure(runId, jobId);
      throw serviceError(500, 'internal_error', 'The admitted job metadata is unavailable.', true);
    }

    try {
      const observed = await this.#observeMetadata(admission.metadata);
      return await this.#coordinator.runExclusive('availability-store', async () => {
        const run = await this.repository.requireRun(runId);
        if (run.status === 'cancelled') throw serviceError(409, 'run_cancelled', 'The run was cancelled before the check committed.');
        if (run.processed_job_ids.includes(jobId)) {
          const existing = await this.repository.readEvidence(runId, jobId);
          if (existing === null) throw serviceError(503, 'service_unavailable', 'Committed run evidence is unavailable.');
          return this.#evidenceResponse(runId, existing);
        }
        if (run.status !== 'running') throw serviceError(409, 'run_terminal', 'The run is not accepting job checks.');
        const beforeState = await this.repository.readAvailability(jobId);
        const afterState = applyObservations(beforeState, runId, observed.observations, {
          now: () => this.#clock.now().toISOString(),
        });
        const evidence: PerJobEvidence = {
          job_id: jobId,
          before: beforeState.status,
          after: afterState.status,
          observations: observed.observations,
        };
        const updatedRun = recordJobSuccess(run, jobId, beforeState.status, afterState.status);
        await this.repository.commitCheck(afterState, evidence, updatedRun);
        return this.#evidenceResponse(runId, evidence, observed.retryCount);
      });
    } catch (error) {
      if (error instanceof CheckCommitPendingError) {
        try {
          return await this.#coordinator.runExclusive('availability-store', async () => {
            await this.repository.recoverPreparedCheckCommits();
            const recoveredRun = await this.repository.requireRun(runId);
            if (recoveredRun.status === 'cancelled') {
              throw serviceError(409, 'run_cancelled', 'The run was cancelled during check recovery.');
            }
            const evidence = await this.repository.readEvidence(runId, jobId);
            if (evidence === null) throw serviceError(503, 'service_unavailable', 'Prepared check recovery did not produce evidence.');
            return this.#evidenceResponse(runId, evidence);
          });
        } catch (recoveryError) {
          if (recoveryError instanceof ServiceError) throw recoveryError;
          throw serviceError(503, 'service_unavailable', 'The prepared check commit requires restart recovery.');
        }
      }
      if (error instanceof ServiceError && ['run_cancelled', 'run_terminal'].includes(error.code)) throw error;
      await this.#recordOperationalFailure(runId, jobId);
      throw this.#committedFailure(error);
    }
  }

  async #observeMetadata(metadata: JobMetadata): Promise<{
    observations: SourceObservation[];
    retryCount: number;
  }> {
    const seen = new Set<string>();
    const observations: SourceObservation[] = [];
    let retryCount = 0;
    for (const source of metadata.sources) {
      const identity = sourceIdentity(source.url).canonicalUrl;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const result = await this.#classify({
        platform: source.platform,
        url: source.url,
        expected_title: metadata.title,
        ...(metadata.company === '' ? {} : { expected_company: metadata.company }),
      });
      observations.push(result.observation);
      retryCount += result.retryCount;
    }
    if (observations.length === 0) throw new DomainInvariantError('missing_sources', 'No checkable sources were found');
    return { observations: observations.slice(0, PUBLIC_SOURCE_LIMIT), retryCount };
  }

  async #classify(input: Omit<ClassificationInput, 'fetch'>): Promise<{ observation: SourceObservation; retryCount: number }> {
    const fetch = await this.fetcher.fetch(input.url);
    const result = classifyAvailability({ ...input, fetch: { attempts: fetch.attempts } }, {
      now: () => this.#clock.now().toISOString(),
    });
    return { observation: result.observation, retryCount: fetch.retryCount };
  }

  #evidenceResponse(
    runId: string,
    evidence: PerJobEvidence,
    retryCount = 0,
  ): CheckJobOperationResult {
    const projection = projectSources(evidence.observations);
    const checkedAt = projection.sources
      .map((source) => source.checked_at)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? this.#clock.now().toISOString();
    return {
      schema_version: 1,
      run_id: runId,
      job_id: evidence.job_id,
      before: evidence.before,
      after: evidence.after,
      checked_at: checkedAt,
      ...projection,
      retry_count: Math.min(PUBLIC_SOURCE_LIMIT, Math.max(0, retryCount)),
    };
  }

  async #recordOperationalFailure(runId: string, jobId: string): Promise<void> {
    await this.#coordinator.runExclusive('availability-store', async () => {
      await this.repository.recoverPreparedCheckCommits();
      const run = await this.repository.requireRun(runId);
      if (run.status === 'cancelled') {
        throw serviceError(409, 'run_cancelled', 'The run was cancelled before failure accounting committed.');
      }
      if (run.status !== 'running') {
        throw serviceError(409, 'run_terminal', 'The run is not accepting failure accounting.');
      }
      if (!run.pending_job_ids.includes(jobId)) return;
      const updated = recordJobFailure(
        run,
        jobId,
        'internal_error',
        'The job check failed within a bounded service operation.',
        this.#clock.now().toISOString(),
      );
      await this.repository.writeRun(updated);
    });
  }

  #committedFailure(error: unknown): ServiceError {
    if (error instanceof ServiceError) {
      return serviceError(error.status, error.code, error.message, true);
    }
    return serviceError(500, 'internal_error', 'The job check could not be completed.', true);
  }

  async #prune(reference: string): Promise<void> {
    const result = pruneFinalizedRuns(await this.repository.listRuns(), reference);
    for (const run of result.removed) await this.repository.removeRun(run.run_id);
  }
}
