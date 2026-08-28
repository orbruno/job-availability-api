import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  IDEMPOTENCY_RETENTION_MILLISECONDS,
  type IdempotencyAdmission,
  type IdempotencyRecord,
  type IdempotencyRepository,
} from '../../application/idempotency-store.js';
import { ServiceError, serviceError } from '../../application/service-error.js';
import type {
  AvailabilityRun,
  AvailabilityState,
  AvailabilityStatus,
  SourceObservation,
} from '../../domain/availability-contracts.js';
import { defaultAvailabilityState } from '../../domain/availability-state.js';
import { PersistedSchemaValidator } from './schema-validator.js';

const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_LOCK_OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type JobSource = {
  platform: string;
  url: string;
};

export type JobMetadata = {
  title: string;
  company: string;
  platform: string;
  url: string;
  sources: JobSource[];
};

export type PerJobEvidence = {
  job_id: string;
  before: AvailabilityStatus;
  after: AvailabilityStatus;
  observations: SourceObservation[];
};

export type WriterLease = {
  owner: string;
  release: () => Promise<void>;
};

export type WriterLockInfo = {
  schema_version: 1;
  owner: string;
  pid: number;
  hostname: string;
  acquired_at: string;
};

export type CheckCommitStage =
  | 'journal-prepared'
  | 'availability-written'
  | 'evidence-written'
  | 'run-written';

export type RepositoryOptions = {
  faultInjector?: (stage: CheckCommitStage) => void | Promise<void>;
  lockRecoveryFaultInjector?: () => void | Promise<void>;
};

type PreparedCheckCommit = {
  schema_version: 1;
  kind: 'check_commit';
  prepared_at: string;
  availability: AvailabilityState;
  evidence: PerJobEvidence;
  run: AvailabilityRun;
};

export class CheckCommitPendingError extends Error {
  public constructor(options: ErrorOptions) {
    super('A prepared check commit requires roll-forward recovery.', options);
    this.name = 'CheckCommitPendingError';
  }
}

function invalidJobId(): never {
  throw serviceError(400, 'invalid_request', 'The job identifier is invalid.');
}

export function resolveCanonicalJobId(requested: string, inventory: readonly string[]): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return invalidJobId();
  }
  if (/%(?:2f|5c)/iu.test(decoded)) return invalidJobId();
  const normalized = decoded.normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    Array.from(normalized).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }) ||
    Buffer.byteLength(normalized, 'utf8') > 255
  ) {
    return invalidJobId();
  }
  const matches = inventory.filter((candidate) => candidate.normalize('NFC') === normalized);
  if (matches.length > 1) {
    throw serviceError(503, 'service_unavailable', 'Canonical inventory identifiers are ambiguous.');
  }
  const match = matches[0];
  if (match === undefined) throw serviceError(404, 'not_found', 'The requested job was not found.');
  return match;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeHostname(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && !value.includes('/') && !value.includes('\\') &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
}

function parseWriterLock(value: unknown): WriterLockInfo {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'acquired_at,hostname,owner,pid,schema_version' ||
    value.schema_version !== 1 || typeof value.owner !== 'string' ||
    !SAFE_LOCK_OWNER.test(value.owner) || typeof value.hostname !== 'string' ||
    !isSafeHostname(value.hostname) || !Number.isInteger(value.pid) ||
    (value.pid as number) < 1 || typeof value.acquired_at !== 'string' ||
    !Number.isFinite(Date.parse(value.acquired_at))
  ) {
    throw serviceError(503, 'service_unavailable', 'The writer lock record is invalid.');
  }
  return value as WriterLockInfo;
}

function sameWriterLock(left: WriterLockInfo, right: WriterLockInfo): boolean {
  return left.owner === right.owner && left.pid === right.pid && left.hostname === right.hostname &&
    left.acquired_at === right.acquired_at;
}

