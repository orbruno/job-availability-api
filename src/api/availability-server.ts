import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { TextDecoder } from 'node:util';

import {
  AvailabilityService,
  SERVICE_VERSION,
  type ObservePostingRequest,
} from '../application/manage-availability-run.js';
import {
  assertIdempotencyKey,
  IdempotencyStore,
  type IdempotencyOperationContext,
  requestFingerprint,
  type StoredHttpResult,
} from '../application/idempotency-store.js';
import { ServiceError, serviceError } from '../application/service-error.js';
import { AvailabilitySignals } from '../infrastructure/telemetry/availability-signals.js';
import { parseSafeHttpUrl } from '../infrastructure/http/address-policy.js';
import { ServiceTokenVerifier } from './authentication.js';
import { problemDocument } from './problem.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { RuntimeSchemas, type PublicDefinition } from './runtime-schemas.js';

export const MAX_API_BODY_BYTES = 256 * 1024;

type CreateRunBody = { schema_version: 1; job_ids: string[]; trigger: string };
type ScheduledBody = { schema_version: 1 };

type RouteResult = StoredHttpResult & {
  definition: PublicDefinition;
  operation: string;
  runId?: string;
  retryCount?: number;
};

export type AvailabilityServerOptions = {
  service: AvailabilityService;
  idempotency: IdempotencyStore;
  token: string;
  schemaDirectory: string;
  signals: AvailabilitySignals;
  ownerKey?: string;
  rateLimiter?: FixedWindowRateLimiter;
};

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? undefined : value;
}

const SINGLETON_HEADERS = new Set([
  'authorization',
  'content-length',
  'content-type',
  'host',
  'idempotency-key',
  'transfer-encoding',
  'x-n8n-execution-id',
]);

function assertSingletonHeaders(request: IncomingMessage): void {
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index];
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    if (!SINGLETON_HEADERS.has(name)) continue;
    if (seen.has(name)) {
      throw serviceError(400, 'invalid_request', 'A security-relevant request header was duplicated.');
    }
    seen.add(name);
  }
}

function assertExecutionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[\x21-\x7E]{1,128}$/u.test(value)) {
    throw serviceError(400, 'invalid_request', 'The execution correlation header is invalid.');
  }
  return value;
}

function assertJsonMediaType(value: string | undefined): void {
  if (value === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value)) {
    throw serviceError(415, 'unsupported_media_type', 'The request media type must be application/json.');
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = singleHeader(request, 'content-length');
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isInteger(size) || size < 0) throw serviceError(400, 'invalid_request', 'Content-Length is invalid.');
    if (size > MAX_API_BODY_BYTES) throw serviceError(413, 'payload_too_large', 'The request body exceeds 256 KiB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_API_BODY_BYTES) throw serviceError(413, 'payload_too_large', 'The request body exceeds 256 KiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) throw serviceError(400, 'invalid_request', 'A JSON request body is required.');
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(source) as unknown;
  } catch {
    throw serviceError(400, 'invalid_request', 'The JSON request body is invalid.');
  }
}

function decodeRunId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw serviceError(400, 'invalid_request', 'The run identifier is invalid.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(decoded)) {
    throw serviceError(400, 'invalid_request', 'The run identifier is invalid.');
  }
  return decoded;
}

