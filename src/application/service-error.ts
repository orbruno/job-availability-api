export type ProblemCode =
  | 'invalid_request'
  | 'authentication_failed'
  | 'not_found'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'idempotency_conflict'
  | 'run_cancelled'
  | 'run_has_pending_jobs'
  | 'run_terminal'
  | 'job_not_checkable'
  | 'no_jobs_available'
  | 'inventory_limit_exceeded'
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable';

export class ServiceError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: ProblemCode,
    message: string,
    public readonly committed = false,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function serviceError(
  status: number,
  code: ProblemCode,
  message: string,
  committed = false,
): ServiceError {
  return new ServiceError(status, code, message, committed);
}
