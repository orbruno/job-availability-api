import {
  DomainInvariantError,
  evidenceOutcomeForCode,
  type EvidenceCode,
  type SourceObservation,
} from './availability-contracts.js';
import { sourceIdentity } from './source-identity.js';

export const MAX_DECODED_BODY_BYTES = 2 * 1024 * 1024;

const CLOSED_MARKERS = [
  'this job is no longer available',
  'job has expired',
  'position has been filled',
  'stellenanzeige ist nicht mehr verfügbar',
  'job wurde bereits besetzt',
] as const;

const APPLY_MARKERS = [
  'apply now',
  'jetzt bewerben',
  'apply for this job',
  'bewerben',
] as const;

const CHALLENGE_MARKERS = [
  'captcha',
  'verify you are human',
  'access denied',
  'sign in to continue',
  'enable javascript and cookies',
] as const;

export type ResponseAttempt = {
  kind: 'response';
  status: number;
  resolved_url: string;
  body?: string;
  body_prefix?: string;
  decoded_body_bytes?: number;
  headers?: Readonly<Record<string, string>>;
};

export type TimeoutAttempt = {
  kind: 'timeout';
};

export type NetworkErrorAttempt = {
  kind: 'network_error';
};

export type UnsafeUrlAttempt = {
  kind: 'unsafe_url';
  stage?: string;
  url?: string;
};

export type FetchAttempt =
  | ResponseAttempt
  | TimeoutAttempt
  | NetworkErrorAttempt
  | UnsafeUrlAttempt;

export type ClassificationInput = {
  platform: string;
  url: string;
  expected_title: string;
  expected_company?: string;
  fetch: {
    attempts: readonly FetchAttempt[];
  };
  platform_markers?: {
    open?: readonly string[];
    closed?: readonly string[];
  };
};

export type ClassificationClock = {
  now: () => string;
};

export type ClassificationResult = {
  observation: SourceObservation;
  attemptCount: number;
};

type JsonRecord = Record<string, unknown>;

type ParsedPostings = {
  malformed: boolean;
  postings: JsonRecord[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function observation(
  input: ClassificationInput,
  identity: string,
  checkedAt: string,
  code: EvidenceCode,
  httpStatus: number | null,
): SourceObservation {
  return {
    platform: input.platform,
    source_identity: identity,
    outcome: evidenceOutcomeForCode(code),
    evidence_code: code,
    checked_at: checkedAt,
    http_status: httpStatus,
  };
}

function normalizeText(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('und');
}

function words(value: unknown): Set<string> {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const matches = text
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}_]+/gu);
  return new Set(matches ?? []);
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function identityMatches(
  item: JsonRecord,
  expectedTitle: string,
  expectedCompany: string,
): boolean {
  const title = words(item.title);
  const expectedTitleWords = words(expectedTitle);
  const organization = item.hiringOrganization;
  const companyValue = isRecord(organization) ? organization.name : '';
  const company = words(companyValue);
  const expectedCompanyWords = words(expectedCompany);
  const titleMatch = title.size > 0 && expectedTitleWords.size > 0 && intersects(title, expectedTitleWords);
  const companyMatch =
    expectedCompanyWords.size === 0 || company.size === 0 || intersects(company, expectedCompanyWords);
  return titleMatch && companyMatch;
}

function textIdentityMatches(text: string, title: string, company: string): boolean {
  const titleWords = [...words(title)].filter((word) => word.length >= 4);
  const companyWords = [...words(company)].filter((word) => word.length >= 3);
  return (
    titleWords.length > 0 &&
    titleWords.some((word) => text.includes(word)) &&
    (companyWords.length === 0 || companyWords.some((word) => text.includes(word)))
  );
}

function walkJson(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap((item) => walkJson(item));
  if (!isRecord(value)) return [];
  const result = [value];
  if (Array.isArray(value['@graph'])) result.push(...walkJson(value['@graph']));
  return result;
}

