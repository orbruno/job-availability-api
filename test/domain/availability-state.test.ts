import { describe, expect, it } from 'vitest';

import {
  parseSourceObservation,
  type AvailabilityState,
  type AvailabilityStatus,
  type SourceObservation,
} from '../../src/domain/availability-contracts.js';
import {
  aggregateSourceStatus,
  applyObservations,
  defaultAvailabilityState,
} from '../../src/domain/availability-state.js';
import fixtureJson from '../fixtures/availability-state.v1.json' with { type: 'json' };
import type { FixtureSet } from '../helpers/fixture-types.js';

type AggregateInput = {
  operation: 'aggregate';
  observations: SourceObservation[];
};

type ApplyInput = {
  operation: 'apply_observations';
  run_id: string;
  previous: AvailabilityState;
  observations: SourceObservation[];
};

type StateInput = AggregateInput | ApplyInput;

type StateExpected = {
  status: AvailabilityStatus;
  closure_run_ids?: string[];
  last_run_id?: string;
  last_checked_at?: string;
  transition?: string;
  history_run_ids?: string[];
  retained_history_run_ids?: string[];
  removed_history_run_ids?: string[];
  history_count?: number;
  closure_streak_advanced?: boolean;
  reopened?: boolean;
};

const fixture = fixtureJson as unknown as FixtureSet<StateInput, StateExpected>;

describe('availability aggregation and state fixtures', () => {
  it.each(fixture.cases)('$id', ({ input, expected }) => {
    const observations = input.observations.map((item) => parseSourceObservation(item));
    if (input.operation === 'aggregate') {
      expect(aggregateSourceStatus(observations)).toBe(expected.status);
      return;
    }

    const unchanged = structuredClone(input.previous);
    const result = applyObservations(input.previous, input.run_id, observations, {
      now: () => fixture.frozen_clock,
    });
    expect(result.status).toBe(expected.status);
    if (expected.closure_run_ids !== undefined) {
      expect(result.closure_run_ids).toEqual(expected.closure_run_ids);
    }
    if (expected.last_run_id !== undefined) expect(result.last_run_id).toBe(expected.last_run_id);
    if (expected.last_checked_at !== undefined) {
      expect(result.last_checked_at).toBe(expected.last_checked_at);
    }
    if (expected.history_run_ids !== undefined) {
      expect(result.history.map((entry) => entry.run_id)).toEqual(expected.history_run_ids);
    }
    if (expected.retained_history_run_ids !== undefined) {
      expect(result.history.map((entry) => entry.run_id)).toEqual(
        expected.retained_history_run_ids,
      );
    }
    if (expected.removed_history_run_ids !== undefined) {
      const retained = new Set(result.history.map((entry) => entry.run_id));
      expect(
        input.previous.history
          .map((entry) => entry.run_id)
          .filter((runId) => !retained.has(runId)),
      ).toEqual(expected.removed_history_run_ids);
    }
    if (expected.history_count !== undefined) expect(result.history).toHaveLength(expected.history_count);
    if (expected.transition !== undefined) {
      expect(`${input.previous.status}->${result.status}`).toBe(expected.transition);
    }
    if (expected.closure_streak_advanced !== undefined) {
      expect(result.closure_run_ids.length > input.previous.closure_run_ids.length).toBe(
        expected.closure_streak_advanced,
      );
    }
    if (expected.reopened !== undefined) {
      expect(
        result.status === 'open' &&
          (input.previous.status === 'closed' || input.previous.status === 'likely_closed'),
      ).toBe(expected.reopened);
    }
    expect(input.previous).toEqual(unchanged);
  });

  it('uses the injected clock when a transition has no source timestamp', () => {
    const state = applyObservations(defaultAvailabilityState('job-1'), 'run-empty', [], {
      now: () => fixture.frozen_clock,
    });
    expect(state.last_checked_at).toBe(fixture.frozen_clock);
    expect(state.history).toHaveLength(1);
  });

  it('replaces rather than duplicates history when the same run is retried', () => {
    const fixtureCase = fixture.cases.find(
      (item) => item.id === 'state.first-distinct-closed-run-is-likely-closed',
    );
    if (fixtureCase?.input.operation !== 'apply_observations') {
      throw new Error('same-run closure fixture is missing');
    }
    const first = applyObservations(
      fixtureCase.input.previous,
      fixtureCase.input.run_id,
      fixtureCase.input.observations,
      { now: () => fixture.frozen_clock },
    );
    const retry = applyObservations(
      first,
      fixtureCase.input.run_id,
      fixtureCase.input.observations,
      { now: () => fixture.frozen_clock },
    );
    expect(retry.closure_run_ids).toEqual([fixtureCase.input.run_id]);
    expect(retry.history.map((entry) => entry.run_id)).toEqual([fixtureCase.input.run_id]);
  });
});
