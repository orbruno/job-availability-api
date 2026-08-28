import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter } from '../../src/api/rate-limiter.js';
import type {
  IdempotencyAdmission,
  IdempotencyRecord,
  IdempotencyRepository,
} from '../../src/application/idempotency-store.js';
import {
  authHeaders,
  createServiceHarness,
  StubSafeFetcher,
  TEST_TOKEN,
} from '../helpers/service-harness.js';

type ApiResponse = {
  response: Response;
  body: Record<string, unknown>;
};

const closeHandlers: (() => Promise<void>)[] = [];
afterEach(async () => await Promise.all(closeHandlers.splice(0).map(async (close) => await close())));

async function api(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, unknown> };
}

function postHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': key, ...extra });
}

type RawHttpResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
};

async function rawHttp(baseUrl: string, request: string): Promise<RawHttpResponse> {
  const target = new URL(baseUrl);
  const port = Number(target.port);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const socket = createConnection({ host: target.hostname, port });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error('Raw HTTP response timed out.'));
    });
    socket.once('connect', () => socket.end(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', (error) => {
      if (chunks.length > 0) finish();
      else reject(error);
    });
  });
  const separator = bytes.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('Raw HTTP response had no header terminator.');
  const headerText = bytes.subarray(0, separator).toString('latin1');
  const lines = headerText.split('\r\n');
  const statusMatch = /^HTTP\/1\.1 (\d{3})\b/u.exec(lines.shift() ?? '');
  if (statusMatch?.[1] === undefined) throw new Error('Raw HTTP response had no status.');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(statusMatch[1]),
    headers,
    body: bytes.subarray(separator + 4).toString('utf8'),
  };
}

function rawProblem(response: RawHttpResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

class FailFirstIdempotencyWrite implements IdempotencyRepository {
  public failed = false;

  public constructor(private readonly delegate: IdempotencyRepository) {}

  public readIdempotency(digest: string): Promise<IdempotencyRecord | null> {
    return this.delegate.readIdempotency(digest);
  }

  public writeIdempotency(record: IdempotencyRecord): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error('injected idempotency persistence failure'));
    }
    return this.delegate.writeIdempotency(record);
  }

  public readIdempotencyAdmission(digest: string): Promise<IdempotencyAdmission | null> {
    return this.delegate.readIdempotencyAdmission(digest);
  }

  public writeIdempotencyAdmission(record: IdempotencyAdmission): Promise<void> {
    return this.delegate.writeIdempotencyAdmission(record);
  }

  public pruneIdempotency(referenceTime: number): Promise<number> {
    return this.delegate.pruneIdempotency(referenceTime);
  }
}

