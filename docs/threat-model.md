# Threat model

Version: 1.0

Protected assets: operator service token, canonical job and run state, source content, local filesystem paths, workflow payloads, and the integrity of closure decisions.

Trust boundaries: unauthenticated local-network input; authenticated n8n requests; untrusted posting URLs, redirects, DNS, headers, compression, and content; canonical JSON read from disk; operator-provided secret files; telemetry sinks.

Primary threats and controls:

- SSRF and metadata access: HTTP(S) only, no userinfo, conservative fail-closed IPv4/IPv6 global-unicast policy derived from the [IANA special-purpose address registries](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml), full initial and redirect revalidation, guarded connection-time lookup, manual redirects, no proxy-environment use, and tests for alternate numeric IPv4, mapped IPv6, Teredo, 6to4, ORCHID, private, loopback, link-local, documentation, multicast, and reserved ranges.
- DNS rebinding: pre-resolution and a second resolution in the actual connection lookup; any unsafe result rejects the request. The original hostname remains the HTTP Host and TLS SNI value.
- Resource exhaustion: 64 simultaneous inbound connections, 16-KiB aggregate request headers, 64 parsed headers, five-second header timeout, 20-second request timeout, 256-KiB JSON body, 2-MiB decoded response, five redirects, 15-second observation deadline, one retry, at least one-second per-host spacing, four concurrent source checks, a 4,096-entry outbound host-pacing ceiling, bounded public collections, and a constant-size authenticated-operator rate bucket. Unauthenticated traffic is rejected before rate or telemetry state is consumed.
- Path traversal and Unicode confusion: percent decode exactly once, NFC only, exact inventory membership substitution, 255 UTF-8-byte bound, and rejection of separators, controls, dot segments, residual encoded separators, invalid encoding, ambiguous normalization, case folding, NFKC substitution, and non-members. Distinct indexed names that resolve to one physical directory on a case-insensitive filesystem are treated as corruption.
- Symlink and replacement attacks: segment-by-segment `lstat`, root confinement, final `O_NOFOLLOW`, sibling temporary file with `O_EXCL`, atomic rename, file and directory synchronization, and a sole writer. Parent-component swap resistance is bounded by platform filesystem APIs and the single-owner deployment assumption; network filesystems are unsupported.
- Authentication and replay: a 32-random-byte base64url bearer token, SHA-256 plus constant-time comparison, no token response or persistence, 24-hour digest-only idempotency admission and result state, concurrent same-key waiting, conflict on changed effective requests, and deterministic admission-scoped create identities for safe retry after a result-record write failure. Reuse after the exact expiry creates a fresh admission and run identity.
- Cancellation resurrection and partial commits: reload-before-commit, one mutation coordinator, terminal cancellation, journaled roll-forward, and recovery serialized with cancel and finalize.
- Sensitive telemetry: a fixed allowlist excludes URLs, titles, page content, headers, tokens, credentials, job IDs, and complete workflow payloads. Stream errors are contained and output is dropped under backpressure, making sink failure fail-open relative to the domain result.

Residual risks: a privileged host administrator can inspect process memory or canonical files; availability semantics depend on the approved deterministic markers; filesystem behavior is not claimed for network mounts; a local unauthenticated caller can still consume the bounded connection and authentication budget; denial of service remains possible for an attacker already holding the operator token; and public internet deployment is outside the contract.

Compose portability: file-backed secrets do not portably remap ownership or mode. Startup remains fail-closed because the non-root process must be able to read a regular file whose group/other permission bits are zero. Operations require a one-off in-container metadata check before first use on each engine/host combination.
