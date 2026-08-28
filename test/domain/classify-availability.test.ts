import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_CODES,
  DomainInvariantError,
  type AvailabilityStatus,
  type SourceObservation,
} from '../../src/domain/availability-contracts.js';
import { aggregateSourceStatus } from '../../src/domain/availability-state.js';
import {
  classifyAvailability,
  type ClassificationInput,
} from '../../src/domain/classify-availability.js';
import boundaryJson from '../fixtures/boundary-security.v1.json' with { type: 'json' };
import classificationJson from '../fixtures/observation-classification.v1.json' with {
  type: 'json',
};
import type { FixtureCase, FixtureSet } from '../helpers/fixture-types.js';

type ClassificationExpected = {
  observation: SourceObservation;
  aggregate_status: AvailabilityStatus;
  attempt_count: number;
};

const classificationFixture = classificationJson as unknown as FixtureSet<
  ClassificationInput,
  ClassificationExpected
>;
const boundaryFixture = boundaryJson as unknown as FixtureSet<
  ClassificationInput,
  ClassificationExpected
>;
const boundaryCorrectionIds = new Set([
  'redirect-unrelated-404-inconclusive',
  'redirect-unrelated-410-inconclusive',
]);
const boundaryCorrections = boundaryFixture.cases.filter((item) =>
  boundaryCorrectionIds.has(item.id),
);
const cases: FixtureCase<ClassificationInput, ClassificationExpected>[] = [
  ...classificationFixture.cases,
  ...boundaryCorrections,
];

describe('deterministic classification fixture corpus', () => {
  it.each(cases)('$id', ({ input, expected }) => {
    const unchanged = structuredClone(input);
    const result = classifyAvailability(input, {
      now: () => classificationFixture.frozen_clock,
    });
    expect(result.observation).toEqual(expected.observation);
    expect(result.attemptCount).toBe(expected.attempt_count);
    expect(aggregateSourceStatus([result.observation])).toBe(expected.aggregate_status);
    expect(input).toEqual(unchanged);
  });

  it('covers every frozen evidence code and all identity-first corrections', () => {
    const observedCodes = new Set(
      classificationFixture.cases.map((item) => item.expected.observation.evidence_code),
    );
    expect(observedCodes).toEqual(new Set(EVIDENCE_CODES));
    expect(classificationFixture.cases.filter((item) => item.expectation === 'correction')).toHaveLength(
      3,
    );
    expect(boundaryCorrections).toHaveLength(2);
    expect(boundaryCorrections.every((item) => item.expectation === 'correction')).toBe(true);
  });

  it('requires an injected observation trace and a valid injected clock', () => {
    const input = classificationFixture.cases[0]?.input;
    if (input === undefined) throw new Error('classification fixture is empty');
    expect(() =>
      classifyAvailability({ ...input, fetch: { attempts: [] } }, { now: () => 'invalid' }),
    ).toThrow(DomainInvariantError);
    expect(() => classifyAvailability(input, { now: () => 'invalid' })).toThrow(
      DomainInvariantError,
    );
  });

});