describe('complete version 1 API surface', () => {
  it('authenticates the credential test without exposing token or product data', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const missing = await api(harness.baseUrl, '/v1/credentials/test');
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get('www-authenticate')).toBe('Bearer');
    expect(JSON.stringify(missing.body)).not.toContain(TEST_TOKEN);
    const invalid = await api(harness.baseUrl, '/v1/credentials/test', {
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(invalid.response.status).toBe(401);
    const ready = await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() });
    expect(ready.response.status).toBe(200);
    expect(ready.body).toEqual({ schema_version: 1, service_version: '0.1.0', ready: true });
    expect(ready.response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]+$/u);
  });

  it('executes and validates all nine routes', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);

    const observed = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST',
      headers: postHeaders('observe-1'),
      body: JSON.stringify({
        schema_version: 1,
        platform: 'example',
        url: 'https://example.com/jobs/one',
        expected_title: 'Data Engineer',
        expected_company: 'Acme',
      }),
    });
    expect(observed.response.status).toBe(200);
    expect(observed.body.observation).toMatchObject({ evidence_code: 'apply_action_present' });

    const created = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST',
      headers: postHeaders('create-1'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    expect(created.response.status).toBe(201);
    const runId = String(created.body.run_id);

    const run = await api(harness.baseUrl, `/v1/availability/runs/${runId}`, { headers: authHeaders() });
    expect(run.response.status).toBe(200);
    expect(run.body).toMatchObject({ run_id: runId, pending_count: 1, job_count: 1 });

    const before = await api(harness.baseUrl, '/v1/jobs/job-one/availability', { headers: authHeaders() });
    expect(before.body).toMatchObject({ status: 'unchecked', sources: [] });

    const checked = await api(harness.baseUrl, `/v1/availability/runs/${runId}/jobs/job-one/check`, {
      method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'check-1' }),
    });
    expect(checked.response.status).toBe(200);
    expect(checked.body).toMatchObject({ run_id: runId, job_id: 'job-one', before: 'unchecked', after: 'open' });

    const after = await api(harness.baseUrl, '/v1/jobs/job-one/availability', { headers: authHeaders() });
    expect(after.body).toMatchObject({ status: 'open', sources_truncated: false });

    const finalized = await api(harness.baseUrl, `/v1/availability/runs/${runId}/finalize`, {
      method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'finalize-1' }),
    });
    expect(finalized.body).toMatchObject({ status: 'completed' });

    const scheduled = await api(harness.baseUrl, '/v1/availability/runs/scheduled', {
      method: 'POST', headers: postHeaders('scheduled-1'), body: JSON.stringify({ schema_version: 1 }),
    });
    expect(scheduled.response.status).toBe(201);
    expect(scheduled.body).toMatchObject({ trigger: 'schedule', job_count: 1 });

    const cancelled = await api(
      harness.baseUrl,
      `/v1/availability/runs/${String(scheduled.body.run_id)}/cancel`,
      { method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'cancel-1' }) },
    );
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
  });

  it('replays stateless observation without repeating the fetch and conflicts globally', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const body = JSON.stringify({
      schema_version: 1, platform: 'example', url: 'https://example.com/jobs/one',
      expected_title: 'Data Engineer', expected_company: 'Acme',
    });
    const first = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST', headers: postHeaders('global-key'), body,
    });
    const replay = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST', headers: postHeaders('global-key'), body,
    });
    expect(first.response.headers.get('idempotency-replayed')).toBe('false');
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(harness.fetcher.calls).toBe(1);

    const conflict = await api(harness.baseUrl, '/v1/availability/runs/scheduled', {
      method: 'POST', headers: postHeaders('global-key'), body: JSON.stringify({ schema_version: 1 }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe('idempotency_conflict');
  });

  it('makes concurrent same-key HTTP duplicates wait for one committed result', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const request = (): Promise<ApiResponse> => api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST',
      headers: postHeaders('concurrent-observe'),
      body: JSON.stringify({
        schema_version: 1, platform: 'example', url: 'https://example.com/jobs/one',
        expected_title: 'Data Engineer', expected_company: 'Acme',
      }),
    });
    const [left, right] = await Promise.all([request(), request()]);
    expect(left.body).toEqual(right.body);
    expect([
      left.response.headers.get('idempotency-replayed'),
      right.response.headers.get('idempotency-replayed'),
    ].sort()).toEqual(['false', 'true']);
    expect(harness.fetcher.calls).toBe(1);
  });

  it('persists admitted domain problems and regenerates only transport request correlation on replay', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const first = await api(harness.baseUrl, '/v1/availability/runs/missing-run/cancel', {
      method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'missing-cancel' }),
    });
    const replay = await api(harness.baseUrl, '/v1/availability/runs/missing-run/cancel', {
      method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'missing-cancel' }),
    });
    expect(first.response.status).toBe(404);
    expect(replay.response.status).toBe(404);
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body).toMatchObject({ code: 'not_found', status: 404 });
    expect(replay.body.request_id).toBe(replay.response.headers.get('x-request-id'));
    expect(replay.body.request_id).not.toBe(first.body.request_id);
    expect({ ...replay.body, request_id: first.body.request_id, instance: first.body.instance })
      .toEqual(first.body);
  });

  it('retries a committed run safely after the first idempotency-record write fails', async () => {
    const harness = await createServiceHarness();
    await harness.server.close();
    const failFirst = new FailFirstIdempotencyWrite(harness.repository);
    const replacement = await createServiceHarness({ idempotencyRepository: failFirst });
    closeHandlers.push(replacement.close, harness.close);
    const request = (): Promise<ApiResponse> => api(replacement.baseUrl, '/v1/availability/runs', {
      method: 'POST', headers: postHeaders('durable-write-failure'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    const failed = await request();
    expect(failed.response.status).toBe(500);
    const retried = await request();
    expect(retried.response.status).toBe(201);
    const replayed = await request();
    expect(replayed.response.headers.get('idempotency-replayed')).toBe('true');
    expect(replayed.body).toEqual(retried.body);
    await expect(replacement.repository.listRuns()).resolves.toHaveLength(1);
  });

  it('maps schema-invalid persisted state to the contract 503 problem', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const created = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST',
      headers: postHeaders('corrupt-run-create'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    const runId = String(created.body.run_id);
    await writeFile(join(harness.root, 'availability', 'runs', runId, 'run.json'), '{"schema_version":1}\n');
    const response = await api(harness.baseUrl, `/v1/availability/runs/${runId}`, {
      headers: authHeaders(),
    });
    expect(response.response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'service_unavailable', status: 503 });
  });

  it('persists and replays a committed per-job failure without a second mutation', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const created = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST',
      headers: postHeaders('failure-run-create'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    const runId = String(created.body.run_id);
    await writeFile(join(harness.root, 'jobs', 'job-one', 'metadata.json'), '{"title":');
    const check = (): Promise<ApiResponse> => api(
      harness.baseUrl,
      `/v1/availability/runs/${runId}/jobs/job-one/check`,
      { method: 'POST', headers: authHeaders({ 'Idempotency-Key': 'committed-check-failure' }) },
    );
    const first = await check();
    const replay = await check();
    expect(first.response.status).toBe(503);
    expect(replay.response.status).toBe(503);
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body).toMatchObject({ code: 'service_unavailable', status: 503 });
    await expect(harness.repository.requireRun(runId)).resolves.toMatchObject({
      processed_job_ids: ['job-one'],
      pending_job_ids: [],
      errors: [expect.objectContaining({ job_id: 'job-one' })],
    });
    expect(harness.fetcher.calls).toBe(0);
  });
});

