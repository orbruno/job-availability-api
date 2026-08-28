# Job Availability Contract Fixtures

This directory freezes the language-neutral version 1 contract corpus used by
the Python baseline, TypeScript domain, service API, and n8n node consumers.
Consumers must validate each case-set document against
`availability-fixture-set-v1.schema.json` before evaluating case semantics.

Contract version: 1.0.0

Fixture-set schema version: 1

Frozen clock: 2026-08-27T00:00:00Z

Cases: 65

Case sets:

- `source-identity.v1.json`: 9 canonical source identity cases.
- `observation-classification.v1.json`: 26 fetch and classification cases.
- `availability-state.v1.json`: 13 aggregation, transition, and retention cases.
- `run-state.v1.json`: 6 lifecycle, cancellation, recovery, and retention cases.
- `boundary-security.v1.json`: 5 identifier, redirect, connection, and idempotency cases.
- `persisted-compatibility.v1.json`: 6 persisted JSON compatibility cases.

Expectation values have stable meanings:

- `parity`: the approved contract preserves the Python baseline result.
- `correction`: the approved contract intentionally differs from the baseline;
  `legacy_observed` records the behavior being replaced.
- `new_contract`: the behavior is required by SPEC-018 but has no equivalent
  baseline behavior.

All clocks, URLs, job data, credentials, and identifiers are synthetic. Tests
must use isolated temporary roots and must never read or write canonical product
data. SHA-256 values in `manifest.v1.json` cover the schema and six case-set
files; the manifest does not hash itself.
