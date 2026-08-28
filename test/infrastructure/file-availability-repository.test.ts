import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyObservations, defaultAvailabilityState } from '../../src/domain/availability-state.js';
import { emptyRunSummary, type AvailabilityRun, type SourceObservation } from '../../src/domain/availability-contracts.js';
import { recordJobSuccess, startRun } from '../../src/domain/run-state.js';
import {
  CheckCommitPendingError,
  FileAvailabilityRepository,
  resolveCanonicalJobId,
  type CheckCommitStage,
} from '../../src/infrastructure/persistence/file-availability-repository.js';
import { createTestData, SCHEMA_DIRECTORY } from '../helpers/service-harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

function run(runId = 'run-1'): AvailabilityRun {
  return startRun({
    schema_version: 1,
    run_id: runId,
    status: 'pending',
    trigger: 'manual',
    created_at: '2026-08-27T10:00:00.000Z',
    started_at: null,
    completed_at: null,
    job_ids: ['job-one'],
    pending_job_ids: ['job-one'],
    processed_job_ids: [],
    errors: [],
    summary: emptyRunSummary(),
  }, '2026-08-27T10:00:00.000Z');
}

const observation: SourceObservation = {
  platform: 'example',
  source_identity: 'https://example.com/jobs/one',
  outcome: 'open',
  evidence_code: 'jobposting_active',
  checked_at: '2026-08-27T10:01:00.000Z',
  http_status: 200,
};

