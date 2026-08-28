import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IdempotencyStore,
  type IdempotencyRepository,
} from '../../src/application/idempotency-store.js';
import { AvailabilityService } from '../../src/application/manage-availability-run.js';
import { AvailabilityHttpServer } from '../../src/api/availability-server.js';
import { FixedWindowRateLimiter } from '../../src/api/rate-limiter.js';
import {
  SafeFetcher,
  type SafeFetchResult,
} from '../../src/infrastructure/http/safe-fetch.js';
import { FileAvailabilityRepository } from '../../src/infrastructure/persistence/file-availability-repository.js';
import {
  AvailabilitySignals,
  type AvailabilitySignal,
} from '../../src/infrastructure/telemetry/availability-signals.js';

const testDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE_ROOT = resolve(testDirectory, '..');
export const SCHEMA_DIRECTORY = resolve(SERVICE_ROOT, 'schemas');
export const TEST_TOKEN = randomBytes(32).toString('base64url');

export type TestJob = {
  slug: string;
  title?: string;
  company?: string;
  platform?: string;
  url?: string;
};

export async function createTestData(jobs: readonly TestJob[] = [{ slug: 'job-one' }]): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'job-availability-service-'));
  const inventory = jobs.map((job) => ({
    slug: job.slug,
    title: job.title ?? 'Data Engineer',
    company: job.company ?? 'Acme',
    platform: job.platform ?? 'example',
    url: job.url ?? 'https://example.com/jobs/one',
    sources: [{
      platform: job.platform ?? 'example',
      url: job.url ?? 'https://example.com/jobs/one',
    }],
  }));
  await mkdir(join(root, 'jobs'), { recursive: true });
  await writeFile(join(root, 'jobs', 'index.json'), `${JSON.stringify({ jobs: inventory })}\n`);
  for (const job of inventory) {
    const directory = join(root, 'jobs', job.slug);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), `${JSON.stringify(job)}\n`);
  }
  return { root, cleanup: async () => await rm(root, { recursive: true, force: true }) };
}

export class StubSafeFetcher extends SafeFetcher {
  public calls = 0;

  public constructor(
    private readonly result: SafeFetchResult = {
      attempts: [{
        kind: 'response',
        status: 200,
        resolved_url: 'https://example.com/jobs/one',
        body: '<html><body>Data Engineer at Acme <a>Apply now</a></body></html>',
        decoded_body_bytes: 70,
      }],
      retryCount: 0,
    },
  ) {
    super({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
    });
  }

  public override fetch(): Promise<SafeFetchResult> {
    this.calls += 1;
    return Promise.resolve(structuredClone(this.result));
  }
}

export async function createServiceHarness(options: {
  jobs?: readonly TestJob[];
  fetcher?: StubSafeFetcher;
  token?: string;
  telemetryThrows?: boolean;
  rateLimiter?: FixedWindowRateLimiter;
  idempotencyRepository?: IdempotencyRepository;
} = {}): Promise<{
  root: string;
  repository: FileAvailabilityRepository;
  service: AvailabilityService;
  fetcher: StubSafeFetcher;
  server: AvailabilityHttpServer;
  baseUrl: string;
  signals: AvailabilitySignal[];
  close: () => Promise<void>;
}> {
  const data = await createTestData(options.jobs);
  const repository = new FileAvailabilityRepository(data.root, SCHEMA_DIRECTORY);
  await repository.initialize();
  const fetcher = options.fetcher ?? new StubSafeFetcher();
  const service = new AvailabilityService(repository, fetcher);
  const signals: AvailabilitySignal[] = [];
  const telemetry = new AvailabilitySignals((signal) => {
    if (options.telemetryThrows === true) throw new Error('telemetry unavailable');
    signals.push(structuredClone(signal));
  });
  const server = new AvailabilityHttpServer({
    service,
    idempotency: new IdempotencyStore(options.idempotencyRepository ?? repository),
    token: options.token ?? TEST_TOKEN,
    schemaDirectory: SCHEMA_DIRECTORY,
    signals: telemetry,
    ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
  });
  await server.listen('127.0.0.1', 0);
  const address = server.server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind.');
  return {
    root: data.root,
    repository,
    service,
    fetcher,
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    signals,
    close: async () => {
      await server.close();
      await data.cleanup();
    },
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}