function evidenceCounts(body: unknown): Record<string, number> {
  if (typeof body !== 'object' || body === null) return {};
  const candidate = body as { observation?: { evidence_code?: unknown }; sources?: unknown };
  const values = candidate.observation === undefined
    ? (Array.isArray(candidate.sources) ? candidate.sources : [])
    : [candidate.observation];
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue;
    const code = (value as { evidence_code?: unknown }).evidence_code;
    if (typeof code === 'string') counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function sourceCount(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const candidate = body as { observation?: unknown; sources?: unknown };
  if (candidate.observation !== undefined) return 1;
  return Array.isArray(candidate.sources) ? candidate.sources.length : 0;
}

export class AvailabilityHttpServer {
  readonly #service: AvailabilityService;
  readonly #idempotency: IdempotencyStore;
  readonly #token: ServiceTokenVerifier;
  readonly #schemas: RuntimeSchemas;
  readonly #signals: AvailabilitySignals;
  readonly #ownerKey: string;
  readonly #rateLimiter: FixedWindowRateLimiter;
  readonly #server: Server;

  public constructor(options: AvailabilityServerOptions) {
    this.#service = options.service;
    this.#idempotency = options.idempotency;
    this.#token = new ServiceTokenVerifier(options.token);
    this.#schemas = new RuntimeSchemas(options.schemaDirectory);
    this.#signals = options.signals;
    this.#ownerKey = options.ownerKey ?? 'local-operator';
    this.#rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter();
    this.#server = createServer({
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5_000,
      requestTimeout: 20_000,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    }, (request, response) => {
      void this.#handle(request, response);
    });
    this.#server.maxHeadersCount = 0;
    this.#server.maxConnections = 64;
    this.#server.on('clientError', (_error, socket) => {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      const requestId = randomUUID();
      const body = JSON.stringify(problemDocument(
        400,
        'invalid_request',
        'The HTTP request could not be parsed within service bounds.',
        requestId,
      ));
      socket.end([
        'HTTP/1.1 400 Bad Request',
        'Connection: close',
        'Content-Type: application/problem+json; charset=utf-8',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        'X-Content-Type-Options: nosniff',
        'Cache-Control: no-store',
        `X-Request-Id: ${requestId}`,
        '',
        body,
      ].join('\r\n'));
    });
  }

  public get server(): Server {
    return this.#server;
  }

  public async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    let operation = 'unknown';
    let executionId: string | undefined;
    let runId: string | undefined;
    let retryCount = 0;
    let responseBody: unknown;
    let resultStatus = 'internal_error';
    let authenticated = false;
    try {
      if (request.rawHeaders.length / 2 > 64) {
        throw serviceError(400, 'invalid_request', 'The request contains too many headers.');
      }
      assertSingletonHeaders(request);
      this.#token.verify(singleHeader(request, 'authorization'));
      authenticated = true;
      this.#rateLimiter.consume('operator');
      executionId = assertExecutionId(singleHeader(request, 'x-n8n-execution-id'));
      const result = await this.#dispatch(request, requestId);
      operation = result.operation;
      runId = result.runId;
      retryCount = result.retryCount ?? 0;
      responseBody = result.body;
      resultStatus = result.contentType === 'application/problem+json' &&
        typeof result.body === 'object' && result.body !== null && 'code' in result.body
        ? String(result.body.code)
        : String(result.status);
      this.#schemas.assertResponse(result.definition, result.body);
      this.#send(response, result.status, result.contentType, result.body, requestId,
        request.method === 'POST' ? String((result).replayed ?? false) : undefined);
    } catch (error) {
      const service = error instanceof ServiceError
        ? error
        : serviceError(500, 'internal_error', 'The service could not complete the request.');
      const problem = problemDocument(service.status, service.code, service.message, requestId);
      responseBody = problem;
      resultStatus = service.code;
      try {
        this.#schemas.assertResponse('Problem', problem);
      } catch {
        // The problem shape is static and this fallback remains bounded.
      }
      if (service.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      this.#send(
        response,
        service.status,
        'application/problem+json',
        problem,
        requestId,
        request.method === 'POST' ? 'false' : undefined,
      );
    } finally {
      if (authenticated) this.#signals.emit({
        request_id: requestId,
        owner_key: this.#ownerKey,
        operation,
        result_status: resultStatus,
        duration_ms: Date.now() - started,
        retry_count: retryCount,
        source_count: sourceCount(responseBody),
        evidence_code_counts: evidenceCounts(responseBody),
        ...(executionId === undefined ? {} : { n8n_execution_id: executionId }),
        ...(runId === undefined ? {} : { run_id: runId }),
      });
    }
  }

  async #dispatch(request: IncomingMessage, requestId: string): Promise<RouteResult & { replayed?: boolean }> {
    const method = request.method ?? '';
    const parsed = new URL(request.url ?? '/', 'http://service.local');
    if (parsed.search !== '') throw serviceError(400, 'invalid_request', 'Query parameters are not supported.');
    const path = parsed.pathname;

    if (method === 'GET' && path === '/v1/credentials/test') {
      await this.#assertNoBody(request);
      return this.#result(200, { schema_version: 1, service_version: SERVICE_VERSION, ready: true }, 'CredentialTestResponse', 'test-credentials');
    }

    if (method === 'POST' && path === '/v1/postings/observe') {
      const body = await this.#jsonBody(request, 'ObservePostingRequest') as ObservePostingRequest;
      try {
        parseSafeHttpUrl(body.url);
      } catch {
        throw serviceError(400, 'invalid_request', 'The posting URL is invalid.');
      }
      return await this.#mutation(request, requestId, path, body, 'ObservePostingResponse', 'observe-posting', async () => {
        const observed = await this.#service.observe(body);
        const { retry_count: operationRetries, ...publicBody } = observed;
        return { status: 200, contentType: 'application/json', body: publicBody, retryCount: operationRetries };
      });
    }

    if (method === 'POST' && path === '/v1/availability/runs') {
      const body = await this.#jsonBody(request, 'CreateRunRequest') as CreateRunBody;
      const canonical = await this.#service.canonicalJobIds(body.job_ids);
      const effective = { schema_version: 1, job_ids: canonical, trigger: body.trigger };
      return await this.#mutation(request, requestId, path, effective, 'Run', 'create-run', async (context) => ({
        status: 201,
        contentType: 'application/json',
        body: await this.#service.createRun(canonical.map((jobId) => encodeURIComponent(jobId)), body.trigger, context),
      }));
    }

    if (method === 'POST' && path === '/v1/availability/runs/scheduled') {
      const body = await this.#jsonBody(request, 'CreateScheduledRunRequest') as ScheduledBody;
      return await this.#mutation(request, requestId, path, body, 'Run', 'create-scheduled-run', async (context) => ({
        status: 201,
        contentType: 'application/json',
        body: await this.#service.createScheduledRun(context),
      }));
    }

    const runGet = /^\/v1\/availability\/runs\/([^/]+)$/u.exec(path);
    if (method === 'GET' && runGet !== null) {
      await this.#assertNoBody(request);
      const runId = decodeRunId(this.#capture(runGet, 1));
      return { ...this.#result(200, await this.#service.getRun(runId), 'Run', 'get-run'), runId };
    }

    const check = /^\/v1\/availability\/runs\/([^/]+)\/jobs\/([^/]+)\/check$/u.exec(path);
    if (method === 'POST' && check !== null) {
      await this.#assertNoBody(request);
      const runId = decodeRunId(this.#capture(check, 1));
      const jobId = await this.#service.canonicalJobId(this.#capture(check, 2));
      const normalizedRoute = `/v1/availability/runs/${runId}/jobs/${jobId}/check`;
      const result = await this.#mutation(request, requestId, normalizedRoute, null, 'CheckJobResponse', 'check-job', async () => {
        const checked = await this.#service.checkJob(runId, encodeURIComponent(jobId));
        const { retry_count: operationRetries, ...body } = checked;
        return {
          status: 200,
          contentType: 'application/json',
          body,
          retryCount: operationRetries,
        };
      });
      return { ...result, runId };
    }

    const jobGet = /^\/v1\/jobs\/([^/]+)\/availability$/u.exec(path);
    if (method === 'GET' && jobGet !== null) {
      await this.#assertNoBody(request);
      return this.#result(200, await this.#service.getJobAvailability(this.#capture(jobGet, 1)), 'JobAvailability', 'get-job-availability');
    }

    const terminal = /^\/v1\/availability\/runs\/([^/]+)\/(finalize|cancel)$/u.exec(path);
    if (method === 'POST' && terminal !== null) {
      await this.#assertNoBody(request);
      const runId = decodeRunId(this.#capture(terminal, 1));
      const actionValue = this.#capture(terminal, 2);
      const action: 'finalize' | 'cancel' = actionValue === 'finalize' ? 'finalize' : 'cancel';
      const result = await this.#mutation(request, requestId, `/v1/availability/runs/${runId}/${action}`, null, 'Run', `${action}-run`, async () => ({
        status: 200,
        contentType: 'application/json',
        body: action === 'finalize' ? await this.#service.finalize(runId) : await this.#service.cancel(runId),
      }));
      return { ...result, runId };
    }

    throw serviceError(404, 'not_found', 'The requested API route was not found.');
  }

  async #jsonBody(request: IncomingMessage, definition: PublicDefinition): Promise<unknown> {
    assertJsonMediaType(singleHeader(request, 'content-type'));
    const value = parseJson(await readBody(request));
    this.#schemas.assertRequest(definition, value);
    return value;
  }

  async #assertNoBody(request: IncomingMessage): Promise<void> {
    const body = await readBody(request);
    if (body.length > 0) throw serviceError(400, 'invalid_request', 'This operation does not accept a request body.');
  }

  async #mutation(
    request: IncomingMessage,
    requestId: string,
    normalizedRoute: string,
    effectiveBody: unknown,
    definition: PublicDefinition,
    operation: string,
    execute: (context: IdempotencyOperationContext) => Promise<StoredHttpResult & { retryCount?: number }>,
  ): Promise<RouteResult & { replayed: boolean }> {
    const key = assertIdempotencyKey(singleHeader(request, 'idempotency-key'));
    const fingerprint = requestFingerprint('POST', normalizedRoute, effectiveBody);
    let retryCount = 0;
    const result = await this.#idempotency.execute(key, fingerprint, async (context) => {
      try {
        const fresh = await execute(context);
        retryCount = fresh.retryCount ?? 0;
        this.#schemas.assertResponse(definition, fresh.body);
        return { status: fresh.status, contentType: fresh.contentType, body: fresh.body };
      } catch (error) {
        if (
          !(error instanceof ServiceError) ||
          (!error.committed && (error.code === 'service_unavailable' || error.code === 'internal_error')) ||
          error.code === 'rate_limited'
        ) {
          throw error;
        }
        const problem = problemDocument(error.status, error.code, error.message, requestId);
        this.#schemas.assertResponse('Problem', problem);
        return { status: error.status, contentType: 'application/problem+json', body: problem };
      }
    });
    let body = result.body;
    if (result.contentType === 'application/problem+json' && typeof body === 'object' && body !== null) {
      body = { ...body, request_id: requestId, instance: `urn:job-availability:request:${requestId}` };
      this.#schemas.assertResponse('Problem', body);
    }
    return {
      ...result,
      body,
      definition: result.contentType === 'application/problem+json' ? 'Problem' : definition,
      operation,
      ...(typeof body === 'object' && body !== null && 'run_id' in body && typeof body.run_id === 'string'
        ? { runId: body.run_id }
        : {}),
      retryCount,
      replayed: result.replayed,
    };
  }

  #result(
    status: number,
    body: unknown,
    definition: PublicDefinition,
    operation: string,
  ): RouteResult {
    return { status, body, definition, operation, contentType: 'application/json' };
  }

  #capture(match: RegExpExecArray, index: number): string {
    const value = match[index];
    if (value === undefined) throw serviceError(400, 'invalid_request', 'The route identifier is invalid.');
    return value;
  }

  #send(
    response: ServerResponse,
    status: number,
    contentType: string,
    body: unknown,
    requestId: string,
    replayed?: string,
  ): void {
    if (response.headersSent) return;
    const serialized = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', `${contentType}; charset=utf-8`);
    response.setHeader('Content-Length', Buffer.byteLength(serialized));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Request-Id', requestId);
    if (replayed !== undefined) response.setHeader('Idempotency-Replayed', replayed);
    response.end(serialized);
  }
}
