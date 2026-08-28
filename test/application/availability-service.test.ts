import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AvailabilityService, projectSources } from '../../src/application/manage-availability-run.js';
import type { SourceObservation } from '../../src/domain/availability-contracts.js';
import { SafeFetcher, type SafeFetchResult } from '../../src/infrastructure/http/safe-fetch.js';
import { FileAvailabilityRepository } from '../../src/infrastructure/persistence/file-availability-repository.js';
import {
  createTestData,
  SCHEMA_DIRECTORY,
  StubSafeFetcher,
} from '../helpers/service-harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup())));

class ControlledFetcher extends SafeFetcher {
  public started: Promise<void>;
  readonly #markStarted: () => void;
  public release: (() => void) | undefined;

  public constructor() {
    super({ resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) });
    let mark = (): void => undefined;
    this.started = new Promise<void>((resolve) => { mark = resolve; });
    this.#markStarted = mark;
  }

  public override async fetch(): Promise<SafeFetchResult> {
    this.#markStarted();
    await new Promise<void>((resolve) => { this.release = resolve; });
    return {
      attempts: [{
        kind: 'response', status: 200, resolved_url: 'https://example.com/jobs/one',
        body: 'Data Engineer Acme Apply now', decoded_body_bytes: 28,
      }],
      retryCount: 0,
    };
  }
}

class FailingFetcher extends SafeFetcher {
  public constructor() {
    super({ resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) });
  }

  public override fetch(): Promise<SafeFetchResult> {
    return Promise.reject(new Error('injected fetch adapter failure'));
  }
}

async function setup(fetcher: SafeFetcher = new StubSafeFetcher()): Promise<{
  root: string;
  repository: FileAvailabilityRepository;
  service: AvailabilityService;
}> {
  const data = await createTestData();
  cleanups.push(data.cleanup);
  const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
  await repository.initialize();
  return { root: data.root, repository, service: new AvailabilityService(repository, fetcher) };
}

