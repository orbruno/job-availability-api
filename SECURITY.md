# Security Policy

## Supported versions

Version 0.1.x is a public-source release candidate for private self-hosting. No hosted API or generally available production release is currently supported.

## Reporting

Use the repository's **Security** tab and select **Report a vulnerability** to send a private report. Do not open a public issue for an unpatched vulnerability. Do not include service tokens, posting URLs, page content, workflow payloads, filesystem contents, or personal data. Include a minimal synthetic reproduction, affected version or commit, deployment topology, and observed impact.

## Security boundary

The service is designed for one authenticated operator on a controlled local network. Its default Compose configuration publishes only to host loopback. Public-internet exposure, multi-tenancy, browser automation, and multiple writers are outside the supported threat model.

The operator is responsible for host security, secret storage, TLS when traffic crosses a trusted host boundary, state backups, safe inventory production, and ensuring that exactly one service writes availability state. Review [docs/threat-model.md](docs/threat-model.md) before deployment.

Never commit a token or place it in an exported n8n workflow. Rotate or revoke a suspected token immediately and verify that the former value returns 401.
