# Midleman

Midleman is a high-performance, programmable HTTP proxy and API gateway built on [Bun](https://bun.sh/). Designed for infrastructure routing, request inspection, and edge proxying, it provides a centralized control plane for managing proxy targets, handling authentication bypasses, and analyzing API traffic.

## Features

- **Multi-Target Routing**: Create and manage isolated proxy profiles and named targets with independent or auto-assigned port allocations.
- **Web Dashboard**: An embedded administrative interface for managing edge configurations and viewing request flows in real-time.
- **Traffic Inspection**: Persistent request logging powered by SQLite, offering detailed payload, throughput, and latency inspection.
- **Telemetry & Metrics**: Built-in OpenTelemetry support and real-time dashboard analytics.
- **Secure Access**: Native TOTP (Time-based One-Time Password) 2FA authentication for the administrative panel.
- **Dynamic Configuration**: Modify port assignments, target URLs, and authentication methods at runtime without dropping active connections.
- **Low Latency**: Sub-5ms processing overhead using Bun's native HTTP server. Fully binary-safe for large payload forwarding.

## Installation

Midleman requires [Bun](https://bun.sh/) version 1.0 or higher.

```bash
git clone <repository-url>
cd midleman
bun install
```

## Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

The default administrative port is `3000`. Persistent data (configuration, SQLite logs, authentication state) is stored in the `data/` directory.

## Usage

Start the application:
```bash
# Development environment
bun run dev

# Production
bun start
```

Access the administrative dashboard at `http://localhost:3000/dashboard` to complete the initial setup and administrator TOTP configuration.

## Docker Deployment

Midleman supports containerized execution with persistent data volumes.

```bash
docker-compose up -d
```
*Note: Ensure the `/app/data` volume is properly mapped on the host machine to persist your configurations, request logs, and authentication keys across container restarts.*

## Endpoint Management

Midleman allows the definition of three primary endpoint types:

1. **Proxy Profiles**: Designed for credential abstraction. Profiles automatically inject authorization headers (e.g., Bearer tokens, API keys) into outgoing requests, allowing internal API access to be securely shared via public or key-protected links.
2. **Named Targets**: Configurable network endpoints running on dedicated ports. Used primarily for standard reverse-proxying, application routing, and environment obfuscation.
3. **Webhook Distributors**: Native fan-out engine for receiving external webhooks and asynchronously dispatching the payload to multiple internal destinations simultaneously ("Fire-and-Forget").

### Webhook Authentication
Webhooks can be secured by specifying an **Auth Token** in the Midleman Dashboard. When an Auth Token is defined, Midleman will only accept payload dispatches that include the token via one of the following methods:
- **Header**: `X-Forward-Token: seu_token_aqui`
- **Query Parameter**: `?token=seu_token_aqui`

#### Meta (Facebook/WhatsApp/Instagram) Integration
Midleman features native support for **Meta Webhooks**. Meta requires endpoints to automatically respond to a `hub.challenge` verification request.
To integrate Midleman with Meta:
1. In the Meta App Dashboard, set the **Callback URL** to your Midleman server (e.g., `https://midleman.exemplo.com/webhook?token=seu_token`).
2. Set the **Verify Token** in Meta to exactly match the **Auth Token** configured in Midleman.
3. Midleman handles the `GET` handshake automatically and validates the payloads securely, fanning them out to all your internal services.

All configurations can be managed visually via the dashboard or programmatically via the underlying REST API located at `/admin`.

## Security Considerations

- Dashboard and administrative API endpoints are fully protected behind session-based or token-based authentication.
- Credentials injected by proxy profiles are strictly managed server-side and are never exposed to the client.
- Strict rate limiting is enforced on all authentication attempts.
- Configuration schemas validate strict URL structures and port constraints.

## License

MIT
