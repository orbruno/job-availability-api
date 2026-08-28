import { describe, expect, it, vi } from 'vitest';

import {
  IdempotencyStore,
  idempotencyDigest,
  requestFingerprint,
  type IdempotencyAdmission,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from '../../src/application/idempotency-store.js';
import { MutationCoordinator } from '../../src/application/mutation-coordinator.js';

class MemoryRepository implements IdempotencyRepository {
  public readonly records = new Map<string, IdempotencyRecord>();
  public readonly admissions = new Map<string, IdempotencyAdmission>();
  public writes = 0;
  public reads = 0;
  public pruneCalls = 0;
  public failWrites = false;
  public readGate: Promise<void> | undefined;

  public async readIdempotency(digest: string): Promise<IdempotencyRecord | null> {
    this.reads += 1;
    await this.readGate;
    return this.records.get(digest) ?? null;
  }

  public writeIdempotency(record: IdempotencyRecord): Promise<void> {
    this.writes += 1;
    if (this.failWrites) return Promise.reject(new Error('persistence unavailable'));
    this.records.set(record.key_digest, structuredClone(record));
    return Promise.resolve();
  }

  public readIdempotencyAdmission(digest: string): Promise<IdempotencyAdmission | null> {
    return Promise.resolve(this.admissions.get(digest) ?? null);
  }

  public writeIdempotencyAdmission(record: IdempotencyAdmission): Promise<void> {
    this.admissions.set(record.key_digest, structuredClone(record));
    return Promise.resolve();
  }

  public pruneIdempotency(referenceTime: number): Promise<number> {
    this.pruneCalls += 1;
    let count = 0;
    for (const [digest, record] of this.records) {
      if (Date.parse(record.expires_at) <= referenceTime) {
        this.records.delete(digest);
        count += 1;
      }
    }
    for (const [digest, admission] of this.admissions) {
      if (Date.parse(admission.expires_at) <= referenceTime) {
        this.admissions.delete(digest);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

describe('idempotency store', () => {
  it('uses only a SHA-256 digest and canonicalizes object-key order', () => {
    expect(idempotencyDigest('operator-secret-key')).toMatch(/^[a-f0-9]{64}$/u);
    expect(idempotencyDigest('operator-secret-key')).not.toContain('operator-secret-key');
    expect(requestFingerprint('post', '/route', { b: 2, a: 1 }))
      .toBe(requestFingerprint('POST', '/route', { a: 1, b: 2 }));
  });

  it('publishes the in-flight entry before invoking a synchronous operation', async () => {
    const repository = new MemoryRepository();
    const store = new IdempotencyStore(repository);
    const fingerprint = requestFingerprint('POST', '/route', null);
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = async (): Promise<{ status: number; contentType: string; body: unknown }> => {
      calls += 1;
      await gate;
      return { status: 200, contentType: 'application/json', body: { ok: true } };
    };
    const first = store.execute('same-key', fingerprint, operation);
    const second = store.execute('same-key', fingerprint, operation);
    await vi.waitFor(() => expect(calls).toBe(1));
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ replayed: false }),
      expect.objectContaining({ replayed: true }),
    ]);
    expect(repository.writes).toBe(1);
  });

  it('serializes same-key admission while persisted-record reads are pending', async () => {
    const repository = new MemoryRepository();
    let releaseRead: (() => void) | undefined;
    repository.readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const store = new IdempotencyStore(repository);
    const fingerprint = requestFingerprint('POST', '/route', { value: 1 });
    let releaseOperation: (() => void) | undefined;
    const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    let calls = 0;
    const operation = async (): Promise<{ status: number; contentType: string; body: unknown }> => {
      calls += 1;
      await operationGate;
      return { status: 201, contentType: 'application/json', body: { created: true } };
    };

    const first = store.execute('slow-read-key', fingerprint, operation);
    const second = store.execute('slow-read-key', fingerprint, operation);
    await vi.waitFor(() => expect(repository.reads).toBe(1));
    releaseRead?.();
    await vi.waitFor(() => expect(calls).toBe(1));
    releaseOperation?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ replayed: false }),
      expect.objectContaining({ replayed: true }),
    ]);
    expect(calls).toBe(1);
    expect(repository.writes).toBe(1);
  });

  it('rejects a conflicting concurrent fingerprint without invoking it', async () => {
    const repository = new MemoryRepository();
    const store = new IdempotencyStore(repository);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = store.execute('same-key', requestFingerprint('POST', '/a', null), async () => {
      await gate;
      return { status: 200, contentType: 'application/json', body: {} };
    });
    await Promise.resolve();
    await expect(store.execute('same-key', requestFingerprint('POST', '/b', null), () => Promise.resolve({
      status: 200, contentType: 'application/json', body: {},
    }))).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    release?.();
    await first;
  });

  it('does not release concurrent waiters until the result record is durable', async () => {
    const repository = new MemoryRepository();
    repository.failWrites = true;
    const store = new IdempotencyStore(repository);
    const operation = (): Promise<{ status: number; contentType: string; body: unknown }> => Promise.resolve({
      status: 201, contentType: 'application/json', body: { committed: true },
    });
    const fingerprint = requestFingerprint('POST', '/runs', {});
    const first = store.execute('write-fails', fingerprint, operation);
    const waiter = store.execute('write-fails', fingerprint, operation);
    await expect(first).rejects.toThrow('persistence unavailable');
    await expect(waiter).rejects.toThrow('persistence unavailable');
    await expect(store.execute(
      'write-fails',
      requestFingerprint('POST', '/different', {}),
      operation,
    )).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });

  it('replays a stored admitted problem and expires it after 24 hours', async () => {
    const repository = new MemoryRepository();
    let now = new Date('2026-08-27T10:00:00.000Z');
    const store = new IdempotencyStore(repository, () => now);
    const fingerprint = requestFingerprint('POST', '/runs/missing/cancel', null);
    let calls = 0;
    const operation = (): Promise<{ status: number; contentType: string; body: unknown }> => {
      calls += 1;
      return Promise.resolve({
        status: 404,
        contentType: 'application/problem+json',
        body: { code: 'not_found' },
      });
    };
    await store.execute('problem-key', fingerprint, operation);
    await expect(store.execute('problem-key', fingerprint, operation)).resolves.toMatchObject({
      status: 404, replayed: true,
    });
    expect(calls).toBe(1);
    now = new Date('2026-08-28T10:00:00.001Z');
    await store.execute('problem-key', fingerprint, operation);
    expect(calls).toBe(2);
  });

  it('reuses the durable admission after a result-write failure and renews it only after expiry', async () => {
    const repository = new MemoryRepository();
    let now = new Date('2026-08-27T10:00:00.000Z');
    const store = new IdempotencyStore(repository, () => now);
    const fingerprint = requestFingerprint('POST', '/runs', { job_ids: ['job-one'] });
    const contexts: { admittedAt: string; keyDigest: string }[] = [];
    repository.failWrites = true;
    await expect(store.execute('renewable-key', fingerprint, (context) => {
      contexts.push(context);
      return Promise.resolve({ status: 201, contentType: 'application/json', body: { created: true } });
    })).rejects.toThrow('persistence unavailable');
    now = new Date('2026-08-27T10:01:00.000Z');
    await expect(store.execute('renewable-key', fingerprint, (context) => {
      contexts.push(context);
      return Promise.resolve({ status: 201, contentType: 'application/json', body: { created: true } });
    })).rejects.toThrow('persistence unavailable');
    expect(contexts[1]).toEqual(contexts[0]);

    repository.failWrites = false;
    now = new Date('2026-08-28T10:00:00.001Z');
    await store.execute('renewable-key', fingerprint, (context) => {
      contexts.push(context);
      return Promise.resolve({ status: 201, contentType: 'application/json', body: { created: true } });
    });
    expect(contexts[2]?.admittedAt).toBe('2026-08-28T10:00:00.001Z');
    expect(contexts[2]?.keyDigest).toBe(contexts[0]?.keyDigest);
  });

  it('opportunistically removes expired result and admission files in a long-running process', async () => {
    const repository = new MemoryRepository();
    let now = new Date('2026-08-27T10:00:00.000Z');
    const store = new IdempotencyStore(repository, () => now);
    const result = (): Promise<{ status: number; contentType: string; body: unknown }> => Promise.resolve({
      status: 200,
      contentType: 'application/json',
      body: { ok: true },
    });
    await store.execute('old-key', requestFingerprint('POST', '/old', null), result);
    const oldDigest = idempotencyDigest('old-key');
    expect(repository.records.has(oldDigest)).toBe(true);
    expect(repository.admissions.has(oldDigest)).toBe(true);

    now = new Date('2026-08-28T10:15:00.001Z');
    await store.execute('new-key', requestFingerprint('POST', '/new', null), result);
    expect(repository.records.has(oldDigest)).toBe(false);
    expect(repository.admissions.has(oldDigest)).toBe(false);
    expect(repository.pruneCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('mutation coordinator', () => {
  it('serializes the same key, permits another key, and evicts idle locks', async () => {
    const coordinator = new MutationCoordinator();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runExclusive('same', async () => {
      events.push('first-start');
      await gate;
      events.push('first-end');
    });
    const second = coordinator.runExclusive('same', () => { events.push('second'); return Promise.resolve(); });
    await coordinator.runExclusive('other', () => { events.push('other'); return Promise.resolve(); });
    expect(events).toEqual(['first-start', 'other']);
    release?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second']);
    expect(coordinator.activeKeyCount).toBe(0);
  });
});