function parseInventory(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw serviceError(503, 'service_unavailable', 'The canonical inventory is unavailable.');
  }
  const result: string[] = [];
  for (const entry of value.jobs) {
    if (!isRecord(entry) || typeof entry.slug !== 'string') {
      throw serviceError(503, 'service_unavailable', 'The canonical inventory is invalid.');
    }
    const slug = entry.slug;
    const unsafeCharacter = Array.from(slug).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    if (
      slug.length === 0 || slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\') ||
      unsafeCharacter || Buffer.byteLength(slug, 'utf8') > 255 || /%(?:2f|5c)/iu.test(slug)
    ) {
      throw serviceError(503, 'service_unavailable', 'The canonical inventory contains an unsafe identifier.');
    }
    if (!result.includes(slug)) result.push(slug);
  }
  const normalized = new Set<string>();
  for (const jobId of result) {
    const nfc = jobId.normalize('NFC');
    if (normalized.has(nfc)) {
      throw serviceError(503, 'service_unavailable', 'Canonical inventory identifiers are ambiguous.');
    }
    normalized.add(nfc);
  }
  return result;
}

function parseMetadata(value: unknown): JobMetadata {
  if (!isRecord(value)) throw serviceError(503, 'service_unavailable', 'Job metadata is invalid.');
  const title = value.title;
  const company = value.company;
  const platform = value.platform;
  const url = value.url;
  const rawSources = value.sources;
  if (
    typeof title !== 'string' || title.length < 1 || title.length > 300 ||
    typeof company !== 'string' || company.length > 200 ||
    typeof platform !== 'string' || platform.length < 1 || platform.length > 64 ||
    typeof url !== 'string' || url.length < 1 || url.length > 2048
  ) {
    throw serviceError(503, 'service_unavailable', 'Job metadata is invalid.');
  }
  const sources: JobSource[] = [];
  const candidates = Array.isArray(rawSources) && rawSources.length > 0
    ? rawSources
    : [{ platform, url }];
  for (const source of candidates) {
    if (!isRecord(source) || typeof source.platform !== 'string' || typeof source.url !== 'string') {
      throw serviceError(503, 'service_unavailable', 'Job source metadata is invalid.');
    }
    if (source.platform.length < 1 || source.platform.length > 64 || source.url.length > 2048) {
      throw serviceError(503, 'service_unavailable', 'Job source metadata is invalid.');
    }
    sources.push({ platform: source.platform, url: source.url });
  }
  if (sources.length === 0 || sources.length > 20) {
    throw serviceError(503, 'service_unavailable', 'Job source metadata is outside service bounds.');
  }
  return { title, company, platform, url, sources };
}

function parseIdempotency(value: unknown, digest: string): IdempotencyRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'committed_at,expires_at,fingerprint,key_digest,result,schema_version' ||
    value.schema_version !== 1 || value.key_digest !== digest ||
    typeof value.fingerprint !== 'string' || !SAFE_DIGEST.test(value.fingerprint) ||
    !isRecord(value.result) ||
    Object.keys(value.result).sort().join(',') !== 'body,contentType,status' ||
    typeof value.committed_at !== 'string' || typeof value.expires_at !== 'string'
  ) {
    throw serviceError(503, 'service_unavailable', 'Idempotency state is invalid.');
  }
  const status = value.result.status;
  const contentType = value.result.contentType;
  const committed = Date.parse(value.committed_at);
  const expires = Date.parse(value.expires_at);
  if (
    !Number.isInteger(status) || (status as number) < 200 || (status as number) > 599 ||
    (contentType !== 'application/json' && contentType !== 'application/problem+json') ||
    !('body' in value.result) || !Number.isFinite(committed) || !Number.isFinite(expires) ||
    expires <= committed || expires - committed > IDEMPOTENCY_RETENTION_MILLISECONDS ||
    JSON.stringify(value.result.body).length > 2 * 1024 * 1024
  ) {
    throw serviceError(503, 'service_unavailable', 'Idempotency state is invalid.');
  }
  return value as IdempotencyRecord;
}

