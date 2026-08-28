# Backup and restore

Version: 1.0

Backups require a quiescent single-writer boundary. Pause n8n availability calls, stop the service gracefully, verify the writer lock is absent, and copy the complete isolated data root with metadata preserved. Include `jobs/index.json`, every job directory, availability state, runs, evidence, idempotency admissions and results, and any prepared transaction journals. Never copy only one file from an in-progress check.

Record the backup timestamp, source-root identity, file count, aggregate SHA-256 identity, service version, and operator. Do not include the cleartext service token in the state backup; back up secrets through the approved secret system.

Restore only into a new isolated root first. Keep n8n disconnected, verify file ownership and mode, start exactly one service writer, allow startup to roll prepared journals forward, run the credential test, read every retained run, and execute a synthetic check against synthetic metadata. Compare aggregate state and run counts with the backup record. Destroy the rehearsal copy only after recording the drill result.

Restore over active data only during an approved maintenance window, after preserving a verified backup and proving that the former writer is stopped. Never allow the rehearsal and active instances to share a data root.
