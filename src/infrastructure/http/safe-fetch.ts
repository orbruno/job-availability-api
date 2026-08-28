import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

import {
  MAX_DECODED_BODY_BYTES,
  type FetchAttempt,
} from '../../domain/classify-availability.js';
import {
  parseSafeHttpUrl,
  resolveApprovedAddresses,
  systemAddressResolver,
  UnsafeAddressError,
  type AddressResolver,
} from './address-policy.js';

export const FETCH_TOTAL_TIMEOUT_MILLISECONDS = 15_000;
export const MAX_REDIRECTS = 5;
export const MINIMUM_HOST_SPACING_MILLISECONDS = 1_000;
export const MAXIMUM_TRACKED_HOSTS = 4_096;
export const MAXIMUM_CONCURRENT_SOURCE_CHECKS = 4;

export type SafeFetchResult = {
  attempts: FetchAttempt[];
  retryCount: number;
};

export type SafeFetcherOptions = {
  resolver?: AddressResolver;
  timeoutMilliseconds?: number;
  minimumHostSpacingMilliseconds?: number;
  maxRedirects?: number;
  maximumTrackedHosts?: number;
  maximumConcurrentSourceChecks?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  transport?: SafeTransport;
};

export type SafeRequestOptions = RequestOptions & {
  servername: string;
  autoSelectFamily: false;
};

export type SafeTransportResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  decodedBytes: number;
};

export type SafeTransport = (
  options: SafeRequestOptions,
  signal: AbortSignal,
) => Promise<SafeTransportResponse>;

class DecodedBodyLimitError extends Error {}

function abortError(): Error {
  const error = new Error('The source-check deadline elapsed.');
  error.name = 'AbortError';
  return error;
}

class AbortableSemaphore {
  readonly #waiters: { signal: AbortSignal; admit: () => void; abort: () => void }[] = [];
  #active = 0;

  public constructor(private readonly limit: number) {}

  public async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    if (this.#active < this.limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        admit: (): void => {
          signal.removeEventListener('abort', waiter.abort);
          this.#active += 1;
          resolve();
        },
        abort: (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    this.#active -= 1;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined || waiter.signal.aborted) continue;
      waiter.admit();
      return;
    }
  }
}

function publicHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['content-type', 'content-language']) {
    const value = headers[name];
    if (typeof value === 'string') result[name] = value.slice(0, 256);
  }
  return result;
}

function decodedStream(stream: Readable, encoding: string | undefined): Readable {
  const normalized = encoding?.split(',', 1)[0]?.trim().toLowerCase();
  if (normalized === 'gzip' || normalized === 'x-gzip') return stream.pipe(createGunzip());
  if (normalized === 'deflate') return stream.pipe(createInflate());
  if (normalized === 'br') return stream.pipe(createBrotliDecompress());
  return stream;
}

export async function consumeDecodedBody(
  stream: Readable,
  encoding: string | undefined,
): Promise<{ body: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const decoded = decodedStream(stream, encoding);
  try {
    for await (const value of decoded) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      bytes += chunk.length;
      if (bytes > MAX_DECODED_BODY_BYTES) {
        decoded.destroy();
        throw new DecodedBodyLimitError();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof DecodedBodyLimitError) throw error;
    throw new Error('Response decoding failed.', { cause: error });
  }
  return { body: Buffer.concat(chunks).toString('utf8'), bytes };
}

function eligibleRetry(attempt: FetchAttempt): boolean {
  return attempt.kind === 'timeout' || attempt.kind === 'network_error' ||
    (attempt.kind === 'response' && attempt.status >= 500 && attempt.status <= 599);
}

export const nodeTransport: SafeTransport = async (options, signal) => {
  return await new Promise<SafeTransportResponse>((resolve, reject) => {
    const request = options.protocol === 'https:' ? httpsRequest : httpRequest;
    const outbound = request({ ...options, signal }, (response) => {
      void consumeDecodedBody(response, response.headers['content-encoding'])
        .then(({ body, bytes }) => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
          decodedBytes: bytes,
        }))
        .catch((error: unknown) => {
          response.destroy();
          outbound.destroy();
          reject(error instanceof Error ? error : new Error('Response decoding failed.'));
        });
    });
    outbound.once('error', reject);
    outbound.end();
  });
};

