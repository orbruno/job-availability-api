# Private n8n connectivity

Version: 1.0

The API does not need a public endpoint. It must be reachable from the network namespace where n8n executes the Job Availability node.

## n8n running directly on the host

The default Compose deployment publishes `127.0.0.1:5002` on the host. Use this credential Base URL:

```text
http://127.0.0.1:5002
```

This route is host-local and is not exposed on the LAN.

## n8n and the API on one Docker network

Use a private user-defined network and address the API by its Compose service name:

```text
http://job-availability:5002
```

Create the shared network once:

```sh
docker network create n8n-private
```

Attach both Compose services to that external network. The relevant addition in each Compose file is:

```yaml
services:
  job-availability:
    networks:
      - n8n-private

networks:
  n8n-private:
    external: true
```

Use the equivalent `networks` entry under the n8n service. Docker DNS then resolves `job-availability` privately. Do not use `127.0.0.1` from the n8n container because it identifies the n8n container itself.

## n8n in a separate container without a shared network

Prefer creating a shared private network. Host-gateway routing varies across operating systems and container engines and can accidentally broaden the listening boundary. If a shared network cannot be used, review the engine-specific routing and firewall behavior before changing the loopback-only publish rule.

## n8n Cloud

n8n Cloud cannot reach this local-only deployment. Supporting n8n Cloud would require a separately designed internet-reachable HTTPS deployment with an appropriate authentication, tenancy, rate-limit, monitoring, abuse, and incident-response model. That is outside the current architecture.

## Credential handling

Use the same generated token in the service secret file and the n8n **Job Availability API** credential. The token must not appear in workflow JSON, environment examples, screenshots, logs, or issues. Use **Test credential** after every endpoint or token change.
