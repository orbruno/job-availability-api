# Operations

Version: 1.0

Prerequisites for direct execution: Node.js 24.19.0, npm 11.6.2, an absolute isolated data root, and an available local port 5002. Docker Compose users can follow the root [quick start](../README.md#quick-start-with-docker-compose).

## Install and verify

```sh
npm ci --ignore-scripts
npm run check
```

Generate one token and immediately protect the file:

```sh
umask 077
npm run token:generate > /absolute/private/path/job-availability-token
chmod 600 /absolute/private/path/job-availability-token
```

Set only non-secret environment variables plus the secret-file path:

```sh
export JOB_AVAILABILITY_DATA_ROOT=/absolute/isolated/data
export JOB_AVAILABILITY_TOKEN_FILE=/absolute/private/path/job-availability-token
export JOB_AVAILABILITY_HOST_SPACING_MS=1000
npm run build
npm start
```

The default bind is `127.0.0.1:5002`. The service creates its availability directories, but durable operations require the inventory described in [data layout](data-layout.md). Verify readiness without displaying the token:

```sh
node scripts/healthcheck.mjs
```

## Docker Compose

Set `JOB_AVAILABILITY_COMPOSE_TOKEN_FILE` in `.env` to the absolute protected host-file path. File-backed Compose secrets use a bind mount, so Docker Compose does not portably remap their uid, gid, or mode. Before first startup on each engine and host combination, verify the mounted file remains a regular mode-0600 file owned by service uid 1000:

```sh
docker compose run --rm --no-deps --entrypoint stat job-availability -c '%a %u %g %F' /run/secrets/job-availability-token
```

The expected result is `600 1000 1000 regular file`. Stop if it differs and provision an engine-supported secret readable only by uid 1000; do not weaken the service's validation. Then start and verify:

```sh
docker compose up --build -d
docker compose ps
docker compose exec job-availability node scripts/healthcheck.mjs
```

Compose publishes only `127.0.0.1:5002` and stores state in its own named volume. See [private n8n connectivity](n8n-connectivity.md) before connecting a containerized n8n instance.

## Rotate the token

Use a maintenance window:

1. Pause n8n calls and stop the service gracefully.
2. Generate a replacement into a new mode-0600 file.
3. Update the service secret-file target and n8n credential.
4. Restart the service and run the credential test.
5. Prove the former token receives 401.
6. Remove the former token from the approved secret mechanism.

Restart is required because the service accepts one operator token and loads it at startup.

## Revoke the token

Stop the service and remove its secret from the approved local secret mechanism. A service without exactly one valid secret source refuses startup. If continued operation is required, provision a replacement through the rotation procedure. Verify that the revoked token receives 401 and is absent from workflow exports and tracked files.

## Diagnose

- 401: repair the n8n credential or complete token rotation; never log the value.
- 409 idempotency conflict: issue a new key for a materially different request.
- 409 run pending: process or truthfully fail every pending job before finalization.
- Startup refusal or bounded 503: verify data-root/schema access, token-file mode and symlink status, and sole-writer ownership.
- Crash-stale lock: inspect `availability/.job-availability-service.lock` and verify no writer is running. On the same host only, pass its exact `owner` to `npm run lock:recover -- <owner>`. A host mismatch requires incident review; never delete the lock while writer state is uncertain.
- Interrupted lock recovery: `availability/.job-availability-lock-recovery` blocks startup and further recovery. Preserve both lock records, prove no writer or recovery process remains, and handle removal only as a recorded incident action.
- Idempotency storage: the active process removes expired admission and result files at startup and during bounded maintenance. A pruning failure rejects the admitting request safely.
- Inconclusive observation: inspect only the privacy-safe evidence code and HTTP status. Raw page content must not enter telemetry.

## Upgrade

Read [CHANGELOG.md](../CHANGELOG.md), pause n8n calls, stop the service, create a complete backup, and validate the new version against an isolated restored copy before changing the active deployment. Do not skip contract-version or persisted-schema changes.

## Uninstall

Pause n8n calls, stop the service, preserve a verified backup, remove the container or local package, and remove the token from n8n and the local secret mechanism. Retain state until rollback and retention decisions are complete. Removing the named volume or data root is a separate destructive action.
