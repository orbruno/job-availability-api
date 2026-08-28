# Contract Schemas

- `public-api-v1.schema.json` defines bounded request, response, projection, and problem documents.
- `persisted-availability-v1.schema.json` defines rollback-compatible version 1 job and run documents.

Both use JSON Schema 2020-12 and reject unknown fields. Persisted schemas preserve complete arrays; bounded public data-transfer objects are separate definitions.
