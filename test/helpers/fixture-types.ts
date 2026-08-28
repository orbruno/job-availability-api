export type FixtureExpectation = 'parity' | 'correction' | 'new_contract';

export type FixtureCase<Input, Expected> = {
  id: string;
  expectation: FixtureExpectation;
  requirements: string[];
  source_refs: string[];
  input: Input;
  expected: Expected;
  legacy_observed?: unknown;
};

export type FixtureSet<Input, Expected> = {
  fixture_set_schema_version: 1;
  fixture_type: string;
  contract_version: string;
  frozen_clock: string;
  cases: FixtureCase<Input, Expected>[];
};