describe('canonical job membership', () => {
  const inventory = ['Acme__Data-Engineer--123', 'café__Data-Engineer--123'];

  it('decodes exactly once and substitutes the exact stored NFC member', () => {
    expect(resolveCanonicalJobId('caf%C3%A9__Data-Engineer--123', inventory))
      .toBe('café__Data-Engineer--123');
  });

  it.each(['', '.', '%2e%2e', 'team/job', 'team%2Fjob', 'team%252Fjob', 'team\\job',
    'team%5Cjob', 'job%00suffix', 'job%1Fsuffix', 'job%ZZ'])(
    'rejects unsafe requested identifier %s',
    (value) => expect(() => resolveCanonicalJobId(value, [value])).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    ),
  );

  it('rejects more than 255 UTF-8 bytes', () => {
    const value = 'é'.repeat(128);
    expect(() => resolveCanonicalJobId(value, [value])).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('reports normalization collisions as storage unavailability', () => {
    expect(() => resolveCanonicalJobId('caf%C3%A9', ['café', 'café'])).toThrow(
      expect.objectContaining({ status: 503, code: 'service_unavailable' }),
    );
  });

  it('does not case-fold or NFKC-normalize', () => {
    expect(() => resolveCanonicalJobId('JOB-A', ['Job-A', 'job-a'])).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(() => resolveCanonicalJobId('ＡＢＣ', ['ABC'])).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('confined compatible repository', () => {
  it('refuses a symlinked data root before creating any child', async () => {
    const base = await mkdtemp(join(tmpdir(), 'job-availability-symlink-root-'));
    cleanups.push(async () => await rm(base, { recursive: true, force: true }));
    const target = join(base, 'target');
    const linkedRoot = join(base, 'linked-root');
    await mkdir(target);
    await symlink(target, linkedRoot);
    const repository = new FileAvailabilityRepository(linkedRoot, SCHEMA_DIRECTORY);
    await expect(repository.initialize()).rejects.toMatchObject({ status: 503 });
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it('round-trips compatible state with atomic sibling replacement', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await repository.initialize();
    const state = applyObservations(defaultAvailabilityState('job-one'), 'run-1', [observation], {
      now: () => observation.checked_at,
    });
    await repository.writeAvailability(state);
    await expect(repository.readAvailability('job-one')).resolves.toEqual(state);
    expect(JSON.parse(await readFile(join(data.root, 'jobs', 'job-one', 'availability.json'), 'utf8')))
      .toEqual(state);
    expect((await readdir(join(data.root, 'jobs', 'job-one'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('rejects unsafe slugs already present in the canonical inventory', async () => {
    const data = await createTestData([{ slug: 'safe-job' }]);
    cleanups.push(data.cleanup);
    await writeFile(join(data.root, 'jobs', 'index.json'), JSON.stringify({ jobs: [{ slug: '../escape' }] }));
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await expect(repository.inventory()).rejects.toMatchObject({ status: 503 });
  });

  it('rejects distinct inventory identifiers that resolve to one case-insensitive physical directory', async () => {
    const data = await createTestData([{ slug: 'Job-A' }, { slug: 'job-a' }]);
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    const upper = await realpath(join(data.root, 'jobs', 'Job-A'));
    const lower = await realpath(join(data.root, 'jobs', 'job-a'));
    if (upper === lower) {
      await expect(repository.inventory()).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    } else {
      await expect(repository.inventory()).resolves.toEqual(['Job-A', 'job-a']);
    }
  });

  it('rejects a symlinked job directory even when it points inside the root', async () => {
    const data = await createTestData([{ slug: 'linked-job' }]);
    cleanups.push(data.cleanup);
    const real = join(data.root, 'real-job');
    await mkdir(real);
    await writeFile(join(real, 'metadata.json'), '{}');
    await (await import('node:fs/promises')).rm(join(data.root, 'jobs', 'linked-job'), { recursive: true });
    await symlink(real, join(data.root, 'jobs', 'linked-job'));
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await expect(repository.readJobMetadata('linked-job')).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a symlinked availability file without following it', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const target = join(data.root, 'outside.json');
    await writeFile(target, '{}');
    await symlink(target, join(data.root, 'jobs', 'job-one', 'availability.json'));
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await expect(repository.readAvailability('job-one')).rejects.toMatchObject({ status: 503 });
  });

  it('excludes a second writer and releases only its own lock', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const first = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    const second = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    const lease = await first.acquireWriterLease();
    await expect(second.acquireWriterLease()).rejects.toMatchObject({ status: 503 });
    await lease.release();
    const replacement = await second.acquireWriterLease();
    await replacement.release();
  });

  it('recovers a stale same-host lock only with its exact owner confirmation', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await repository.initialize();
    const owner = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(data.root, 'availability', '.job-availability-service.lock'), JSON.stringify({
      schema_version: 1,
      owner,
      pid: 2_147_483_647,
      hostname: hostname(),
      acquired_at: '2026-08-27T10:00:00.000Z',
    }), { mode: 0o600 });
    await expect(repository.recoverStaleWriterLock('wrong-owner')).rejects.toMatchObject({ status: 503 });
    await repository.recoverStaleWriterLock(owner);
    await expect(repository.writerLockInfo()).resolves.toBeNull();
  });

  it('rejects a corrupt lock owner before deriving a recovery path', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await repository.initialize();
    const marker = join(data.root, 'marker.json');
    await writeFile(marker, '{"preserved":true}');
    await writeFile(join(data.root, 'availability', '.job-availability-service.lock'), JSON.stringify({
      schema_version: 1,
      owner: '../../marker',
      pid: 2_147_483_647,
      hostname: hostname(),
      acquired_at: '2026-08-27T10:00:00.000Z',
    }), { mode: 0o600 });
    await expect(repository.writerLockInfo()).rejects.toMatchObject({ status: 503 });
    await expect(repository.recoverStaleWriterLock('../../marker')).rejects.toMatchObject({ status: 503 });
    await expect(readFile(marker, 'utf8')).resolves.toBe('{"preserved":true}');
  });

  it('leaves a replacement writer lock intact when recovery detects a race', async () => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    const lockPath = join(data.root, 'availability', '.job-availability-service.lock');
    const originalOwner = '11111111-1111-4111-8111-111111111111';
    const replacementOwner = '22222222-2222-4222-8222-222222222222';
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY, {
      lockRecoveryFaultInjector: async () => {
        await unlink(lockPath);
        await writeFile(lockPath, JSON.stringify({
          schema_version: 1,
          owner: replacementOwner,
          pid: 2_147_483_646,
          hostname: hostname(),
          acquired_at: '2026-08-27T10:01:00.000Z',
        }), { mode: 0o600 });
      },
    });
    await repository.initialize();
    await writeFile(lockPath, JSON.stringify({
      schema_version: 1,
      owner: originalOwner,
      pid: 2_147_483_647,
      hostname: hostname(),
      acquired_at: '2026-08-27T10:00:00.000Z',
    }), { mode: 0o600 });
    await expect(repository.recoverStaleWriterLock(originalOwner)).rejects.toMatchObject({ status: 503 });
    await expect(repository.writerLockInfo()).resolves.toMatchObject({ owner: replacementOwner });
    await expect(readdir(join(data.root, 'availability'))).resolves.not.toContain(
      '.job-availability-lock-recovery',
    );
  });
});

describe('journaled check commit', () => {
  it.each<CheckCommitStage>([
    'journal-prepared',
    'availability-written',
    'evidence-written',
    'run-written',
  ])('rolls forward after a process interruption at %s', async (stage) => {
    const data = await createTestData();
    cleanups.push(data.cleanup);
    let injected = false;
    const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY, {
      faultInjector: (current) => {
        if (!injected && current === stage) {
          injected = true;
          throw new Error('injected interruption');
        }
      },
    });
    await repository.initialize();
    const before = defaultAvailabilityState('job-one');
    const after = applyObservations(before, 'run-1', [observation], { now: () => observation.checked_at });
    const updatedRun = recordJobSuccess(run(), 'job-one', 'unchecked', 'open');
    await expect(repository.commitCheck(after, {
      job_id: 'job-one', before: 'unchecked', after: 'open', observations: [observation],
    }, updatedRun)).rejects.toBeInstanceOf(CheckCommitPendingError);

    const restarted = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
    await expect(restarted.recoverPreparedCheckCommits()).resolves.toBe(1);
    await expect(restarted.readAvailability('job-one')).resolves.toMatchObject({ status: 'open', last_run_id: 'run-1' });
    await expect(restarted.requireRun('run-1')).resolves.toMatchObject({
      processed_job_ids: ['job-one'], pending_job_ids: [], status: 'running',
    });
    await expect(restarted.readEvidence('run-1', 'job-one')).resolves.toMatchObject({ after: 'open' });
    await expect(restarted.recoverPreparedCheckCommits()).resolves.toBe(0);
  });
});
