# Contract Scripts

`validate-contracts.mjs` validates the OpenAPI document, JSON Schemas, manifest hashes, fixture envelopes, coverage, and all schema-bound examples. It exits nonzero on any drift.

`source-identity.mjs` produces a deterministic SHA-256 identity for the package source tree, including link targets while excluding generated, dependency, and coverage folders.

`generate-token.mjs` writes one 32-byte base64url token to standard output. Redirect it only to a local mode-0600 secret file; never to a tracked file.

`healthcheck.mjs` performs the authenticated credential test without printing the token or response body.

`recover-stale-lock.mjs` removes a crash-stale same-host writer lock only after exact owner confirmation and a negative operating-system process-liveness check.

`runtime-smoke.mjs` starts the built service against a temporary synthetic root on registered port 5002 and verifies credential, scheduled-create, persistence, cancellation, graceful lock release, and cleanup.

`benchmark-isolated.mjs` runs a bounded scheduled-run API benchmark against an ephemeral loopback server and temporary synthetic root. It reports hardware, job count, concurrency, latency percentiles, throughput, error rate, retry rate, and RSS. Set `BENCHMARK_JOB_COUNT=1000 BENCHMARK_ITERATIONS=1 BENCHMARK_CONCURRENCY=1` to exercise the scheduled-inventory ceiling.
