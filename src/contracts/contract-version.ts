export const API_CONTRACT_VERSION = '1.0.0' as const;
export const API_SCHEMA_VERSION = 1 as const;

export const AVAILABILITY_STATUSES = [
  'unchecked',
  'open',
  'likely_closed',
  'closed',
  'uncertain',
] as const;

export const EVIDENCE_OUTCOMES = ['open', 'closed', 'inconclusive'] as const;

export const RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'cancelled',
  'failed',
] as const;

export const EVIDENCE_CODES = [
  'jobposting_active',
  'apply_action_present',
  'platform_open_marker',
  'http_404',
  'http_410',
  'valid_through_past',
  'platform_closed_marker',
  'access_denied',
  'rate_limited',
  'server_error',
  'timeout',
  'network_error',
  'bot_challenge',
  'redirect_mismatch',
  'identity_mismatch',
  'identity_unverified',
  'unsupported_source',
  'parse_error',
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type EvidenceCode = (typeof EVIDENCE_CODES)[number];
