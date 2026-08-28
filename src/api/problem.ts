import type { ProblemCode } from '../application/service-error.js';

const TITLES: Readonly<Record<ProblemCode, string>> = {
  invalid_request: 'Invalid request',
  authentication_failed: 'Authentication failed',
  not_found: 'Not found',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  idempotency_conflict: 'Idempotency conflict',
  run_cancelled: 'Run cancelled',
  run_has_pending_jobs: 'Run has pending jobs',
  run_terminal: 'Run is terminal',
  job_not_checkable: 'Job is not checkable',
  no_jobs_available: 'No jobs available',
  inventory_limit_exceeded: 'Inventory limit exceeded',
  rate_limited: 'Rate limit exceeded',
  internal_error: 'Internal error',
  service_unavailable: 'Service unavailable',
};

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ProblemCode;
  request_id: string;
};

export function problemDocument(
  status: number,
  code: ProblemCode,
  detail: string,
  requestId: string,
): Problem {
  return {
    type: `https://job-availability.local/problems/${code}`,
    title: TITLES[code],
    status,
    detail: detail.slice(0, 500),
    instance: `urn:job-availability:request:${requestId}`,
    code,
    request_id: requestId,
  };
}
