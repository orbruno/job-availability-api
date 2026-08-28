# Telemetry adapter

This adapter emits only the bounded operational allowlist defined by the service contract. Sink errors are contained and telemetry is dropped under stream backpressure, keeping failures isolated from domain outcomes.
