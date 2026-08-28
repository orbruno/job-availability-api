import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import persistedSchema from '../../schemas/persisted-availability-v1.schema.json' with {
  type: 'json',
};
import publicSchema from '../../schemas/public-api-v1.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => Number.isFinite(Date.parse(value)),
});
ajv.addFormat('uri', {
  type: 'string',
  validate: (value: string) => URL.canParse(value),
});
ajv.addKeyword({ keyword: 'x-max-utf8-bytes', schemaType: 'number' });
ajv.addSchema(publicSchema);
ajv.addSchema(persistedSchema);

function validator(schemaId: string, definition: string) {
  return ajv.compile({ $ref: `${schemaId}#/$defs/${definition}` });
}

const validateCreateRun = validator(publicSchema.$id, 'CreateRunRequest');
const validateScheduledRun = validator(publicSchema.$id, 'CreateScheduledRunRequest');
const validateCredentialTest = validator(publicSchema.$id, 'CredentialTestResponse');
const validateEvidence = validator(publicSchema.$id, 'SourceEvidence');
const validateRun = validator(publicSchema.$id, 'Run');
const validateCheck = validator(publicSchema.$id, 'CheckJobResponse');
const validatePublicTimestamp = validator(publicSchema.$id, 'UtcTimestamp');
const validatePersistedTimestamp = validator(persistedSchema.$id, 'UtcTimestamp');

const summary = {
  checked: 0,
  open: 0,
  likely_closed: 0,
  closed: 0,
  uncertain: 0,
  unchecked: 0,
  newly_closed: 0,
  reopened: 0,
  failed: 0,
};

const evidence = {
  platform: 'fixture',
  outcome: 'open',
  evidence_code: 'jobposting_active',
  checked_at: '2026-08-27T00:00:00Z',
  http_status: 200,
};

describe('public API JSON Schema consumer', () => {
  it('uses 200 only for a ready credential-test response', () => {
    expect(
      validateCredentialTest({ schema_version: 1, service_version: '0.1.0', ready: true }),
    ).toBe(true);
    expect(
      validateCredentialTest({ schema_version: 1, service_version: '0.1.0', ready: false }),
    ).toBe(false);
  });

  it('admits at most 100 raw explicit IDs and leaves stable deduplication to runtime', () => {
    expect(
      validateCreateRun({
        schema_version: 1,
        job_ids: Array.from({ length: 100 }, () => 'job-1'),
        trigger: 'manual',
      }),
    ).toBe(true);
    expect(
      validateCreateRun({
        schema_version: 1,
        job_ids: Array.from({ length: 101 }, () => 'job-1'),
        trigger: 'manual',
      }),
    ).toBe(false);
    expect(validateCreateRun({ schema_version: 1, job_ids: [], trigger: 'manual' })).toBe(
      false,
    );
  });

  it('keeps scheduled creation fixed to the schema version only', () => {
    expect(validateScheduledRun({ schema_version: 1 })).toBe(true);
    expect(validateScheduledRun({ schema_version: 1, trigger: 'schedule' })).toBe(false);
    expect(validateScheduledRun({ schema_version: 1, job_ids: ['job-1'] })).toBe(false);
    expect(validateScheduledRun({ schema_version: 2 })).toBe(false);
  });

  it('enforces nullable-pair and non-null outcome/evidence consistency', () => {
    expect(validateEvidence(evidence)).toBe(true);
    expect(validateEvidence({ ...evidence, evidence_code: 'http_404' })).toBe(false);
    expect(validateEvidence({ ...evidence, outcome: null, evidence_code: null })).toBe(true);
    expect(validateEvidence({ ...evidence, outcome: null })).toBe(false);
  });

  it('keeps full counts while bounding run projection windows', () => {
    const pending = Array.from({ length: 100 }, (_, index) => `job-${String(index + 1)}`);
    const run = {
      schema_version: 1,
      run_id: 'availability-20260827T000000-abc12345',
      status: 'pending',
      trigger: 'schedule',
      created_at: '2026-08-27T00:00:00Z',
      started_at: null,
      completed_at: null,
      job_count: 1000,
      pending_count: 1000,
      processed_count: 0,
      error_count: 0,
      summary,
      pending_job_ids: pending,
      pending_job_ids_truncated: true,
      processed_job_ids: [],
      processed_job_ids_truncated: false,
      errors: [],
      errors_truncated: false,
    };
    expect(validateRun(run)).toBe(true);
    expect(validateRun({ ...run, pending_job_ids: [...pending, 'job-101'] })).toBe(false);
    expect(validateRun({ ...run, total_jobs: 1000 })).toBe(false);
  });

  it('freezes before/after names and requires evidence on successful checks', () => {
    const check = {
      schema_version: 1,
      run_id: 'run-1',
      job_id: 'job-1',
      before: 'unchecked',
      after: 'open',
      checked_at: '2026-08-27T00:00:00Z',
      sources: [evidence],
      sources_truncated: false,
    };
    expect(validateCheck(check)).toBe(true);
    expect(validateCheck({ ...check, sources: [] })).toBe(false);
    const { after, before, ...rest } = check;
    expect(
      validateCheck({ ...rest, before_status: before, after_status: after }),
    ).toBe(false);
  });

  it('separates canonical public timestamps from rollback-compatible persisted UTC', () => {
    expect(validatePublicTimestamp('2026-08-27T00:00:00Z')).toBe(true);
    expect(validatePublicTimestamp('2026-08-27T00:00:00+00:00')).toBe(false);
    expect(validatePublicTimestamp('2026-08-27T02:00:00+02:00')).toBe(false);
    expect(validatePersistedTimestamp('2026-08-27T00:00:00Z')).toBe(true);
    expect(validatePersistedTimestamp('2026-08-27T00:00:00+00:00')).toBe(true);
    expect(validatePersistedTimestamp('2026-08-27T02:00:00+02:00')).toBe(false);
  });

  it('publishes the runtime UTF-8 byte bound as a schema annotation', () => {
    expect(publicSchema.$defs.JobId['x-max-utf8-bytes']).toBe(255);
    expect(Buffer.byteLength('é'.repeat(128), 'utf8')).toBe(256);
  });
});