export class SafeFetcher {
  readonly #resolver: AddressResolver;
  readonly #timeoutMilliseconds: number;
  readonly #minimumSpacing: number;
  readonly #maxRedirects: number;
  readonly #maximumTrackedHosts: number;
  readonly #sourceChecks: AbortableSemaphore;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #transport: SafeTransport;
  readonly #hostStarts = new Map<string, number>();
  readonly #hostTails = new Map<string, Promise<void>>();

  public constructor(options: SafeFetcherOptions = {}) {
    this.#resolver = options.resolver ?? systemAddressResolver;
    const timeout = options.timeoutMilliseconds ?? FETCH_TOTAL_TIMEOUT_MILLISECONDS;
    const spacing = options.minimumHostSpacingMilliseconds ?? MINIMUM_HOST_SPACING_MILLISECONDS;
    const redirects = options.maxRedirects ?? MAX_REDIRECTS;
    const trackedHosts = options.maximumTrackedHosts ?? MAXIMUM_TRACKED_HOSTS;
    const concurrentChecks = options.maximumConcurrentSourceChecks ?? MAXIMUM_CONCURRENT_SOURCE_CHECKS;
    if (
      !Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(spacing) ||
      spacing < MINIMUM_HOST_SPACING_MILLISECONDS || !Number.isInteger(redirects) || redirects < 0 ||
      !Number.isInteger(trackedHosts) || trackedHosts < 1 || trackedHosts > MAXIMUM_TRACKED_HOSTS ||
      !Number.isInteger(concurrentChecks) || concurrentChecks < 1 ||
      concurrentChecks > MAXIMUM_CONCURRENT_SOURCE_CHECKS
    ) {
      throw new Error('Safe-fetch bounds are invalid.');
    }
    this.#timeoutMilliseconds = Math.min(timeout, FETCH_TOTAL_TIMEOUT_MILLISECONDS);
    this.#minimumSpacing = spacing;
    this.#maxRedirects = Math.min(redirects, MAX_REDIRECTS);
    this.#maximumTrackedHosts = trackedHosts;
    this.#sourceChecks = new AbortableSemaphore(concurrentChecks);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#transport = options.transport ?? nodeTransport;
  }

