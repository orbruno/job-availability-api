# Contract origins

Version: 1.0

The public version 1 authority consists of:

- `openapi/job-availability-v1.yaml` for HTTP operations and responses;
- `schemas/public-api-v1.schema.json` for public request, response, and problem documents;
- `schemas/persisted-availability-v1.schema.json` for local durable state;
- `test/fixtures/` for deterministic domain, correction, compatibility, and boundary examples.

The fixture corpus originated during a controlled replacement of an earlier implementation. Historical `SPEC-015`, `SPEC-018`, and `PYTHON-BASELINE-*` identifiers are retained inside fixture metadata to explain parity and intentional correction cases. They are provenance labels, not dependencies on private files or another runtime.

This repository is self-contained. Contract validation resolves every source-contract record to this public origin note and then validates the complete OpenAPI, schema, manifest, and fixture content locally.
