# Midleman

> High-performance HTTP proxy & API gateway built on [Bun](https://bun.sh/)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org/)

Midleman is a self-hosted middleware layer that sits between your services and the outside world. It handles credential injection, multi-target routing, webhook fan-out with retries, and real-time traffic inspection — all managed through a built-in web dashboard.

---

## Features

- **Proxy Profiles** — Inject API credentials server-side so they are never exposed to clients. Share protected upstream APIs via public or key-gated links. Configurable `forwardPath` to control whether the incoming path is appended to the upstream URL.
- **Webhook Fan-out** — Receive a single inbound webhook and dispatch it asynchronously to N destinations. Custom actions support optional body templates (pass-through by default), custom headers, method override, and header forwarding.
- **Retry Engine** — Configurable per-distributor and per-destination retry with exponential or fixed backoff. Includes a *retry until 2xx* mode (with `maxRetries` as a hard cap).
- **Dead Letter Queue** — Failed deliveries are persisted to disk (`dlq.json`) and survive restarts. Full replay from the dashboard.
- **Web Dashboard** — Built-in admin UI for full CRUD, request log inspection, charts, and fanout detail.
- **Traffic Logging** — SQLite-backed request/response capture with configurable retention and body size limits.
- **TOTP 2FA** — First-run setup wizard generates a QR code for any authenticator app. All admin routes are session-protected.
- **Meta Webhook Support** — Native `hub.challenge` verification for Facebook / WhatsApp / Instagram integrations.
- **OpenTelemetry** — Optional traces and metrics export via OTLP. Compatible with Jaeger, Grafana, Prometheus.
- **Low overhead** — Sub-5ms processing using Bun's native HTTP server.

---

## Quick Start

### Requirements

- [Bun](https://bun.sh/) >= 1.0

### Run locally

```bash
git clone https://github.com/Biscatos/Midleman.git
cd Midleman
bun install
cp .env.example .env
bun run dev
```

Open `http://localhost:3000/dashboard` to complete the initial TOTP setup.

### Docker

```bash
docker-compose up -d
```

The admin dashboard is available at `http://localhost:3000/dashboard`.
Proxy targets and webhook ports are auto-assigned starting at `4000`.

> Make sure the `./data` volume is mapped so configuration, logs, and auth state survive container restarts.

---

## Configuration

All options are set via environment variables. Copy `.env.example` to get started.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Admin dashboard port (fixed) |
| `DATA_DIR` | `./data` | Persistent storage directory |
| `PORT_RANGE_START` | `4000` | Starting port for auto-assigned targets |

### Proxy Profiles (Credential Injection)

```env
PROXY_INFOBIP_URL=https://api.infobip.com
PROXY_INFOBIP_KEY=your_api_key
PROXY_INFOBIP_HEADER=Authorization
PROXY_INFOBIP_PREFIX=App
PROXY_INFOBIP_ACCESS=public_link_key  # optional: protect the public link
PROXY_INFOBIP_BLOCKED=.exe,.bat       # optional: block file extensions
```

### Request Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUEST_LOG_ENABLED` | `true` | Enable SQLite request logging |
| `REQUEST_LOG_RETENTION_DAYS` | `7` | Auto-purge after N days |
| `REQUEST_LOG_MAX_BODY_SIZE` | `65536` | Max bytes captured per request body |

### OpenTelemetry (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_ENABLED` | `false` | Enable telemetry |
| `OTEL_ENDPOINT` | — | OTLP HTTP endpoint (e.g. `http://otel-collector:4318`) |
| `OTEL_SERVICE_NAME` | `midleman` | Service name in spans/metrics |
| `OTEL_METRICS_INTERVAL` | `15000` | Metrics export interval (ms) |

---

## Webhook Fan-out

Webhooks are configured from the dashboard. Each distributor listens on its own port and dispatches to multiple destinations in parallel.

### Retry configuration

```json
{
  "name": "payments",
  "port": 4010,
  "retry": {
    "maxRetries": 5,
    "retryDelayMs": 1000,
    "backoff": "exponential",
    "retryUntilSuccess": true
  },
  "targets": [
    "https://service-a.internal/hook",
    {
      "url": "https://service-b.internal/notify",
      "method": "POST",
      "bodyTemplate": "{\"id\": \"{{order.id}}\", \"amount\": {{order.total}}}",
      "retry": {
        "maxRetries": 10,
        "retryDelayMs": 500,
        "retryUntilSuccess": true
      }
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `maxRetries` | Max attempts after the first failure — acts as a hard cap even with `retryUntilSuccess` |
| `retryDelayMs` | Base delay between retries (ms) |
| `backoff` | `exponential` (default) or `fixed` |
| `retryOn` | HTTP status codes that trigger retry (default: `[429, 502, 503, 504]`) |
| `retryUntilSuccess` | Retry on **any** non-2xx response (ignores `retryOn`, respects `maxRetries`) |

Failed deliveries that exhaust all retries are captured in the **Dead Letter Queue**, persisted to `data/dlq.json`, and can be replayed individually or in bulk from the dashboard. The DLQ survives process restarts and unexpected crashes.

### Meta (Facebook / WhatsApp / Instagram) Integration

1. Set the **Callback URL** in Meta's App Dashboard to your Midleman endpoint, e.g. `https://midleman.example.com/webhook?token=your_token`
2. Set the **Verify Token** in Meta to match the **Auth Token** configured in Midleman
3. Midleman handles the `hub.challenge` handshake automatically

---

## Admin API

All resources are available via REST under `/admin`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/webhooks` | List webhook distributors |
| `POST` | `/admin/webhooks` | Create / update a distributor |
| `DELETE` | `/admin/webhooks/:name` | Delete a distributor |
| `POST` | `/admin/webhooks/:name/restart` | Restart a distributor |
| `GET` | `/admin/webhooks/dlq` | List failed deliveries |
| `POST` | `/admin/webhooks/dlq/retry-all` | Retry all failed deliveries |
| `POST` | `/admin/webhooks/dlq/:id/retry` | Retry one delivery |
| `DELETE` | `/admin/webhooks/dlq/:id` | Dismiss a failed delivery |
| `GET` | `/admin/profiles` | List proxy profiles |
| `POST` | `/admin/profiles` | Create / update a profile |
| `GET` | `/admin/requests` | Query request logs |
| `GET` | `/health` | Health check |

All admin routes require a valid session cookie (obtained via dashboard login).

---

## Project Structure

```
src/
├── index.ts                # Entry point — HTTP server & routing
├── core/
│   ├── config.ts           # Environment config loader
│   ├── store.ts            # JSON persistence layer
│   └── types.ts            # TypeScript interfaces
├── servers/
│   ├── webhook-server.ts   # Webhook fan-out + DLQ + retry engine
│   ├── proxy-server.ts     # Proxy profile servers
│   └── port-manager.ts     # Dynamic port allocation
├── proxy/
│   └── proxy.ts            # Request forwarding logic
├── auth/
│   └── auth.ts             # TOTP, sessions, rate limiting
├── telemetry/
│   ├── telemetry.ts        # OpenTelemetry setup
│   └── request-log.ts      # SQLite logging
└── views/                  # Dashboard HTML/CSS/JS
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## License

[MIT](LICENSE)
