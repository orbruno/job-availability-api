# Data layout

Version: 1.0

Posting observation is stateless and works without a job inventory. Durable Availability Run and Job operations use a local inventory maintained by another trusted component.

## Required durable inventory

The configured data root must contain an index:

```text
jobs/index.json
```

Minimal synthetic content:

```json
{
  "jobs": [{ "slug": "synthetic-job" }]
}
```

Each indexed job must have metadata at `jobs/<slug>/metadata.json`:

```json
{
  "title": "Synthetic Data Engineer",
  "company": "Synthetic Company",
  "platform": "synthetic",
  "url": "https://example.com/jobs/synthetic",
  "sources": [
    {
      "platform": "synthetic",
      "url": "https://example.com/jobs/synthetic"
    }
  ]
}
```

The primary `platform` and `url` are used when `sources` is absent. A job may declare at most 20 sources. Identifiers are exact, case-sensitive inventory values and are limited to 255 UTF-8 bytes; path separators, control characters, unsafe encodings, normalization collisions, and symlinked storage are rejected.

## Ownership boundary

The trusted inventory producer owns `jobs/index.json` and job `metadata.json` files. Job Availability API owns:

- `jobs/<slug>/availability.json`
- `availability/runs/`
- `availability/idempotency/`
- `availability/idempotency-admissions/`
- `availability/transactions/`
- the availability writer and recovery lock records

The inventory producer must use atomic replacement and must not edit API-owned availability state. Job Availability API must be the only availability writer for a data root.

## Docker volume integration

The default Compose file stores data in the `job-availability-data` named volume. Durable integration requires the trusted inventory producer to write the compatible inventory into that same volume while respecting the ownership boundary above. Do not manipulate the volume manually while the service is processing a run.

If no inventory integration is available, use Posting **Observe** only. Scheduled and explicit durable runs will fail safely when their required inventory is absent or invalid.

## Backups

Back up the complete data root only while the availability writer is stopped and its lock is absent. See [backup and restore](backup-and-restore.md).
