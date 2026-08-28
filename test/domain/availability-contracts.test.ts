import { describe, expect, it } from 'vitest';

import {
  CLOSED_EVIDENCE,
  EVIDENCE_CODES,
  INCONCLUSIVE_EVIDENCE,
  OPEN_EVIDENCE,
  DomainInvariantError,
  evidenceOutcomeForCode,
  parseSourceObservation,
  type SourceObservation,
} from '../../src/domain/availability-contracts.js';
import classificationJson from '../fixtures/observation-classification.v1.json' with {
  type: 'json',
};
import persistedJson from '../fixtures/persisted-compatibility.v1.json' with { type: 'json' };
import type { FixtureSet } from '../helpers/fixture-types.js';

type ClassificationInput = Record<string, unknown>;
type ClassificationExpected = {
  observation: SourceObservation;
};

type PersistedInput = {
  schema_name: string;
  document: Record<string, unknown>;
};

type PersistedExpected = {
  valid: boolean;
  reason?: string;
};

const classificationFixture = classificationJson as unknown as FixtureSet<
  ClassificationInput,
  ClassificationExpected
>;
const persistedFixture = persistedJson as unknown as FixtureSet<PersistedInput, PersistedExpected>;

describe('availability contracts and evidence invariants', () => {
  it('partitions all 18 evidence codes into one required outcome', () => {
    const allCodes = [...OPEN_EVIDENCE, ...CLOSED_EVIDENCE, ...INCONCLUSIVE_EVIDENCE];
    expect(allCodes).toHaveLength(EVIDENCE_CODES.length);
    expect(new Set(allCodes)).toEqual(new Set(EVIDENCE_CODES));
    expect(OPEN_EVIDENCE.size).toBe(3);
    expect(CLOSED_EVIDENCE.size).toBe(4);
    expect(INCONCLUSIVE_EVIDENCE.size).toBe(11);
    for (const code of OPEN_EVIDENCE) expect(evidenceOutcomeForCode(code)).toBe('open');
    for (const code of CLOSED_EVIDENCE) expect(evidenceOutcomeForCode(code)).toBe('closed');
    for (const code of INCONCLUSIVE_EVIDENCE) {
      expect(evidenceOutcomeForCode(code)).toBe('inconclusive');
    }
  });

  it.each(classificationFixture.cases)('parses frozen observation $id', ({ expected }) => {
    expect(parseSourceObservation(expected.observation)).toEqual(expected.observation);
  });

  it('rejects the frozen mismatch correction and unknown observation fields', () => {
    const mismatch = persistedFixture.cases.find(
      (item) => item.id === 'compatibility-rejects-outcome-evidence-mismatch',
    );
    const observations = mismatch?.input.document.observations;
    if (!Array.isArray(observations) || observations[0] === undefined) {
      throw new Error('persisted mismatch fixture is missing its observation');
    }
    expect(() => parseSourceObservation(observations[0])).toThrow(
      expect.objectContaining({ code: 'outcome_evidence_mismatch' }),
    );
    expect(() =>
      parseSourceObservation({ ...classificationFixture.cases[0]?.expected.observation, extra: true }),
    ).toThrow(DomainInvariantError);
  });
});
