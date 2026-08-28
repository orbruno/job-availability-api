import { describe, expect, it } from 'vitest';

import {
  API_CONTRACT_VERSION,
  API_SCHEMA_VERSION,
  AVAILABILITY_STATUSES,
  EVIDENCE_CODES,
  EVIDENCE_OUTCOMES,
  RUN_STATUSES,
} from '../../src/contracts/contract-version.js';

describe('contract vocabulary', () => {
  it('freezes the versioned vocabulary', () => {
    expect(API_CONTRACT_VERSION).toBe('1.0.0');
    expect(API_SCHEMA_VERSION).toBe(1);
    expect(AVAILABILITY_STATUSES).toHaveLength(5);
    expect(EVIDENCE_OUTCOMES).toHaveLength(3);
    expect(RUN_STATUSES).toHaveLength(5);
    expect(EVIDENCE_CODES).toHaveLength(18);
    expect(new Set(EVIDENCE_CODES)).toHaveLength(EVIDENCE_CODES.length);
  });
});