function parseIdempotencyAdmission(value: unknown, digest: string): IdempotencyAdmission {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'admitted_at,expires_at,fingerprint,key_digest,schema_version' ||
    value.schema_version !== 1 || value.key_digest !== digest ||
    typeof value.fingerprint !== 'string' || !SAFE_DIGEST.test(value.fingerprint) ||
    typeof value.admitted_at !== 'string' || typeof value.expires_at !== 'string'
  ) {
    throw serviceError(503, 'service_unavailable', 'Idempotency admission state is invalid.');
  }
  const admitted = Date.parse(value.admitted_at);
  const expires = Date.parse(value.expires_at);
  if (
    !Number.isFinite(admitted) || !Number.isFinite(expires) ||
    expires - admitted !== IDEMPOTENCY_RETENTION_MILLISECONDS
  ) {
    throw serviceError(503, 'service_unavailable', 'Idempotency admission state is invalid.');
  }
  return value as IdempotencyAdmission;
}

export class FileAvailabilityRepository implements IdempotencyRepository {
  readonly #root: string;
  readonly #validator: PersistedSchemaValidator;
  readonly #faultInjector: ((stage: CheckCommitStage) => void | Promise<void>) | undefined;
  readonly #lockRecoveryFaultInjector: (() => void | Promise<void>) | undefined;

  public constructor(dataRoot: string, schemaDirectory: string, options: RepositoryOptions = {}) {
    if (!isAbsolute(dataRoot)) throw new Error('The service data root must be absolute.');
    this.#root = resolve(dataRoot);
    this.#validator = new PersistedSchemaValidator(schemaDirectory);
    this.#faultInjector = options.faultInjector;
    this.#lockRecoveryFaultInjector = options.lockRecoveryFaultInjector;
  }

  public get dataRoot(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    const existingRoot = await lstat(this.#root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existingRoot !== null && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
      throw serviceError(503, 'service_unavailable', 'A symlinked or non-directory data root was refused.');
    }
    if (existingRoot === null) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#assertSafeExistingPath(this.#root);
    for (const path of [
      this.#path('availability'),
      this.#path('availability', 'runs'),
      this.#path('availability', 'idempotency'),
      this.#path('availability', 'idempotency-admissions'),
      this.#path('availability', 'transactions'),
    ]) {
      await this.#ensureDirectory(path);
    }
  }

