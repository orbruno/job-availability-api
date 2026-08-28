import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IdempotencyStore } from './application/idempotency-store.js';
import { AvailabilityService } from './application/manage-availability-run.js';
import { serviceError } from './application/service-error.js';
import { AvailabilityHttpServer } from './api/availability-server.js';
import { assertProvisionedToken } from './api/authentication.js';
import { SafeFetcher } from './infrastructure/http/safe-fetch.js';
import { FileAvailabilityRepository } from './infrastructure/persistence/file-availability-repository.js';
import {
  AvailabilitySignals,
  jsonLineSignalSink,
} from './infrastructure/telemetry/availability-signals.js';

export async function readProvisionedTokenFile(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw serviceError(503, 'service_unavailable', 'The service-token secret path must be absolute.');
  }
  let current: string = sep;
  for (const segment of path.split(sep).filter((item) => item !== '')) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw serviceError(503, 'service_unavailable', 'A symlinked service-token path was refused.');
    }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0) {
      throw serviceError(503, 'service_unavailable', 'The service-token secret file is invalid.');
    }
    return (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
}

export async function configuredToken(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const direct = environment.JOB_AVAILABILITY_TOKEN;
  const file = environment.JOB_AVAILABILITY_TOKEN_FILE;
  if ((direct === undefined) === (file === undefined)) {
    throw serviceError(503, 'service_unavailable', 'Configure exactly one service-token secret source.');
  }
  if (direct !== undefined) return direct;
  if (file === undefined) throw serviceError(503, 'service_unavailable', 'The service-token source is missing.');
  return await readProvisionedTokenFile(file);
}

function configuredPort(): number {
  const value = Number(process.env.JOB_AVAILABILITY_PORT ?? '5002');
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw serviceError(503, 'service_unavailable', 'The configured service port is invalid.');
  }
  return value;
}

function configuredSpacing(): number {
  const value = Number(process.env.JOB_AVAILABILITY_HOST_SPACING_MS ?? '1000');
  if (!Number.isFinite(value) || value < 1_000 || value > 60_000) {
    throw serviceError(503, 'service_unavailable', 'The configured host spacing is invalid.');
  }
  return value;
}

export async function main(): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaDirectory = resolve(moduleDirectory, '..', 'schemas');
  const configuredRoot = process.env.JOB_AVAILABILITY_DATA_ROOT;
  if (configuredRoot === undefined || !isAbsolute(configuredRoot)) {
    throw serviceError(503, 'service_unavailable', 'JOB_AVAILABILITY_DATA_ROOT must be an absolute path.');
  }
  const token = await configuredToken();
  assertProvisionedToken(token);
  const repository = new FileAvailabilityRepository(configuredRoot, schemaDirectory);
  const lease = await repository.acquireWriterLease();
  try {
    await repository.recoverPreparedCheckCommits();
    const signals = new AvailabilitySignals(jsonLineSignalSink);
    const idempotency = new IdempotencyStore(repository);
    await idempotency.prune();
    const service = new AvailabilityService(repository, new SafeFetcher({
      minimumHostSpacingMilliseconds: configuredSpacing(),
    }));
    await service.recoverableRuns();
    const server = new AvailabilityHttpServer({
      service,
      idempotency,
      token,
      schemaDirectory,
      signals,
      ownerKey: process.env.JOB_AVAILABILITY_OWNER_KEY ?? 'local-operator',
    });
    const shutdown = async (): Promise<void> => {
      await server.close();
      await lease.release();
    };
    process.once('SIGINT', () => void shutdown().catch(() => { process.exitCode = 1; }));
    process.once('SIGTERM', () => void shutdown().catch(() => { process.exitCode = 1; }));
    await server.listen(process.env.JOB_AVAILABILITY_HOST ?? '127.0.0.1', configuredPort());
  } catch (error) {
    await lease.release();
    throw error;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main().catch(() => {
    process.stderr.write('Job Availability service startup failed.\n');
    process.exitCode = 1;
  });
}
