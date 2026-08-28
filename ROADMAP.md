# Roadmap

This roadmap describes the intended public release path for Job Availability API. It does not promise delivery dates. User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md), and proposed work is tracked in [GitHub Issues](https://github.com/orbruno/job-availability-api/issues).

## 0.1.0 public-source candidate — complete

- Publish the versioned API, schemas, implementation, tests, and local container definition.
- Document private self-hosting and n8n connectivity.
- Validate the frozen contract, 245-test suite, production build, dependency audit, and isolated runtime smoke.
- Keep the default deployment local, single-operator, authenticated, and bound to host loopback.

## 0.1.x self-hosted release — planned

- Complete sustained shadow evaluation against representative workloads.
- Finish backup, restore, rollback, and token-rotation drills on the intended deployment host.
- Publish immutable source releases with checksums and documented upgrade steps.
- Verify the paired n8n package against the exact released API version.

## Later improvements — under evaluation

- Provide an explicit standalone inventory-onboarding interface without weakening path, persistence, or single-writer guarantees.
- Expand compatibility testing across relevant Node.js and container-engine release lines.
- Evaluate signed container-image publication after a separate release and supply-chain review.
- Improve diagnostics while preserving the strict telemetry and privacy allowlist.

## Scope boundaries

The current service remains private, local-first, and single-operator. Hosted multi-tenancy, public-internet exposure, user accounts, organization administration, billing, browser automation, and horizontally scaled writers are outside the current architecture.
