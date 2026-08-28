# Contributing

## Development setup

Use Node.js 22.22.0 or 24.19.0 and npm 11.6.2. Install exactly from the committed lockfile:

```sh
npm ci --ignore-scripts
```

## Required checks

Run the complete gate before submitting a change:

```sh
npm run check:runtime
```

The gate runs linting, strict type-checking, OpenAPI/schema/fixture validation, 245 tests, a production build, and an isolated authenticated runtime smoke test. Add or update tests whenever a contract, domain rule, trust boundary, persistence behavior, operational default, or deployment artifact changes.

## Design boundaries

- Keep domain modules independent from HTTP, network, filesystem, environment, telemetry, n8n, and the system clock.
- Preserve strict runtime validation at API, storage, and network boundaries.
- Keep one writer per data root; do not introduce multi-worker write claims without a new design and migration contract.
- Keep secrets, posting content, source URLs, workflow payloads, and personal data out of fixtures, logs, screenshots, and issues.
- Treat changes to OpenAPI, JSON Schema, evidence rules, persisted state, bounds, or idempotency as versioned contract changes.
- Use only synthetic temporary data in tests and examples.

Use concise English documentation and add a user-visible changelog entry when behavior changes.
