import { DomainInvariantError } from './availability-contracts.js';

const JOB_ID_QUERY_KEYS = ['jk', 'jid', 'gh_jid', 'jobid', 'job_id', 'job'] as const;
const TRACKING_QUERY_PREFIXES = ['utm_'] as const;
const TRACKING_QUERY_KEYS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'referrer',
  'referer',
  'source',
  'src',
  'campaign',
  'campaignid',
  'medium',
  'trk',
  'trkid',
  'tracking',
  'trackingid',
  'sid',
  'cid',
  'vjk',
  'from',
  'hl',
  'lang',
  'locale',
  'tk',
  'xkcb',
  'xpse',
  'xfps',
]);

export type SourceIdentity = {
  canonicalUrl: string;
  nativeJobId: string | null;
};

function isTrackingKey(key: string): boolean {
  return (
    TRACKING_QUERY_KEYS.has(key) ||
    TRACKING_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function canonicalPath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/gu, '/');
  if (collapsed === '' || collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function canonicalQuery(url: URL): Map<string, string> {
  const query = new Map<string, string>();
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    if (value !== '') query.set(key, value);
  }
  return query;
}

function findNativeJobId(
  hostname: string,
  path: string,
  query: ReadonlyMap<string, string>,
): string | null {
  for (const key of JOB_ID_QUERY_KEYS) {
    const value = query.get(key);
    if (value !== undefined) {
      const prefix = hostname.includes('indeed.') && key === 'jk' ? 'ind' : key;
      return `${prefix}:${value.toLowerCase()}`;
    }
  }
  const indeedAd = query.get('ad');
  if (hostname.includes('indeed.') && indeedAd !== undefined) {
    return `ind-ad:${indeedAd.toLowerCase()}`;
  }
  if (hostname.includes('stepstone')) {
    const match = /-(\d{6,10})\.html$/iu.exec(path);
    if (match?.[1] !== undefined) return `ss:${match[1]}`;
  }
  const numericPath = /\/(\d{4,16})(?:\/|$)/u.exec(path);
  return numericPath?.[1] === undefined ? null : `path:${numericPath[1]}`;
}

function comparePair(left: readonly [string, string], right: readonly [string, string]): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? -1 : 1;
}

export function sourceIdentity(value: string): SourceIdentity {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DomainInvariantError('invalid_source_url', 'Source URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new DomainInvariantError('invalid_source_url', 'Source URL is unsupported');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (hostname === '') {
    throw new DomainInvariantError('invalid_source_url', 'Source URL has no hostname');
  }
  const host = parsed.port === '' ? hostname : `${hostname}:${parsed.port}`;
  const path = canonicalPath(parsed.pathname);
  const query = canonicalQuery(parsed);
  const native = findNativeJobId(hostname, path, query);
  if (native !== null) {
    return { canonicalUrl: `${host}/__job__/${native}`, nativeJobId: native };
  }

  const identifying = [...query.entries()]
    .filter(([key]) => !isTrackingKey(key))
    .sort(comparePair);
  const suffix = identifying.length === 0 ? '' : `?${new URLSearchParams(identifying).toString()}`;
  return { canonicalUrl: `${host}${path}${suffix}`, nativeJobId: null };
}

export function normalizeSourceUrl(value: string): string {
  return sourceIdentity(value).canonicalUrl;
}

export function nativeJobId(value: string): string | null {
  return sourceIdentity(value).nativeJobId;
}