function isJobPosting(item: JsonRecord): boolean {
  const type = item['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
}

function jobPostings(html: string): ParsedPostings {
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gisu;
  const postings: JsonRecord[] = [];
  let malformed = false;
  for (const match of html.matchAll(pattern)) {
    const payload = match[1]?.trim();
    if (payload === undefined || payload === '') {
      malformed = true;
      continue;
    }
    try {
      postings.push(...walkJson(JSON.parse(payload)).filter((item) => isJobPosting(item)));
    } catch {
      malformed = true;
    }
  }
  return { malformed, postings };
}

function validThroughPast(item: JsonRecord, reference: string): boolean {
  if (typeof item.validThrough !== 'string') return false;
  const deadline = Date.parse(item.validThrough);
  const now = Date.parse(reference);
  return Number.isFinite(deadline) && Number.isFinite(now) && deadline < now;
}

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker.toLocaleLowerCase('und')));
}

function attributionMatches(requestedUrl: string, resolvedUrl: string): boolean {
  return sourceIdentity(requestedUrl).canonicalUrl === sourceIdentity(resolvedUrl).canonicalUrl;
}

function responseCode(
  attempt: ResponseAttempt,
  input: ClassificationInput,
  checkedAt: string,
): EvidenceCode {
  if (!attributionMatches(input.url, attempt.resolved_url)) return 'redirect_mismatch';
  if (attempt.status === 404) return 'http_404';
  if (attempt.status === 410) return 'http_410';
  if (attempt.status === 401 || attempt.status === 403) return 'access_denied';
  if (attempt.status === 429) return 'rate_limited';
  if (attempt.status >= 500) return 'server_error';
  if (attempt.status >= 400) return 'parse_error';
  if (
    attempt.decoded_body_bytes !== undefined &&
    attempt.decoded_body_bytes > MAX_DECODED_BODY_BYTES
  ) {
    return 'parse_error';
  }

  const body = attempt.body ?? attempt.body_prefix ?? '';
  const text = normalizeText(body);
  if (containsAny(text, CHALLENGE_MARKERS)) return 'bot_challenge';

  const parsed = jobPostings(body);
  const matching = parsed.postings.filter((item) =>
    identityMatches(item, input.expected_title, input.expected_company ?? ''),
  );
  if (parsed.postings.length > 0 && matching.length === 0) return 'identity_mismatch';
  if (matching.length > 0) {
    return matching.every((item) => validThroughPast(item, checkedAt))
      ? 'valid_through_past'
      : 'jobposting_active';
  }
  if (parsed.malformed) return 'parse_error';

  const identityVerified = textIdentityMatches(
    text,
    input.expected_title,
    input.expected_company ?? '',
  );
  const closedMarkers = [...CLOSED_MARKERS, ...(input.platform_markers?.closed ?? [])];
  const openMarkers = input.platform_markers?.open ?? [];
  if (containsAny(text, closedMarkers)) {
    return identityVerified ? 'platform_closed_marker' : 'identity_unverified';
  }
  if (containsAny(text, openMarkers)) {
    return identityVerified ? 'platform_open_marker' : 'identity_unverified';
  }
  if (containsAny(text, APPLY_MARKERS)) {
    return identityVerified ? 'apply_action_present' : 'identity_unverified';
  }
  return 'identity_unverified';
}

function attemptCount(attempts: readonly FetchAttempt[]): number {
  return attempts.filter((attempt) => attempt.kind !== 'unsafe_url').length;
}

export function classifyAvailability(
  input: ClassificationInput,
  clock: ClassificationClock,
): ClassificationResult {
  if (input.fetch.attempts.length === 0) {
    throw new DomainInvariantError('missing_fetch_observation', 'A fetch observation is required');
  }
  const checkedAt = clock.now();
  if (!Number.isFinite(Date.parse(checkedAt))) {
    throw new DomainInvariantError('invalid_clock', 'Classification clock returned an invalid time');
  }
  const identity = sourceIdentity(input.url).canonicalUrl;
  const finalAttempt = input.fetch.attempts.at(-1);
  if (finalAttempt === undefined) {
    throw new DomainInvariantError('missing_fetch_observation', 'A fetch observation is required');
  }

  let code: EvidenceCode;
  let httpStatus: number | null = null;
  switch (finalAttempt.kind) {
    case 'response':
      code = responseCode(finalAttempt, input, checkedAt);
      httpStatus = finalAttempt.status;
      break;
    case 'timeout':
      code = 'timeout';
      break;
    case 'network_error':
      code = 'network_error';
      break;
    case 'unsafe_url':
      code = 'unsupported_source';
      break;
  }
  return {
    observation: observation(input, identity, checkedAt, code, httpStatus),
    attemptCount: attemptCount(input.fetch.attempts),
  };
}
