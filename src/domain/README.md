# Availability Domain

Pure deterministic availability rules live here. Modules may depend on other domain or contract modules, but never on n8n, HTTP servers, network clients, filesystems, environment state, telemetry, or the system clock.

Time, fetched observations, parsed content, and server-issued identities enter as explicit values. Domain functions return new values and never mutate their inputs.