describe('availability application service', () => {
  it('observes a stateless posting without requiring or creating a canonical job', async () => {
    const { service, repository } = await setup();
    const result = await service.observe({
      schema_version: 1,
      platform: 'example',
      url: 'https://example.com/jobs/one',
      expected_title: 'Data Engineer',
      expected_company: 'Acme',
    });
    expect(result.observation).toMatchObject({ outcome: 'open', evidence_code: 'apply_action_present' });
    await expect(repository.inventory()).resolves.toEqual(['job-one']);
  });

  it('enforces the raw 100-selection ceiling before stable deduplication', async () => {
    const { service } = await setup();
    await expect(service.createRun(Array.from({ length: 101 }, () => 'job-one'), 'manual'))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('uses the admitted key identity as a restart-safe durable create identity and renews after expiry', async () => {
    const { service, repository } = await setup();
    const digest = 'a'.repeat(64);
    const firstAdmission = {
      keyDigest: digest,
      fingerprint: 'b'.repeat(64),
      admittedAt: '2026-08-27T10:00:00.000Z',
      expiresAt: '2026-08-28T10:00:00.000Z',
    };
    const first = await service.createRun(['job-one'], 'manual', firstAdmission);
    const restarted = await service.createRun(['job-one'], 'manual', firstAdmission);
    expect(restarted).toEqual(first);
    expect(first.run_id).toBe(`availability-20260827T100000000Z-${digest}`);

    const renewed = await service.createRun(['job-one'], 'manual', {
      ...firstAdmission,
      admittedAt: '2026-08-28T10:00:00.001Z',
      expiresAt: '2026-08-29T10:00:00.001Z',
    });
    expect(renewed.run_id).not.toBe(first.run_id);
    await expect(repository.listRuns()).resolves.toHaveLength(2);
  });

  it('checks a job once, persists compatible evidence, and makes a domain retry fetch-free', async () => {
    const fetcher = new StubSafeFetcher();
    const { service, repository } = await setup(fetcher);
    const run = await service.createRun(['job-one'], 'manual');
    const first = await service.checkJob(run.run_id, 'job-one');
    const retry = await service.checkJob(run.run_id, 'job-one');
    expect(first).toEqual(retry);
    expect(fetcher.calls).toBe(1);
    await expect(repository.readAvailability('job-one')).resolves.toMatchObject({ status: 'open' });
    await expect(repository.requireRun(run.run_id)).resolves.toMatchObject({
      processed_job_ids: ['job-one'], pending_job_ids: [],
    });
  });

  it('keeps cancellation terminal when it wins an in-flight fetch', async () => {
    const fetcher = new ControlledFetcher();
    const { service, repository } = await setup(fetcher);
    const run = await service.createRun(['job-one'], 'manual');
    const check = service.checkJob(run.run_id, 'job-one');
    await fetcher.started;
    const cancelled = await service.cancel(run.run_id);
    fetcher.release?.();
    await expect(check).rejects.toMatchObject({ status: 409, code: 'run_cancelled' });
    expect(cancelled.status).toBe('cancelled');
    await expect(repository.requireRun(run.run_id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(repository.readAvailability('job-one')).resolves.toMatchObject({ status: 'unchecked' });
  });

  it('records a bounded per-job failure and truthfully finalizes the run as failed', async () => {
    const { service, repository } = await setup(new FailingFetcher());
    const run = await service.createRun(['job-one'], 'manual');
    await expect(service.checkJob(run.run_id, 'job-one')).rejects.toMatchObject({
      status: 500, code: 'internal_error',
    });
    await expect(repository.requireRun(run.run_id)).resolves.toMatchObject({
      pending_job_ids: [], processed_job_ids: ['job-one'], summary: { failed: 1 },
    });
    const finalized = await service.finalize(run.run_id);
    expect(finalized.status).toBe('failed');
    await expect(service.finalize(run.run_id)).resolves.toEqual(finalized);
  });

  it('accounts for corrupt metadata, continues an unrelated job, and finalizes truthfully', async () => {
    const data = await createTestData([{ slug: 'bad-job' }, { slug: 'good-job' }]);
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await repository.initialize();
    await writeFile(join(data.root, 'jobs', 'bad-job', 'metadata.json'), '{"title":');
    const fetcher = new StubSafeFetcher();
    const service = new AvailabilityService(repository, fetcher);
    const run = await service.createRun(['bad-job', 'good-job'], 'manual');

    await expect(service.checkJob(run.run_id, 'bad-job')).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
      committed: true,
    });
    await expect(service.checkJob(run.run_id, 'good-job')).resolves.toMatchObject({
      job_id: 'good-job',
      after: 'open',
    });
    await expect(repository.requireRun(run.run_id)).resolves.toMatchObject({
      pending_job_ids: [],
      processed_job_ids: ['bad-job', 'good-job'],
      errors: [expect.objectContaining({ job_id: 'bad-job', code: 'internal_error' })],
      summary: { open: 1, likely_closed: 0, closed: 0, uncertain: 0, failed: 1 },
    });
    await expect(service.finalize(run.run_id)).resolves.toMatchObject({ status: 'failed', error_count: 1 });
    expect(fetcher.calls).toBe(1);
  });

  it('serializes journal roll-forward with concurrent cancellation and never resurrects the run', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    let markPrepared = (): void => undefined;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    let interrupted = false;
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY, {
      faultInjector: (stage) => {
        if (stage === 'journal-prepared' && !interrupted) {
          interrupted = true;
          markPrepared();
          throw new Error('injected commit interruption');
        }
      },
    });
    await repository.initialize();
    const service = new AvailabilityService(repository, new StubSafeFetcher());
    const run = await service.createRun(['job-one'], 'manual');
    const check = service.checkJob(run.run_id, 'job-one');
    await prepared;
    const cancellation = service.cancel(run.run_id);
    await Promise.allSettled([check, cancellation]);
    await expect(repository.requireRun(run.run_id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(service.getRun(run.run_id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('rejects empty and over-limit scheduled inventories without truncation', async () => {
    const { root, service } = await setup();
    await writeFile(join(root, 'jobs', 'index.json'), JSON.stringify({ jobs: [] }));
    await expect(service.createScheduledRun()).rejects.toMatchObject({ code: 'no_jobs_available' });
    await writeFile(join(root, 'jobs', 'index.json'), JSON.stringify({
      jobs: Array.from({ length: 1_001 }, (_, index) => ({ slug: `job-${String(index)}` })),
    }));
    await expect(service.createScheduledRun()).rejects.toMatchObject({ code: 'inventory_limit_exceeded' });
  });

  it('creates the full 1,000-job scheduled snapshot from one validated inventory scan', async () => {
    const jobs = Array.from({ length: 1_000 }, (_, index) => ({
      slug: `job-${String(index).padStart(4, '0')}`,
    }));
    const data = await createTestData(jobs);
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await repository.initialize();
    const service = new AvailabilityService(repository, new StubSafeFetcher());
    const started = performance.now();
    const created = await service.createScheduledRun();
    const duration = performance.now() - started;
    expect(created).toMatchObject({
      status: 'running',
      trigger: 'schedule',
      job_count: 1_000,
      pending_count: 1_000,
      pending_job_ids_truncated: true,
    });
    expect(created.pending_job_ids).toHaveLength(100);
    expect(duration).toBeLessThan(10_000);
  }, 30_000);
});

describe('public evidence projection', () => {
  it('orders newest parseable timestamps first, remains stable, bounds 20, and removes identity', () => {
    const sources: SourceObservation[] = Array.from({ length: 22 }, (_, index) => ({
      platform: 'example',
      source_identity: `https://example.com/${String(index)}`,
      outcome: 'inconclusive',
      evidence_code: 'identity_unverified',
      checked_at: new Date(Date.UTC(2026, 7, 27, 10, 0, index)).toISOString(),
      http_status: 200,
    }));
    const projected = projectSources(sources);
    expect(projected.sources).toHaveLength(20);
    expect(projected.sources_truncated).toBe(true);
    expect(projected.sources[0]?.checked_at).toBe(sources[21]?.checked_at);
    expect(projected.sources[0]).not.toHaveProperty('source_identity');
  });
});
