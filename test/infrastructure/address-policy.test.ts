import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  isPublicAddress,
  parseSafeHttpUrl,
  resolveApprovedAddresses,
  UnsafeAddressError,
} from '../../src/infrastructure/http/address-policy.js';
import {
  consumeDecodedBody,
  nodeTransport,
  SafeFetcher,
  type SafeRequestOptions,
  type SafeTransportResponse,
} from '../../src/infrastructure/http/safe-fetch.js';

async function guardedConnect(options: SafeRequestOptions): Promise<void> {
  const lookup = options.lookup;
  const hostname = options.hostname;
  if (lookup === undefined || typeof hostname !== 'string') throw new Error('Missing guarded connection options.');
  await new Promise<void>((resolve, reject) => {
    lookup(hostname, {}, (error) => error === null ? resolve() : reject(error));
  });
}

function transportResponse(
  status: number,
  headers: Record<string, string> = {},
  body = '',
): SafeTransportResponse {
  return { status, headers, body, decodedBytes: Buffer.byteLength(body) };
}

function abortNamedError(): Error {
  const error = new Error('deadline');
  error.name = 'AbortError';
  return error;
}

describe('outbound address policy', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff00::1',
    '2001:0::1', '2001:1::1', '2001:2::1', '2001:20::1', '2001:30::1',
    '2001:db8::1', '2002:0a00:1::1', '3fff::1',
  ])('rejects special-use address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'permits global unicast address %s',
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it('normalizes unusual numeric IPv4 before applying the policy', () => {
    expect(parseSafeHttpUrl('http://127.1/').hostname).toBe('127.0.0.1');
    expect(parseSafeHttpUrl('http://0x7f000001/').hostname).toBe('127.0.0.1');
    expect(parseSafeHttpUrl('http://2130706433/').hostname).toBe('127.0.0.1');
    expect(parseSafeHttpUrl('http://0177.0.0.1/').hostname).toBe('127.0.0.1');
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/file', 'http://user:pass@example.com/'])(
    'rejects unsafe URL syntax %s',
    (value) => expect(() => parseSafeHttpUrl(value)).toThrow(UnsafeAddressError),
  );

  it('rejects a hostname if any resolved address is unsafe', async () => {
    await expect(resolveApprovedAddresses('example.test', () => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]))).rejects.toThrow(UnsafeAddressError);
  });

  it('rechecks DNS at connection time and detects rebinding', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => {
        calls += 1;
        return Promise.resolve([{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
      },
      minimumHostSpacingMilliseconds: 1_000,
    });
    const options = await fetcher.connectionOptions(new URL('https://example.test/path'));
    expect(options.headers).toMatchObject({ Host: 'example.test' });
    expect(options.servername).toBe('example.test');
    const lookup = options.lookup;
    expect(lookup).toBeTypeOf('function');
    if (lookup === undefined) throw new Error('Guarded lookup was not installed.');
    const error = await new Promise<Error | null>((resolve) => {
      lookup('example.test', {}, (lookupError) => resolve(lookupError));
    });
    expect(error).toBeInstanceOf(UnsafeAddressError);
  });

  it('enforces the decoded two-MiB cap after gzip expansion', async () => {
    const compressed = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await expect(consumeDecodedBody(Readable.from(compressed), 'gzip')).rejects.toThrow();
  });

  it('destroys the originating HTTP response when decoded content exceeds the cap', async () => {
    const compressed = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    let markClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const server = createServer((_request, response) => {
      response.setHeader('Content-Encoding', 'gzip');
      response.once('close', markClosed);
      response.write(compressed);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server did not bind.');
    try {
      await expect(nodeTransport({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: address.port,
        path: '/',
        method: 'GET',
        agent: false,
        autoSelectFamily: false,
        servername: '127.0.0.1',
        headers: { Host: `127.0.0.1:${String(address.port)}` },
      }, AbortSignal.timeout(2_000))).rejects.toThrow();
      await expect(Promise.race([
        closed,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('socket remained open')), 500)),
      ])).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('decodes a bounded gzip response', async () => {
    const compressed = gzipSync(Buffer.from('bounded response'));
    await expect(consumeDecodedBody(Readable.from(compressed), 'gzip')).resolves.toEqual({
      body: 'bounded response',
      bytes: 16,
    });
  });

  it('returns at the total deadline and releases concurrency when DNS does not settle', async () => {
    let transportCalls = 0;
    const fetcher = new SafeFetcher({
      resolver: async (hostname) => hostname.startsWith('stuck-')
        ? await new Promise(() => undefined)
        : [{ address: '93.184.216.34', family: 4 }],
      timeoutMilliseconds: 20,
      minimumHostSpacingMilliseconds: 1_000,
      transport: async (options) => {
        await guardedConnect(options);
        transportCalls += 1;
        return transportResponse(200);
      },
    });
    const started = Date.now();
    const stuck = await Promise.all(Array.from({ length: 5 }, async (_, index) =>
      await fetcher.fetch(`https://stuck-${String(index)}.example/job`)));
    expect(stuck.every((result) => result.attempts.at(-1)?.kind === 'timeout')).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    await expect(fetcher.fetch('https://healthy.example/job'))
      .resolves.toMatchObject({ attempts: [expect.objectContaining({ kind: 'response', status: 200 })] });
    expect(transportCalls).toBe(1);
  });

  it('retains the completed first attempt when the eligible retry reaches the total deadline', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      timeoutMilliseconds: 20,
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options, signal) => {
        await guardedConnect(options);
        calls += 1;
        if (calls === 1) return transportResponse(503);
        return await new Promise<SafeTransportResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('deadline');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(result.retryCount).toBe(1);
    expect(result.attempts).toEqual([
      expect.objectContaining({ kind: 'response', status: 503 }),
      { kind: 'timeout' },
    ]);
  });

  it('includes source-check admission in the deadline and caps process concurrency at four', async () => {
    let active = 0;
    let calls = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return transportResponse(200);
      },
    });
    const pending = Array.from({ length: 8 }, async (_, index) =>
      await fetcher.fetch(`https://host-${String(index)}.example/job`));
    await vi.waitFor(() => expect(calls).toBe(4));
    expect(active).toBe(4);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(calls).toBe(8));
    expect(maximumActive).toBe(4);
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all(pending)).resolves.toHaveLength(8);
    expect(maximumActive).toBe(4);

    let admitted = 0;
    const deadlineFetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      timeoutMilliseconds: 20,
      minimumHostSpacingMilliseconds: 1_000,
      maximumConcurrentSourceChecks: 1,
      transport: async (_options, signal) => {
        admitted += 1;
        return await new Promise<SafeTransportResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortNamedError()), { once: true });
        });
      },
    });
    const started = Date.now();
    const [first, queued] = await Promise.all([
      deadlineFetcher.fetch('https://first.example/job'),
      deadlineFetcher.fetch('https://queued.example/job'),
    ]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(admitted).toBe(1);
    expect(first.attempts.at(-1)).toEqual({ kind: 'timeout' });
    expect(queued).toEqual({ attempts: [{ kind: 'timeout' }], retryCount: 0 });
  });

  it('retries one eligible 5xx response and returns the successful second attempt', async () => {
    const responses = [transportResponse(503), transportResponse(200, {}, 'Data Engineer Acme Apply now')];
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        const response = responses.shift();
        if (response === undefined) throw new Error('Unexpected transport call.');
        return response;
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(result.retryCount).toBe(1);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.at(-1)).toMatchObject({ kind: 'response', status: 200 });
  });

  it('never performs more than one eligible retry', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        return transportResponse(503);
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(calls).toBe(2);
    expect(result).toMatchObject({ retryCount: 1 });
  });

  it('retries one transient transport failure and then succeeds', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        if (calls === 1) throw new Error('transient network failure');
        return transportResponse(200);
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(result).toMatchObject({ retryCount: 1 });
    expect(result.attempts).toEqual([
      { kind: 'network_error' },
      expect.objectContaining({ kind: 'response', status: 200 }),
    ]);
  });

  it('does not retry a terminal 404', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        return transportResponse(404);
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(calls).toBe(1);
    expect(result.retryCount).toBe(0);
  });

  it('revalidates a redirect and refuses a private target before transport', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        return transportResponse(302, { location: 'http://127.0.0.1/internal' });
      },
    });
    const result = await fetcher.fetch('https://example.com/jobs/one');
    expect(calls).toBe(1);
    expect(result.attempts.at(-1)).toMatchObject({ kind: 'unsafe_url', stage: 'initial' });
  });

  it('follows a bounded manual redirect while preserving each hop Host and TLS SNI', async () => {
    const hosts: string[] = [];
    const names: string[] = [];
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        hosts.push(String((options.headers as Record<string, string>).Host));
        names.push(options.servername);
        calls += 1;
        return calls === 1
          ? transportResponse(302, { location: 'https://jobs.example.net/final' })
          : transportResponse(200, {}, 'final');
      },
    });
    const result = await fetcher.fetch('https://example.com/start');
    expect(hosts).toEqual(['example.com', 'jobs.example.net']);
    expect(names).toEqual(hosts);
    expect(result.attempts.at(-1)).toMatchObject({ resolved_url: 'https://jobs.example.net/final' });
  });

  it('stops after the configured redirect cap', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        return transportResponse(302, { location: `/redirect-${String(calls)}` });
      },
    });
    const result = await fetcher.fetch('https://example.com/start');
    expect(calls).toBe(6);
    expect(result.attempts.at(-1)).toMatchObject({ kind: 'response', status: 302 });
  });

  it('shares the five-redirect budget across the eligible retry', async () => {
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        if (calls <= 5) return transportResponse(302, { location: `/redirect-${String(calls)}` });
        if (calls === 6) return transportResponse(503);
        return transportResponse(302, { location: '/must-not-be-followed' });
      },
    });
    const result = await fetcher.fetch('https://example.com/start');
    expect(calls).toBe(7);
    expect(result.retryCount).toBe(1);
    expect(result.attempts).toEqual([
      expect.objectContaining({ kind: 'response', status: 503 }),
      expect.objectContaining({ kind: 'response', status: 302 }),
    ]);
  });

  it('applies configured per-host spacing between redirect hops', async () => {
    let current = 1_000;
    const sleeps: number[] = [];
    let calls = 0;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      now: () => current,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        current += milliseconds;
        return Promise.resolve();
      },
      transport: async (options) => {
        await guardedConnect(options);
        calls += 1;
        return calls === 1
          ? transportResponse(302, { location: '/second' })
          : transportResponse(200);
      },
    });
    await fetcher.fetch('https://example.com/first');
    expect(sleeps).toEqual([1_000]);
  });

  it('bounds high-cardinality host pacing state and admits new hosts after expiry', async () => {
    let current = 1_000;
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      minimumHostSpacingMilliseconds: 1_000,
      maximumTrackedHosts: 8,
      now: () => current,
      sleep: () => Promise.resolve(),
      transport: async (options) => {
        await guardedConnect(options);
        return transportResponse(200);
      },
    });
    for (let index = 0; index < 8; index += 1) {
      await expect(fetcher.fetch(`https://host-${String(index)}.example/job`))
        .resolves.toMatchObject({ attempts: [expect.objectContaining({ kind: 'response' })] });
    }
    await expect(fetcher.fetch('https://ninth.example/job'))
      .resolves.toEqual({
        attempts: [{ kind: 'network_error' }, { kind: 'network_error' }],
        retryCount: 1,
      });
    current += 1_000;
    await expect(fetcher.fetch('https://ninth.example/job'))
      .resolves.toMatchObject({ attempts: [expect.objectContaining({ kind: 'response' })] });
  });

  it('does not apply proxy environment variables to connection options', async () => {
    const fetcher = new SafeFetcher({
      resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    });
    const options = await fetcher.connectionOptions(new URL('https://example.com/job'));
    expect(options.agent).toBe(false);
    expect(options).not.toHaveProperty('proxy');
    expect(options).not.toHaveProperty('socketPath');
  });

  it.each([Number.NaN, -1, 0, 999, Number.POSITIVE_INFINITY])('rejects invalid host spacing %s', (spacing) => {
    expect(() => new SafeFetcher({ minimumHostSpacingMilliseconds: spacing })).toThrow();
  });

  it.each([0, 4_097, 1.5])('rejects an invalid host-tracking bound %s', (maximumTrackedHosts) => {
    expect(() => new SafeFetcher({ maximumTrackedHosts })).toThrow();
  });
});