describe('HTTP trust boundaries', () => {
  it('enforces media type, schema, unknown fields, bodyless semantics, and idempotency header', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const unsupported = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'text/plain', 'Idempotency-Key': 'media' }), body: '{}',
    });
    expect(unsupported.response.status).toBe(415);
    expect(unsupported.body.code).toBe('unsupported_media_type');

    const embeddedCredentials = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST',
      headers: postHeaders('embedded-credentials'),
      body: JSON.stringify({
        schema_version: 1,
        platform: 'example',
        url: 'https://operator:secret@example.com/jobs/one',
        expected_title: 'Data Engineer',
        expected_company: 'Acme',
      }),
    });
    expect(embeddedCredentials.response.status).toBe(400);
    expect(embeddedCredentials.body.code).toBe('invalid_request');
    expect(harness.fetcher.calls).toBe(0);

    const malformedUtf8 = Buffer.concat([
      Buffer.from('{"schema_version":1,"platform":"example","url":"https://example.com/jobs/one","expected_title":"'),
      Buffer.from([0xc3]),
      Buffer.from('"}'),
    ]);
    const invalidEncoding = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST',
      headers: postHeaders('invalid-utf8'),
      body: malformedUtf8,
    });
    expect(invalidEncoding.response.status).toBe(400);
    expect(invalidEncoding.body.code).toBe('invalid_request');
    expect(harness.fetcher.calls).toBe(0);

    const unknown = await api(harness.baseUrl, '/v1/availability/runs/scheduled', {
      method: 'POST', headers: postHeaders('unknown'), body: JSON.stringify({ schema_version: 1, job_ids: [] }),
    });
    expect(unknown.response.status).toBe(400);

    const missingKey = await api(harness.baseUrl, '/v1/availability/runs/scheduled', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ schema_version: 1 }),
    });
    expect(missingKey.response.status).toBe(400);

    const run = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST', headers: postHeaders('bodyless-run'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    const nonEmpty = await api(harness.baseUrl, `/v1/availability/runs/${String(run.body.run_id)}/cancel`, {
      method: 'POST', headers: postHeaders('bodyless-cancel'), body: '{}',
    });
    expect(nonEmpty.response.status).toBe(400);
    expect(nonEmpty.body.code).toBe('invalid_request');
  });

  it('enforces the 256-KiB raw bound and UTF-8 identifier byte bound', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const oversized = await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST', headers: postHeaders('oversized'), body: 'x'.repeat(256 * 1024 + 1),
    });
    expect(oversized.response.status).toBe(413);
    expect(oversized.body.code).toBe('payload_too_large');

    const multibyte = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST', headers: postHeaders('multibyte'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['é'.repeat(128)], trigger: 'manual' }),
    });
    expect(multibyte.response.status).toBe(400);
    expect(multibyte.body.code).toBe('invalid_request');
  });

  it('returns bounded problem documents for parser, framing, and header limits', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const host = new URL(harness.baseUrl).host;
    const tooManyHeaders = Array.from(
      { length: 65 },
      (_, index) => `X-Bounded-${String(index)}: value`,
    );
    const requests = [
      [
        'malformed header',
        [
          'GET /v1/credentials/test HTTP/1.1',
          `Host: ${host}`,
          'Invalid Header: value',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      ],
      [
        'oversized header',
        [
          'GET /v1/credentials/test HTTP/1.1',
          `Host: ${host}`,
          `X-Oversized: ${'boundary-marker-'.repeat(1_200)}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      ],
      [
        'duplicate content length',
        [
          'POST /v1/availability/runs/scheduled HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${TEST_TOKEN}`,
          'Content-Type: application/json',
          'Idempotency-Key: duplicate-framing',
          'Content-Length: 20',
          'Content-Length: 20',
          'Connection: close',
          '',
          '{"schema_version":1}',
        ].join('\r\n'),
      ],
      [
        'parsed header count',
        [
          'GET /v1/credentials/test HTTP/1.1',
          `Host: ${host}`,
          `Authorization: Bearer ${TEST_TOKEN}`,
          ...tooManyHeaders,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      ],
    ] as const;

    for (const [label, request] of requests) {
      const response = await rawHttp(harness.baseUrl, request);
      const problem = rawProblem(response);
      expect(response.status, label).toBe(400);
      expect(response.headers['content-type'], label).toContain('application/problem+json');
      expect(response.headers['cache-control'], label).toBe('no-store');
      expect(response.headers['x-content-type-options'], label).toBe('nosniff');
      expect(response.headers['x-request-id'], label).toMatch(/^[A-Za-z0-9._-]{1,128}$/u);
      expect(Buffer.byteLength(response.body), label).toBeLessThan(1_024);
      expect(problem, label).toMatchObject({
        status: 400,
        code: 'invalid_request',
        request_id: response.headers['x-request-id'],
      });
      expect(response.body, label).not.toContain('boundary-marker-boundary-marker');
      expect(response.body, label).not.toContain(TEST_TOKEN);
    }
  });

  it('rejects duplicate security headers before authentication or mutation', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const host = new URL(harness.baseUrl).host;
    const body = '{"schema_version":1}';
    const get = (headers: readonly string[]): string => [
      'GET /v1/credentials/test HTTP/1.1',
      `Host: ${host}`,
      ...headers,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    const post = (headers: readonly string[]): string => [
      'POST /v1/availability/runs/scheduled HTTP/1.1',
      `Host: ${host}`,
      `Authorization: Bearer ${TEST_TOKEN}`,
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      ...headers,
      'Connection: close',
      '',
      body,
    ].join('\r\n');
    const requests = [
      ['authorization', get([
        `Authorization: Bearer ${TEST_TOKEN}`,
        `authorization: Bearer ${randomBytes(32).toString('base64url')}`,
      ])],
      ['host', [
        'GET /v1/credentials/test HTTP/1.1',
        `Host: ${host}`,
        'host: service.invalid',
        `Authorization: Bearer ${TEST_TOKEN}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n')],
      ['execution correlation', get([
        `Authorization: Bearer ${TEST_TOKEN}`,
        'X-N8N-Execution-Id: execution-one',
        'x-n8n-execution-id: execution-two',
      ])],
      ['content type', post([
        'Content-Type: application/json',
        'content-type: text/plain',
        'Idempotency-Key: duplicate-content-type',
      ])],
      ['idempotency key', post([
        'Content-Type: application/json',
        'Idempotency-Key: duplicate-key-one',
        'idempotency-key: duplicate-key-two',
      ])],
    ] as const;

    for (const [label, request] of requests) {
      const response = await rawHttp(harness.baseUrl, request);
      expect(response.status, label).toBe(400);
      expect(response.headers['x-request-id'], label).toMatch(/^[A-Za-z0-9._-]{1,128}$/u);
      expect(rawProblem(response), label).toMatchObject({
        status: 400,
        code: 'invalid_request',
        request_id: response.headers['x-request-id'],
      });
    }
    await expect(harness.repository.listRuns()).resolves.toEqual([]);
  });

  it('configures bounded connection and request parsing timeouts', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    expect(harness.server.server.headersTimeout).toBe(5_000);
    expect(harness.server.server.requestTimeout).toBe(20_000);
    expect(harness.server.server.keepAliveTimeout).toBe(5_000);
    expect(harness.server.server.maxConnections).toBe(64);
  });

  it('validates optional execution correlation and keeps every problem bounded', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    const invalid = await api(harness.baseUrl, '/v1/credentials/test', {
      headers: authHeaders({ 'X-N8N-Execution-Id': 'contains a space' }),
    });
    expect(invalid.response.status).toBe(400);
    expect(String(invalid.body.detail).length).toBeLessThanOrEqual(500);
    expect(invalid.body.request_id).toBe(invalid.response.headers.get('x-request-id'));

    const valid = await api(harness.baseUrl, '/v1/credentials/test', {
      headers: authHeaders({ 'X-N8N-Execution-Id': 'exec-123' }),
    });
    expect(valid.response.status).toBe(200);
    expect(harness.signals.at(-1)).toMatchObject({ n8n_execution_id: 'exec-123' });
  });

  it('auth failures cannot consume the bounded authenticated-operator bucket', async () => {
    const harness = await createServiceHarness({ rateLimiter: new FixedWindowRateLimiter(2, 60_000) });
    closeHandlers.push(harness.close);
    await api(harness.baseUrl, '/v1/credentials/test', { headers: { Authorization: 'Bearer invalid' } });
    expect((await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() })).response.status).toBe(200);
    expect((await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() })).response.status).toBe(200);
    const limited = await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() });
    expect(limited.response.status).toBe(429);
  });

  it('bounds limiter state under adversarial caller keys', () => {
    const limiter = new FixedWindowRateLimiter(10, 60_000, () => 1_000, 32);
    for (let index = 0; index < 10_000; index += 1) limiter.consume(`caller-${String(index)}`);
    expect(limiter.bucketCount).toBe(32);
  });
});

describe('token lifecycle and privacy-safe signals', () => {
  it('correlates created/check runs and aggregates source retry telemetry', async () => {
    const fetcher = new StubSafeFetcher({
      attempts: [
        {
          kind: 'response', status: 503, resolved_url: 'https://example.com/jobs/one',
          body: '', decoded_body_bytes: 0,
        },
        {
          kind: 'response', status: 200, resolved_url: 'https://example.com/jobs/one',
          body: 'Data Engineer Acme Apply now', decoded_body_bytes: 28,
        },
      ],
      retryCount: 1,
    });
    const harness = await createServiceHarness({ fetcher });
    closeHandlers.push(harness.close);
    const created = await api(harness.baseUrl, '/v1/availability/runs', {
      method: 'POST',
      headers: postHeaders('telemetry-create'),
      body: JSON.stringify({ schema_version: 1, job_ids: ['job-one'], trigger: 'manual' }),
    });
    const runId = String(created.body.run_id);
    expect(harness.signals.at(-1)).toMatchObject({ operation: 'create-run', run_id: runId });
    await api(harness.baseUrl, `/v1/availability/runs/${runId}/jobs/job-one/check`, {
      method: 'POST',
      headers: authHeaders({ 'Idempotency-Key': 'telemetry-check' }),
    });
    expect(harness.signals.at(-1)).toMatchObject({
      operation: 'check-job',
      run_id: runId,
      retry_count: 1,
      source_count: 1,
    });
  });

  it('makes the former token invalid immediately after a configured rotation', async () => {
    const replacement = randomBytes(32).toString('base64url');
    const harness = await createServiceHarness({ token: replacement });
    closeHandlers.push(harness.close);
    const revoked = await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() });
    expect(revoked.response.status).toBe(401);
    const current = await api(harness.baseUrl, '/v1/credentials/test', {
      headers: { Authorization: `Bearer ${replacement}` },
    });
    expect(current.response.status).toBe(200);
    expect(JSON.stringify(current.body)).not.toContain(replacement);
  });

  it('keeps processing successful when telemetry throws', async () => {
    const harness = await createServiceHarness({ telemetryThrows: true });
    closeHandlers.push(harness.close);
    const response = await api(harness.baseUrl, '/v1/credentials/test', { headers: authHeaders() });
    expect(response.response.status).toBe(200);
  });

  it('emits only the bounded signal allowlist with no request secrets', async () => {
    const harness = await createServiceHarness();
    closeHandlers.push(harness.close);
    await api(harness.baseUrl, '/v1/postings/observe', {
      method: 'POST',
      headers: postHeaders('signal-key', { 'X-N8N-Execution-Id': 'exec-safe' }),
      body: JSON.stringify({
        schema_version: 1, platform: 'example', url: 'https://example.com/jobs/one',
        expected_title: 'Private Title', expected_company: 'Private Company',
      }),
    });
    const serialized = JSON.stringify(harness.signals.at(-1));
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('Private Title');
    expect(serialized).not.toContain('Private Company');
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(Object.keys(harness.signals.at(-1) ?? {}).sort()).toEqual([
      'duration_ms', 'evidence_code_counts', 'n8n_execution_id', 'operation', 'owner_key',
      'request_id', 'result_status', 'retry_count', 'source_count',
    ]);
  });
});