  public async acquireWriterLease(): Promise<WriterLease> {
    await this.initialize();
    const recoveryGuard = await lstat(this.#recoveryGuardPath()).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (recoveryGuard !== null) {
      throw serviceError(503, 'service_unavailable', 'Writer-lock recovery is in progress or requires review.');
    }
    const lockPath = this.#path('availability', '.job-availability-service.lock');
    const owner = randomUUID();
    let handle: FileHandle;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw serviceError(503, 'service_unavailable', 'Another writer already owns the availability store.');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        schema_version: 1,
        owner,
        pid: process.pid,
        hostname: hostname(),
        acquired_at: new Date().toISOString(),
      })}\n`);
      await handle.sync();
      await handle.close();
      await this.#syncDirectory(dirname(lockPath));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    let released = false;
    return {
      owner,
      release: async () => {
        if (released) return;
        try {
          const current = parseWriterLock(await this.#readJson(lockPath));
          if (current.owner !== owner) {
            throw serviceError(503, 'service_unavailable', 'The writer lock changed before release.');
          }
          await unlink(lockPath);
          await this.#syncDirectory(dirname(lockPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        released = true;
      },
    };
  }

  public async writerLockInfo(): Promise<WriterLockInfo | null> {
    await this.initialize();
    const value = await this.#readJsonIfExists(
      this.#path('availability', '.job-availability-service.lock'),
    );
    if (value === null) return null;
    return parseWriterLock(value);
  }

  public async recoverStaleWriterLock(expectedOwner: string): Promise<void> {
    if (!SAFE_LOCK_OWNER.test(expectedOwner)) {
      throw serviceError(503, 'service_unavailable', 'Stale-lock recovery requires an exact valid owner.');
    }
    await this.initialize();
    const releaseGuard = await this.#acquireRecoveryGuard();
    try {
      const lock = await this.writerLockInfo();
      if (lock?.owner !== expectedOwner || lock.hostname !== hostname()) {
        throw serviceError(503, 'service_unavailable', 'Stale-lock recovery confirmation does not match.');
      }
      try {
        process.kill(lock.pid, 0);
        throw serviceError(503, 'service_unavailable', 'The recorded writer process is still active.');
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw serviceError(503, 'service_unavailable', 'Writer liveness could not be disproved safely.');
        }
      }
      await this.#lockRecoveryFaultInjector?.();
      const confirmed = await this.writerLockInfo();
      if (confirmed === null || !sameWriterLock(lock, confirmed)) {
        throw serviceError(503, 'service_unavailable', 'The writer lock changed during recovery.');
      }
      const lockPath = this.#path('availability', '.job-availability-service.lock');
      const stalePath = this.#path('availability', `.stale-writer-${randomUUID()}.json`);
      await rename(lockPath, stalePath);
      const moved = parseWriterLock(await this.#readJson(stalePath));
      if (!sameWriterLock(lock, moved)) {
        try {
          await link(stalePath, lockPath);
          await unlink(stalePath);
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreError;
        }
        await this.#syncDirectory(this.#path('availability'));
        throw serviceError(503, 'service_unavailable', 'The writer lock changed during recovery.');
      }
      await unlink(stalePath);
      await this.#syncDirectory(this.#path('availability'));
    } finally {
      await releaseGuard();
    }
  }

  public async inventory(): Promise<string[]> {
    const inventory = parseInventory(await this.#readJson(this.#path('jobs', 'index.json')));
    const physicalTargets = new Map<string, string>();
    for (const jobId of inventory) {
      const jobDirectory = this.#path('jobs', jobId);
      const stat = await lstat(jobDirectory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceError(503, 'service_unavailable', 'Unsafe canonical job storage was refused.');
      }
      await this.#assertSafeExistingPath(jobDirectory);
      const physical = await realpath(jobDirectory);
      const previous = physicalTargets.get(physical);
      if (previous !== undefined && previous !== jobId) {
        throw serviceError(503, 'service_unavailable', 'Canonical inventory identifiers share one physical path.');
      }
      physicalTargets.set(physical, jobId);
    }
    return inventory;
  }

  public async resolveJobId(requested: string): Promise<string> {
    const resolved = await this.resolveJobIds([requested]);
    const first = resolved[0];
    if (first === undefined) throw serviceError(404, 'not_found', 'The requested job was not found.');
    return first;
  }

  public async resolveJobIds(requested: readonly string[]): Promise<string[]> {
    const inventory = await this.inventory();
    return requested.map((jobId) => resolveCanonicalJobId(jobId, inventory));
  }

  public async readJobMetadata(jobId: string): Promise<JobMetadata> {
    const canonical = await this.#requireStoredCanonical(jobId);
    return parseMetadata(await this.#readJson(this.#path('jobs', canonical, 'metadata.json')));
  }

  public async readAvailability(jobId: string): Promise<AvailabilityState> {
    const canonical = await this.#requireStoredCanonical(jobId);
    const path = this.#path('jobs', canonical, 'availability.json');
    const value = await this.#readJsonIfExists(path);
    if (value === null) return defaultAvailabilityState(canonical);
    this.#validator.assert('AvailabilityStateDocument', value);
    return value as AvailabilityState;
  }

  public async writeAvailability(state: AvailabilityState): Promise<void> {
    const canonical = await this.#requireStoredCanonical(state.job_id);
    if (canonical !== state.job_id) throw serviceError(400, 'invalid_request', 'The job identifier is not canonical.');
    this.#validator.assert('AvailabilityStateDocument', state);
    await this.#atomicWrite(this.#path('jobs', canonical, 'availability.json'), state);
  }

  public async readRun(runId: string): Promise<AvailabilityRun | null> {
    this.#assertRunId(runId);
    const value = await this.#readJsonIfExists(this.#path('availability', 'runs', runId, 'run.json'));
    if (value === null) return null;
    this.#validator.assert('AvailabilityRunDocument', value);
    return value as AvailabilityRun;
  }

  public async requireRun(runId: string): Promise<AvailabilityRun> {
    const run = await this.readRun(runId);
    if (run === null) throw serviceError(404, 'not_found', 'The requested availability run was not found.');
    return run;
  }

  public async writeRun(run: AvailabilityRun): Promise<void> {
    this.#assertRunId(run.run_id);
    this.#validator.assert('AvailabilityRunDocument', run);
    await this.#atomicWrite(this.#path('availability', 'runs', run.run_id, 'run.json'), run);
  }

  public async writeEvidence(runId: string, evidence: PerJobEvidence): Promise<void> {
    this.#assertRunId(runId);
    const canonical = await this.#requireStoredCanonical(evidence.job_id);
    if (canonical !== evidence.job_id) throw serviceError(400, 'invalid_request', 'The job identifier is not canonical.');
    this.#validator.assert('PerJobEvidenceDocument', evidence);
    await this.#atomicWrite(this.#path('availability', 'runs', runId, 'jobs', `${canonical}.json`), evidence);
  }

  public async readEvidence(runId: string, jobId: string): Promise<PerJobEvidence | null> {
    this.#assertRunId(runId);
    const canonical = await this.#requireStoredCanonical(jobId);
    const value = await this.#readJsonIfExists(
      this.#path('availability', 'runs', runId, 'jobs', `${canonical}.json`),
    );
    if (value === null) return null;
    this.#validator.assert('PerJobEvidenceDocument', value);
    return value as PerJobEvidence;
  }

  public async commitCheck(
    availability: AvailabilityState,
    evidence: PerJobEvidence,
    run: AvailabilityRun,
  ): Promise<void> {
    if (
      availability.job_id !== evidence.job_id ||
      evidence.job_id !== run.processed_job_ids.at(-1) ||
      availability.last_run_id !== run.run_id
    ) {
      throw serviceError(500, 'internal_error', 'The prepared check commit is inconsistent.');
    }
    this.#validator.assert('AvailabilityStateDocument', availability);
    this.#validator.assert('PerJobEvidenceDocument', evidence);
    this.#validator.assert('AvailabilityRunDocument', run);
    const prepared: PreparedCheckCommit = {
      schema_version: 1,
      kind: 'check_commit',
      prepared_at: new Date().toISOString(),
      availability,
      evidence,
      run,
    };
    const path = this.#transactionPath(run.run_id, evidence.job_id);
    await this.#atomicWrite(path, prepared);
    try {
      await this.#inject('journal-prepared');
      await this.#applyPreparedCheck(prepared, path, true);
    } catch (error) {
      throw new CheckCommitPendingError({ cause: error });
    }
  }

  public async recoverPreparedCheckCommits(): Promise<number> {
    const directory = this.#path('availability', 'transactions');
    await this.#ensureDirectory(directory);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    let recovered = 0;
    for (const name of names) {
      const digest = name.slice(0, -'.json'.length);
      if (!SAFE_DIGEST.test(digest)) {
        throw serviceError(503, 'service_unavailable', 'A prepared check journal has an invalid identity.');
      }
      const path = this.#path('availability', 'transactions', name);
      const prepared = this.#parsePreparedCheck(await this.#readJson(path));
      if (path !== this.#transactionPath(prepared.run.run_id, prepared.evidence.job_id)) {
        throw serviceError(503, 'service_unavailable', 'A prepared check journal has a mismatched identity.');
      }
      await this.#applyPreparedCheck(prepared, path, false);
      recovered += 1;
    }
    return recovered;
  }

  public async listRuns(): Promise<AvailabilityRun[]> {
    const root = this.#path('availability', 'runs');
    await this.#ensureDirectory(root);
    const entries = await readdir(root, { withFileTypes: true });
    const runs: AvailabilityRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_RUN_ID.test(entry.name)) continue;
      const run = await this.readRun(entry.name);
      if (run !== null) runs.push(run);
    }
    return runs;
  }

  public async removeRun(runId: string): Promise<void> {
    this.#assertRunId(runId);
    const target = this.#path('availability', 'runs', runId);
    this.#assertConfined(target);
    const stat = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw serviceError(503, 'service_unavailable', 'Unsafe run storage was refused.');
    await rm(target, { recursive: true, force: false });
  }

  public async readIdempotency(digest: string): Promise<IdempotencyRecord | null> {
    if (!SAFE_DIGEST.test(digest)) throw new Error('Invalid idempotency digest.');
    const value = await this.#readJsonIfExists(this.#path('availability', 'idempotency', `${digest}.json`));
    return value === null ? null : parseIdempotency(value, digest);
  }

  public async writeIdempotency(record: IdempotencyRecord): Promise<void> {
    if (!SAFE_DIGEST.test(record.key_digest)) throw new Error('Invalid idempotency digest.');
    await this.#atomicWrite(this.#path('availability', 'idempotency', `${record.key_digest}.json`), record);
  }

  public async readIdempotencyAdmission(digest: string): Promise<IdempotencyAdmission | null> {
    if (!SAFE_DIGEST.test(digest)) throw new Error('Invalid idempotency digest.');
    const value = await this.#readJsonIfExists(
      this.#path('availability', 'idempotency-admissions', `${digest}.json`),
    );
    return value === null ? null : parseIdempotencyAdmission(value, digest);
  }

  public async writeIdempotencyAdmission(record: IdempotencyAdmission): Promise<void> {
    if (!SAFE_DIGEST.test(record.key_digest)) throw new Error('Invalid idempotency digest.');
    parseIdempotencyAdmission(record, record.key_digest);
    await this.#atomicWrite(
      this.#path('availability', 'idempotency-admissions', `${record.key_digest}.json`),
      record,
    );
  }

  public async pruneIdempotency(referenceTime: number): Promise<number> {
    let removed = 0;
    for (const kind of ['idempotency', 'idempotency-admissions'] as const) {
      const directory = this.#path('availability', kind);
      await this.#ensureDirectory(directory);
      const names = await readdir(directory);
      let directoryChanged = false;
      for (const name of names) {
        const digest = name.replace(/\.json$/u, '');
        if (!SAFE_DIGEST.test(digest) || name !== `${digest}.json`) continue;
        const record = kind === 'idempotency'
          ? await this.readIdempotency(digest)
          : await this.readIdempotencyAdmission(digest);
        if (record !== null && Date.parse(record.expires_at) <= referenceTime) {
          await unlink(this.#path('availability', kind, name));
          removed += 1;
          directoryChanged = true;
        }
      }
      if (directoryChanged) await this.#syncDirectory(directory);
    }
    return removed;
  }

  #transactionPath(runId: string, jobId: string): string {
    const digest = createHash('sha256').update(`${runId}\u0000${jobId}`, 'utf8').digest('hex');
    return this.#path('availability', 'transactions', `${digest}.json`);
  }

  #recoveryGuardPath(): string {
    return this.#path('availability', '.job-availability-lock-recovery');
  }

  async #acquireRecoveryGuard(): Promise<() => Promise<void>> {
    const path = this.#recoveryGuardPath();
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw serviceError(503, 'service_unavailable', 'Another writer-lock recovery is active or requires review.');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        schema_version: 1,
        owner: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        acquired_at: new Date().toISOString(),
      })}\n`);
      await handle.sync();
      await handle.close();
      await this.#syncDirectory(dirname(path));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      await unlink(path);
      await this.#syncDirectory(dirname(path));
      released = true;
    };
  }

  #parsePreparedCheck(value: unknown): PreparedCheckCommit {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(',') !== 'availability,evidence,kind,prepared_at,run,schema_version' ||
      value.schema_version !== 1 || value.kind !== 'check_commit' ||
      typeof value.prepared_at !== 'string' || !Number.isFinite(Date.parse(value.prepared_at)) ||
      !('availability' in value) || !('evidence' in value) || !('run' in value)
    ) {
      throw serviceError(503, 'service_unavailable', 'A prepared check journal is invalid.');
    }
    this.#validator.assert('AvailabilityStateDocument', value.availability);
    this.#validator.assert('PerJobEvidenceDocument', value.evidence);
    this.#validator.assert('AvailabilityRunDocument', value.run);
    const prepared = value as PreparedCheckCommit;
    if (
      prepared.availability.job_id !== prepared.evidence.job_id ||
      prepared.availability.last_run_id !== prepared.run.run_id ||
      prepared.evidence.job_id !== prepared.run.processed_job_ids.at(-1)
    ) {
      throw serviceError(503, 'service_unavailable', 'A prepared check journal is inconsistent.');
    }
    return prepared;
  }

  async #applyPreparedCheck(
    prepared: PreparedCheckCommit,
    journalPath: string,
    injectFaults: boolean,
  ): Promise<void> {
    await this.writeAvailability(prepared.availability);
    if (injectFaults) await this.#inject('availability-written');
    await this.writeEvidence(prepared.run.run_id, prepared.evidence);
    if (injectFaults) await this.#inject('evidence-written');
    await this.writeRun(prepared.run);
    if (injectFaults) await this.#inject('run-written');
    await unlink(journalPath);
    await this.#syncDirectory(dirname(journalPath));
  }

  async #inject(stage: CheckCommitStage): Promise<void> {
    await this.#faultInjector?.(stage);
  }

  async #requireStoredCanonical(jobId: string): Promise<string> {
    const inventory = await this.inventory();
    const matches = inventory.filter((item) => item === jobId);
    if (matches.length !== 1) throw serviceError(404, 'not_found', 'The requested job was not found.');
    const match = matches[0];
    if (match === undefined) throw serviceError(404, 'not_found', 'The requested job was not found.');
    return match;
  }

  #assertRunId(runId: string): void {
    if (!SAFE_RUN_ID.test(runId)) throw serviceError(400, 'invalid_request', 'The run identifier is invalid.');
  }

  #path(...parts: string[]): string {
    const target = resolve(this.#root, ...parts);
    const back = relative(this.#root, target);
    if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw serviceError(400, 'invalid_request', 'The storage path is outside the data root.');
    }
    return target;
  }

  #assertConfined(target: string): void {
    const back = relative(this.#root, target);
    if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw serviceError(503, 'service_unavailable', 'Unsafe storage path was refused.');
    }
  }

  async #assertSafeExistingPath(target: string): Promise<void> {
    this.#assertConfined(target);
    const pathFromRoot = relative(this.#root, target);
    let current = this.#root;
    const segments = pathFromRoot === '' ? [] : pathFromRoot.split(sep);
    for (const segment of segments) {
      current = resolve(current, segment);
      const component = await lstat(current);
      if (component.isSymbolicLink()) {
        throw serviceError(503, 'service_unavailable', 'Symlink traversal was refused.');
      }
    }
    const rootReal = await realpath(this.#root);
    const targetReal = await realpath(target);
    const back = relative(rootReal, targetReal);
    if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw serviceError(503, 'service_unavailable', 'Symlink traversal was refused.');
    }
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw serviceError(503, 'service_unavailable', 'Symlink traversal was refused.');
  }

  async #ensureDirectory(path: string): Promise<void> {
    this.#assertConfined(path);
    const pathFromRoot = relative(this.#root, path);
    let current = this.#root;
    for (const segment of pathFromRoot === '' ? [] : pathFromRoot.split(sep)) {
      current = resolve(current, segment);
      const existing = await lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (existing === null) {
        await mkdir(current, { mode: 0o700 });
      } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw serviceError(503, 'service_unavailable', 'Unsafe storage directory was refused.');
      }
    }
    await this.#assertSafeExistingPath(path);
  }

  async #readJsonIfExists(path: string): Promise<unknown> {
    try {
      return await this.#readJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async #readJson(path: string): Promise<unknown> {
    this.#assertConfined(path);
    await this.#assertSafeExistingPath(dirname(path));
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw serviceError(503, 'service_unavailable', 'Symlink storage was refused.');
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON_FILE_BYTES) {
        throw serviceError(503, 'service_unavailable', 'Persisted data is outside service bounds.');
      }
      const bytes = await handle.readFile();
      if (bytes.length > MAX_JSON_FILE_BYTES) {
        throw serviceError(503, 'service_unavailable', 'Persisted data is outside service bounds.');
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw serviceError(503, 'service_unavailable', 'Persisted JSON is invalid.');
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #atomicWrite(path: string, value: unknown): Promise<void> {
    this.#assertConfined(path);
    const parent = dirname(path);
    await this.#ensureDirectory(parent);
    const existing = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.isSymbolicLink() === true) throw serviceError(503, 'service_unavailable', 'Symlink storage was refused.');
    const temporary = resolve(parent, `.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(temporary, path);
    await this.#syncDirectory(parent);
  }

  async #syncDirectory(path: string): Promise<void> {
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
