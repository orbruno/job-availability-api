import { describe, expect, it } from 'vitest';

import { DomainInvariantError } from '../../src/domain/availability-contracts.js';
import { sourceIdentity } from '../../src/domain/source-identity.js';
import fixtureJson from '../fixtures/source-identity.v1.json' with { type: 'json' };
import type { FixtureSet } from '../helpers/fixture-types.js';

type IdentityInput = {
  urls: string[];
};

type IdentityExpected = {
  canonical_urls: string[];
  native_job_ids: (string | null)[];
  equivalent: boolean;
};

const fixture = fixtureJson as unknown as FixtureSet<IdentityInput, IdentityExpected>;

describe('source identity fixture corpus', () => {
  it.each(fixture.cases)('$id', ({ input, expected }) => {
    const identities = input.urls.map((url) => sourceIdentity(url));
    expect(identities.map((identity) => identity.canonicalUrl)).toEqual(
      expected.canonical_urls,
    );
    expect(identities.map((identity) => identity.nativeJobId)).toEqual(
      expected.native_job_ids,
    );
    expect(new Set(identities.map((identity) => identity.canonicalUrl)).size === 1).toBe(
      expected.equivalent,
    );
  });

  it.each([
    'ftp://jobs.example.com/1234',
    'https://operator:secret@jobs.example.com/1234',
    'not a URL',
  ])('rejects unsupported source syntax: %s', (url) => {
    expect(() => sourceIdentity(url)).toThrow(DomainInvariantError);
  });
});