  public async fetch(rawUrl: string): Promise<SafeFetchResult> {
    const controller = new AbortController();
    const attempts: FetchAttempt[] = [];
    const deadline = this.#now() + this.#timeoutMilliseconds;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<SafeFetchResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        const timedOutAttempts: FetchAttempt[] = [...attempts, { kind: 'timeout' }];
        resolve({
          attempts: timedOutAttempts,
          retryCount: Math.max(0, timedOutAttempts.length - 1),
        });
      }, this.#timeoutMilliseconds);
    });
    const redirectBudget = { remaining: this.#maxRedirects };
    const work = this.#sourceChecks.run(controller.signal, async (): Promise<SafeFetchResult> => {
      for (let number = 0; number < 2; number += 1) {
        const attempt = await this.#fetchRedirectChain(rawUrl, deadline, controller.signal, redirectBudget);
        attempts.push(attempt);
        if (!eligibleRetry(attempt) || number === 1 || this.#now() >= deadline) break;
      }
      return { attempts, retryCount: Math.max(0, attempts.length - 1) };
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') {
        const timedOutAttempts: FetchAttempt[] = [...attempts, { kind: 'timeout' }];
        return { attempts: timedOutAttempts, retryCount: Math.max(0, timedOutAttempts.length - 1) };
      }
      throw error;
    });
    try {
      return await Promise.race([work, timedOut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async connectionOptions(
    url: URL,
    signal?: AbortSignal,
  ): Promise<SafeRequestOptions> {
    const initialResolution = resolveApprovedAddresses(url.hostname, this.#resolver, 'initial');
    if (signal === undefined) await initialResolution;
    else await this.#waitFor(initialResolution, signal);
    if (signal?.aborted === true) {
      const error = new Error('Request deadline elapsed.');
      error.name = 'AbortError';
      throw error;
    }
    const resolver = this.#resolver;
    const lookup: LookupFunction = (hostname, _options, callback) => {
      void resolveApprovedAddresses(hostname, resolver, 'connect')
        .then((addresses) => {
          const selected = addresses[0];
          if (selected === undefined) throw new UnsafeAddressError('connect');
          callback(null, selected.address, selected.family);
        })
        .catch((error: unknown) => callback(error as Error, '', 4));
    };
    return {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/gu, ''),
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: false,
      autoSelectFamily: false,
      lookup,
      servername: url.hostname.replace(/^\[|\]$/gu, ''),
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'br,gzip,deflate',
        Host: url.host,
        'User-Agent': 'job-availability-service/0.1',
      },
    };
  }

  async #fetchRedirectChain(
    rawUrl: string,
    deadline: number,
    signal: AbortSignal,
    redirectBudget: { remaining: number },
  ): Promise<FetchAttempt> {
    let url: URL;
    try {
      url = parseSafeHttpUrl(rawUrl, 'syntax');
    } catch {
      return { kind: 'unsafe_url', stage: 'syntax' };
    }
    for (;;) {
      try {
        await this.#pace(url.hostname, signal);
        if (signal.aborted) {
          const error = new Error('Request deadline elapsed.');
          error.name = 'AbortError';
          throw error;
        }
        const response = await this.#requestOnce(url, deadline, signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;
          if (typeof location !== 'string' || redirectBudget.remaining === 0) {
            return {
              kind: 'response',
              status: response.status,
              resolved_url: url.href,
              body: response.body,
              decoded_body_bytes: response.decodedBytes,
              headers: publicHeaders(response.headers),
            };
          }
          redirectBudget.remaining -= 1;
          url = parseSafeHttpUrl(new URL(location, url).href, 'redirect');
          continue;
        }
        return {
          kind: 'response',
          status: response.status,
          resolved_url: url.href,
          body: response.body,
          decoded_body_bytes: response.decodedBytes,
          headers: publicHeaders(response.headers),
        };
      } catch (error) {
        if (error instanceof UnsafeAddressError) return { kind: 'unsafe_url', stage: error.stage };
        if (error instanceof DecodedBodyLimitError) {
          return {
            kind: 'response',
            status: 200,
            resolved_url: url.href,
            body_prefix: '',
            decoded_body_bytes: MAX_DECODED_BODY_BYTES + 1,
          };
        }
        if (this.#now() >= deadline || (error instanceof Error && error.name === 'AbortError')) {
          return { kind: 'timeout' };
        }
        return { kind: 'network_error' };
      }
    }
  }

  async #requestOnce(url: URL, deadline: number, signal: AbortSignal): Promise<SafeTransportResponse> {
    const options = await this.connectionOptions(url, signal);
    const remaining = deadline - this.#now();
    if (remaining <= 0) {
      const error = new Error('Request deadline elapsed.');
      error.name = 'AbortError';
      throw error;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      if (signal.aborted) controller.abort();
      return await this.#waitFor(this.#transport(options, controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  async #pace(hostname: string, signal: AbortSignal): Promise<void> {
    const prior = this.#hostTails.get(hostname) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.#hostTails.set(hostname, tail);
    try {
      await this.#waitFor(prior, signal);
      const now = this.#now();
      for (const [candidate, started] of this.#hostStarts) {
        if (
          candidate !== hostname && !this.#hostTails.has(candidate) &&
          now - started >= this.#minimumSpacing
        ) {
          this.#hostStarts.delete(candidate);
        }
      }
      if (!this.#hostStarts.has(hostname) && this.#hostStarts.size >= this.#maximumTrackedHosts) {
        throw new Error('The bounded host-pacing table is full.');
      }
      const previous = this.#hostStarts.get(hostname) ?? Number.NEGATIVE_INFINITY;
      const delay = Math.max(0, previous + this.#minimumSpacing - this.#now());
      if (delay > 0) await this.#waitFor(this.#sleep(delay), signal);
      if (signal.aborted) throw abortError();
      this.#hostStarts.set(hostname, this.#now());
    } finally {
      release();
      void tail.then(() => {
        if (this.#hostTails.get(hostname) === tail) this.#hostTails.delete(hostname);
      });
    }
  }

  async #waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError();
    let abort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = (): void => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
