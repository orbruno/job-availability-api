import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export type ResolvedAddress = LookupAddress;
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class UnsafeAddressError extends Error {
  public constructor(public readonly stage: string) {
    super('The target address is not permitted.');
    this.name = 'UnsafeAddressError';
  }
}

function ipv4Octets(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const values = address.split('.').map(Number);
  return values.length === 4 ? values : null;
}

function isPublicIpv4(address: string): boolean {
  const values = ipv4Octets(address);
  if (values === null) return false;
  const [a = 0, b = 0, c = 0] = values;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function firstIpv6Hextets(address: string): readonly number[] | null {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? '';
  if (isIP(normalized) !== 6) return null;
  const embedded = (/(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized))?.[1];
  let input = normalized;
  if (embedded !== undefined) {
    const octets = ipv4Octets(embedded);
    if (octets === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    input = normalized.slice(0, -embedded.length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = (halves[0] ?? '').split(':').filter(Boolean);
  const right = (halves[1] ?? '').split(':').filter(Boolean);
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function isPublicIpv6(address: string): boolean {
  const parts = firstIpv6Hextets(address);
  if (parts === null) return false;
  const [first = 0, second = 0] = parts;
  // Only ordinary global unicast is eligible. Current IANA special-purpose space remains fail-closed.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && second <= 0x0fff) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address.split('%', 1)[0] ?? address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

export function parseSafeHttpUrl(value: string, stage = 'syntax'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeAddressError(stage);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new UnsafeAddressError(stage);
  }
  if (url.hostname === '' || url.href.length > 2048) throw new UnsafeAddressError(stage);
  return url;
}

export const systemAddressResolver: AddressResolver = async (hostname) => {
  return await dnsLookup(hostname.replace(/^\[|\]$/gu, ''), { all: true, verbatim: true });
};

export async function resolveApprovedAddresses(
  hostname: string,
  resolver: AddressResolver = systemAddressResolver,
  stage = 'resolution',
): Promise<readonly ResolvedAddress[]> {
  const plainHostname = hostname.replace(/^\[|\]$/gu, '');
  const literalFamily = isIP(plainHostname);
  const resolved =
    literalFamily === 0
      ? await resolver(plainHostname)
      : [{ address: plainHostname, family: literalFamily as 4 | 6 }];
  if (resolved.length === 0 || resolved.some((entry) => !isPublicAddress(entry.address))) {
    throw new UnsafeAddressError(stage);
  }
  return resolved;
}
