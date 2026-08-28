import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { IdempotencyStore } from '../dist/application/idempotency-store.js';
import { AvailabilityService } from '../dist/application/manage-availability-run.js';
import { AvailabilityHttpServer } from '../dist/api/availability-server.js';
import { FixedWindowRateLimiter } from '../dist/api/rate-limiter.js';
import { SafeFetcher } from '../dist/infrastructure/http/safe-fetch.js';
import { FileAvailabilityRepository } from '../dist/infrastructure/persistence/file-availability-repository.js';
import { AvailabilitySignals } from '../dist/infrastructure/telemetry/availability-signals.js';

const iterations = Math.min(2_000, Math.max(1, Number(process.env.BENCHMARK_ITERATIONS ?? '200')));
const concurrency = Math.min(16, Math.max(1, Number(process.env.BENCHMARK_CONCURRENCY ?? '4')));
const jobCount = Math.min(1_000, Math.max(1, Number(process.env.BENCHMARK_JOB_COUNT ?? '1')));
if (!Number.isInteger(iterations) || !Number.isInteger(concurrency) || !Number.isInteger(jobCount)) {
  throw new Error('Benchmark bounds are invalid.');
}
const root = await mkdtemp(join(await realpath(tmpdir()), 'job-availability-benchmark-'));
const jobs = Array.from({ length: jobCount }, (_, index) => ({
  slug: `synthetic-job-${String(index).padStart(4, '0')}`,
}));
await mkdir(join(root, 'jobs'), { recursive: true });
await writeFile(join(root, 'jobs', 'index.json'), JSON.stringify({ jobs }));
for (let offset = 0; offset < jobs.length; offset += 32) {
  await Promise.all(jobs.slice(offset, offset + 32).map(async (job) => {
    const directory = join(root, 'jobs', job.slug);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({
      title: 'Synthetic Job', company: 'Synthetic Company', platform: 'synthetic',
      url: `https://example.com/${job.slug}`,
      sources: [{ platform: 'synthetic', url: `https://example.com/${job.slug}` }],
    }));
  }));
}
const repository = new FileAvailabilityRepository(root, resolve(process.cwd(), 'schemas'));
const lease = await repository.acquireWriterLease();
const token = randomBytes(32).toString('base64url');
const server = new AvailabilityHttpServer({
  service: new AvailabilityService(repository, new SafeFetcher()),
  idempotency: new IdempotencyStore(repository),
  token,
  schemaDirectory: resolve(process.cwd(), 'schemas'),
  signals: new AvailabilitySignals(() => undefined),
  ownerKey: 'isolated-benchmark',
  rateLimiter: new FixedWindowRateLimiter(iterations + concurrency, 60_000),
});
await server.listen('127.0.0.1', 0);
const address = server.server.address();
if (address === null || typeof address === 'string') throw new Error('Benchmark server did not bind.');
const durations = [];
let errors = 0;
let next = 0;
const started = globalThis.performance.now();
async function worker() {
  while (next < iterations) {
    const index = next;
    next += 1;
    const requestStarted = globalThis.performance.now();
    const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/v1/availability/runs/scheduled`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `benchmark-${index}`,
      },
      body: '{"schema_version":1}',
    });
    durations.push(globalThis.performance.now() - requestStarted);
    if (response.status !== 201) errors += 1;
    await response.arrayBuffer();
  }
}
try {
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = globalThis.performance.now() - started;
  durations.sort((left, right) => left - right);
  const percentile = (value) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
  process.stdout.write(`${JSON.stringify({
    benchmark: 'isolated-scheduled-run-api',
    fixture: `${jobCount} synthetic canonical jobs`,
    runtime: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    logical_cpu_count: cpus().length,
    total_memory_bytes: totalmem(),
    iterations,
    concurrency,
    job_count: jobCount,
    latency_ms: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
    throughput_requests_per_second: iterations / (elapsed / 1_000),
    error_rate: errors / iterations,
    retry_rate: 0,
    rss_bytes: process.memoryUsage().rss,
  })}\n`);
} finally {
  await server.close();
  await lease.release();
  await rm(root, { recursive: true, force: true });
}
