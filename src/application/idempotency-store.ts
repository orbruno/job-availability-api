import { createHash } from 'node:crypto';

import { MutationCoordinator } from './mutation-coordinator.js';
import { serviceError } from './service-error.js';

export const IDEMPOTENCY_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_PRUNE_INTERVAL_MILLISECONDS = 15 * 60 * 1000;

export type StoredHttpResult = {
  status: number;
  contentType: string;
  body: unknown;
};

export type IdempotencyRecord = {
  schema_version: 1;
  key_digest: string;
  fingerprint: string;
  result: StoredHttpResult;
  committed_at: string;
  expires_at: string;
};

export type IdempotencyAdmission = {
  schema_version: 1;
  key_digest: string;
  fingerprint: string;
  admitted_at: string;
  expires_at: string;
};

export type IdempotencyRepository = {
  readIdempotency: (digest: string) => Promise<IdempotencyRecord | null>;
  writeIdempotency: (record: IdempotencyRecord) => Promise<void>;
  readIdempotencyAdmission: (digest: string) => Promise<IdempotencyAdmission | null>;
  writeIdempotencyAdmission: (record: IdempotencyAdmission) => Promise<void>;
  pruneIdempotency: (referenceTime: number) => Promise<number>;
};

export type IdempotencyResult = StoredHttpResult & {
  replayed: boolean;
};

export type IdempotencyOperationContext = {
  keyDigest: string;
  fingerprint: string;
  admittedAt: string;
  expiresAt: string;
};

type InFlight = {
  fingerprint: string;
  promise: Promise<StoredHttpResult>;
};

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw serviceError(400, 'invalid_request', 'JSON numbers must be finite.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw serviceError(400, 'invalid_request', 'The request cannot be canonicalized.');
}

export function idempotencyDigest(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function requestFingerprint(
  method: string,
  normalizedRoute: string,
  effectiveBody: unknown,
): string {
  return createHash('sha256')
    .update(canonical({ body: effectiveBody, method: method.toUpperCase(), route: normalizedRoute }))
    .digest('hex');
}

export function assertIdempotencyKey(rawKey: string | undefined): string {
  if (
    rawKey === undefined ||
    rawKey.length < 1 ||
    rawKey.length > 128 ||
    !/^[\x21-\x7E]+$/u.test(rawKey)
  ) {
    throw serviceError(400, 'invalid_request', 'A valid Idempotency-Key header is required.');
  }
  return rawKey;
}

export class IdempotencyStore {
  readonly #inFlight = new Map<string, InFlight>();
  readonly #admissions = new MutationCoordinator();
  #nextPruneAt = Number.NEGATIVE_INFINITY;
  #pruneInFlight: Promise<number> | undefined;

  public constructor(
    private readonly repository: IdempotencyRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(
    rawKey: string,
    fingerprint: string,
    operation: (context: IdempotencyOperationContext) => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult> {
    const digest = idempotencyDigest(rawKey);
    await this.#pruneIfDue(this.now().getTime());
    const admission = await this.#admissions.runExclusive(digest, async () => {
      const currentTime = this.now();
      const stored = await this.repository.readIdempotency(digest);
      if (stored !== null && Date.parse(stored.expires_at) > currentTime.getTime()) {
        this.#assertFingerprint(stored.fingerprint, fingerprint);
        return { primary: false, stored: stored.result, promise: null } as const;
      }
      const active = this.#inFlight.get(digest);
      if (active !== undefined) {
        this.#assertFingerprint(active.fingerprint, fingerprint);
        return { primary: false, stored: null, promise: active.promise } as const;
      }
      const existingAdmission = await this.repository.readIdempotencyAdmission(digest);
      let operationAdmission: IdempotencyAdmission;
      if (
        existingAdmission !== null &&
        Date.parse(existingAdmission.expires_at) > currentTime.getTime()
      ) {
        this.#assertFingerprint(existingAdmission.fingerprint, fingerprint);
        operationAdmission = existingAdmission;
      } else {
        operationAdmission = {
          schema_version: 1,
          key_digest: digest,
          fingerprint,
          admitted_at: currentTime.toISOString(),
          expires_at: new Date(
            currentTime.getTime() + IDEMPOTENCY_RETENTION_MILLISECONDS,
          ).toISOString(),
        };
        await this.repository.writeIdempotencyAdmission(operationAdmission);
      }
      const promise = Promise.resolve().then(async () => {
        const result = await operation({
          keyDigest: digest,
          fingerprint,
          admittedAt: operationAdmission.admitted_at,
          expiresAt: operationAdmission.expires_at,
        });
        const committedAt = this.now();
        await this.repository.writeIdempotency({
          schema_version: 1,
          key_digest: digest,
          fingerprint,
          result,
          committed_at: committedAt.toISOString(),
          expires_at: operationAdmission.expires_at,
        });
        return result;
      });
      this.#inFlight.set(digest, { fingerprint, promise });
      return { primary: true, stored: null, promise } as const;
    });
    if (admission.stored !== null) return { ...admission.stored, replayed: true };
    const promise = admission.promise;
    try {
      const result = await promise;
      return { ...result, replayed: !admission.primary };
    } finally {
      if (admission.primary) {
        await this.#admissions.runExclusive(digest, () => {
          if (this.#inFlight.get(digest)?.promise === promise) this.#inFlight.delete(digest);
          return Promise.resolve();
        });
      }
    }
  }

  public async prune(): Promise<number> {
    const referenceTime = this.now().getTime();
    const removed = await this.repository.pruneIdempotency(referenceTime);
    this.#nextPruneAt = referenceTime + IDEMPOTENCY_PRUNE_INTERVAL_MILLISECONDS;
    return removed;
  }

  async #pruneIfDue(referenceTime: number): Promise<void> {
    if (referenceTime < this.#nextPruneAt) return;
    const active = this.#pruneInFlight;
    if (active !== undefined) {
      await active;
      return;
    }
    const operation = this.repository.pruneIdempotency(referenceTime);
    this.#pruneInFlight = operation;
    try {
      await operation;
      this.#nextPruneAt = referenceTime + IDEMPOTENCY_PRUNE_INTERVAL_MILLISECONDS;
    } finally {
      if (this.#pruneInFlight === operation) this.#pruneInFlight = undefined;
    }
  }

  #assertFingerprint(actual: string, expected: string): void {
    if (actual !== expected) {
      throw serviceError(409, 'idempotency_conflict', 'The idempotency key belongs to another request.');
    }
  }
}
