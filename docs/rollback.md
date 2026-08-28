# Rollback

Version: 1.0

Rollback returns writer authority to a previously verified compatible release. It must never create a dual-writer interval.

1. Pause every n8n caller of Job Availability API.
2. Stop the current service gracefully and verify its writer lock is absent.
3. Create and verify a complete state backup.
4. Inspect and roll forward any prepared check journal before changing versions.
5. Restore the prior release and state into an isolated root first.
6. Run its contract, credential, state-read, and synthetic-operation checks.
7. Start the prior release against the active root only after the current writer is proven stopped.
8. Resume n8n calls and monitor run counts, errors, and closure decisions.

If compatibility validation fails, keep all writers stopped, preserve the state and journals, and restore the last verified backup into an isolated root for diagnosis. Never delete evidence or rewrite persisted documents merely to force an older release to start.

A rollback across a breaking contract or persisted-schema change requires the version-specific migration procedure published with that release.
