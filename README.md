# Midleman

> High-performance HTTP proxy, API gateway & SIP/RTP media proxy — built on [Bun](https://bun.sh/)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org/)

Midleman is a self-hosted middleware layer that sits between your services and the outside world. It handles HTTP credential injection, multi-target webhook routing, SIP/VoIP protocol proxying with full RTP media relay, and real-time traffic inspection — all managed through a built-in web dashboard.

---

## Features

### HTTP Proxies
- **Proxy Profiles** — Inject API credentials server-side so they are never exposed to clients. Share protected upstream APIs via public or key-gated links.
- **Webhook Fan-out** — Receive a single inbound webhook and dispatch it asynchronously to N destinations with body templates, custom headers, and method overrides.
- **Retry Engine** — Configurable per-distributor and per-destination retry with exponential or fixed backoff. Includes a *retry until 2xx* mode.
- **Dead Letter Queue** — Failed deliveries are persisted to disk (`dlq.json`) and survive restarts. Full replay from the dashboard.

### SIP / VoIP Proxies (TCP/UDP)
- **Multi-listener** — A single profile can accept UDP, TCP, and TLS simultaneously on auto-assigned ports. Each transport gets its own port.
- **TLS termination** — Terminate SIPS/TLS inbound connections (e.g. Meta WhatsApp Business Calling) and forward to FusionPBX/FreeSWITCH over plain UDP/TCP — no PBX reconfiguration needed.
- **TLS upstream** — Optionally forward to an upstream that also uses TLS (cloud PBX). Self-signed cert support configurable per profile.
- **SIP Via / Record-Route rewriting** — RFC 3261 compliant stateful proxy. Rewrites Via and Record-Route headers so responses and in-dialog requests always route back through Midleman.
- **Transaction table** — Maps outgoing branch IDs to inbound sockets (TCP/TLS or UDP) for correct response routing.
- **RTP Media Relay** — Rewrites SDP (c= and m= lines) in INVITE/200 OK so all audio flows through Midleman. Enables FusionPBX on a private network to receive calls from the internet.
- **Worker threads for RTP** — Distributes RTP relay across multiple CPU cores via Bun Worker threads. Each worker handles its own port range independently. Scales to 1000+ simultaneous calls.
- **Auto TLS certificate** — Let's Encrypt via ACME HTTP-01 challenge. Certificates are issued and renewed automatically. Hot-reload after renewal with no call drops.

### Platform
- **Web Dashboard** — Full CRUD for HTTP proxies, TCP/UDP proxies, webhooks, users, and invites. Real-time request logs, charts, and DLQ management.
- **Traffic Logging** — SQLite-backed request/response capture with configurable retention.
- **TOTP 2FA** — First-run setup wizard with QR code. All admin routes are session-protected.
- **IP Allowlists** — Per-profile CIDR/wildcard allowlists for both HTTP and SIP listeners.
- **OpenTelemetry** — Optional traces and metrics via OTLP. Compatible with Jaeger, Grafana, Prometheus.

---

## Quick Start

### Requirements
- [Bun](https://bun.sh/) >= 1.1

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

> Map `./data` as a volume — all configuration, logs, certificates, and auth state persist there.

---

## Configuration

All options are set via environment variables.

### Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Admin dashboard port |
| `DATA_DIR` | `./data` | Persistent storage directory |
| `PORT_RANGE_START` | `4000` | Starting port for auto-assigned profiles |
| `PROXY_HOST` | — | Public IP/hostname used as fallback in SIP Via headers |

### HTTP Proxy Profiles

```env
PROXY_INFOBIP_URL=https://api.infobip.com
PROXY_INFOBIP_KEY=your_api_key
PROXY_INFOBIP_HEADER=Authorization
PROXY_INFOBIP_PREFIX=App
PROXY_INFOBIP_ACCESS=public_link_key   # optional: protect the public link
PROXY_INFOBIP_BLOCKED=.exe,.bat        # optional: block file extensions
```

### Request Logging

| Variable | Default | Description |
|---|---|---|
| `REQUEST_LOG_ENABLED` | `true` | Enable SQLite request logging |
| `REQUEST_LOG_RETENTION_DAYS` | `7` | Auto-purge after N days |
| `REQUEST_LOG_MAX_BODY_SIZE` | `65536` | Max bytes captured per request body |

### OpenTelemetry (optional)

| Variable | Default | Description |
|---|---|---|
| `OTEL_ENABLED` | `false` | Enable telemetry |
| `OTEL_ENDPOINT` | — | OTLP HTTP endpoint |
| `OTEL_SERVICE_NAME` | `midleman` | Service name in spans/metrics |
| `OTEL_METRICS_INTERVAL` | `15000` | Metrics export interval (ms) |

---

## TCP/UDP SIP Proxy

Midleman can terminate TLS from cloud carriers (e.g. Meta WhatsApp Business Calling API) and forward SIP signalling to a private FusionPBX/FreeSWITCH with full RTP media relay.

### Architecture

```
Internet                  Midleman (public IP)          LAN
─────────────────────────────────────────────────────────────
Meta WhatsApp
  SIP/TLS  ──────────────► :PORT_TLS ──────────────► FusionPBX :5060
  RTP/SRTP ──────────────► :PORT_RTP_B               FusionPBX :20000
                            (relay)   ──────────────►
SIP phones
  SIP/UDP  ──────────────► :PORT_UDP
  SIP/TCP  ──────────────► :PORT_TCP
```

All ports are auto-assigned from the port range. FusionPBX never needs a public IP.

### Env var configuration

```env
# Profile name: meta
TCPUDP_META_UPSTREAM_HOST=192.168.1.100     # FusionPBX private IP
TCPUDP_META_UPSTREAM_PORT=5060
TCPUDP_META_UPSTREAM_TRANSPORT=udp          # udp | tcp | tls

# Inbound listeners (each gets an auto-assigned port)
TCPUDP_META_LISTENERS=udp,tls              # accepts: udp, tcp, tls

# TLS inbound certificate (manual)
TCPUDP_META_TLS_CERT=/etc/ssl/certs/sip.pem
TCPUDP_META_TLS_KEY=/etc/ssl/private/sip.key

# Or: automatic certificate via Let's Encrypt
TCPUDP_META_ACME_DOMAIN=sip.empresa.com
TCPUDP_META_ACME_EMAIL=admin@empresa.com

# SIP routing — public address for Via/Record-Route headers
TCPUDP_META_SIP_PUBLIC_HOST=sip.empresa.com

# RTP media relay
TCPUDP_META_RTP_RELAY=true
TCPUDP_META_RTP_PORT_START=40000
TCPUDP_META_RTP_PORT_END=44001             # 4001 ports = ~1000 calls
TCPUDP_META_RTP_WORKERS=4                  # worker threads (auto = CPU cores - 1)

# Upstream TLS options (when UPSTREAM_TRANSPORT=tls)
TCPUDP_META_ALLOW_SELF_SIGNED_UPSTREAM=false

# Access control
TCPUDP_META_ALLOWED_IPS=203.0.113.0/24,198.51.100.*
```

### Dashboard configuration

All TCP/UDP proxy settings are also configurable from the dashboard (**Proxies → + TCP/UDP Proxy**):

| Section | Fields |
|---|---|
| Identity | Profile name (auto-assigns all ports) |
| Upstream | Host, Port, Transport (UDP / TCP / TLS) |
| Inbound Listeners | Checkboxes: ☑ UDP  ☑ TCP  ☑ TLS |
| TLS Certificate | Manual paths or Let's Encrypt ACME |
| SIP Routing | Public Host (for Via/Record-Route headers) |
| RTP Media Relay | Enable, Port range, Worker threads |
| Access Control | IP allowlist |

### Domains — understanding the three addresses

When using TLS with Let's Encrypt and SIP Via headers, three addresses are involved:

| Address | Purpose | Example |
|---|---|---|
| `acmeDomain` | Domain for the TLS certificate. Must resolve publicly to this server's IP. Port 80 must be accessible for ACME HTTP-01. | `sip.empresa.com` |
| `sipPublicHost` | Hostname placed in SIP Via and Record-Route headers. FusionPBX sends responses here. Should match `acmeDomain` when using ACME. | `sip.empresa.com` |
| `upstreamHost` | FusionPBX private IP/hostname. Never needs to be public. | `192.168.1.100` |

### SIP call flow

```
1. INVITE (Meta → Midleman TLS:PORT_TLS)
   SDP: c=meta_ip  m=audio meta_rtp_port
                    ↓ SDP rewritten by Midleman
2. INVITE (Midleman → FusionPBX UDP:5060)
   SDP: c=midleman_ip  m=audio PORT_A
   Via: SIP/2.0/UDP midleman_ip:PORT_A;branch=z9hG4bKxxx
   Record-Route: <sip:midleman_ip:PORT_TLS;lr;transport=tls>

3. 200 OK (FusionPBX → Midleman)
   SDP: c=fusionpbx_ip  m=audio fusionpbx_rtp_port
                    ↓ SDP rewritten by Midleman
4. 200 OK (Midleman → Meta)
   SDP: c=midleman_ip  m=audio PORT_B

5. RTP audio flows:
   Meta ──SRTP──► Midleman:PORT_B ──RTP──► FusionPBX:fusionpbx_rtp_port
   Meta ◄──RTP── Midleman:PORT_A ◄──RTP── FusionPBX

6. BYE → relay sockets closed, ports returned to pool
```

### RTP relay capacity and scaling

Each call uses 4 UDP ports (RTP + RTCP × 2 directions). Worker threads enable parallel packet processing across CPU cores:

| Workers | Port range | Max concurrent calls | Network requirement |
|---|---|---|---|
| 0 (single thread) | 50000–51000 | ~250 | ~32 Mbps (G.711) |
| 1 | 40000–41000 | ~250 | ~32 Mbps |
| 4 | 40000–44001 | ~1000 | ~128 Mbps |
| 8 | 40000–48001 | ~2000 | ~256 Mbps |

Workers are auto-detected from CPU cores when `rtpWorkers` is not set (uses `hardwareConcurrency - 1`).

**OS tuning for high call volumes:**
```bash
# File descriptors (2 sockets per call)
ulimit -n 65536

# UDP kernel buffers
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.core.netdev_max_backlog=5000
```

---

## Webhook Fan-out

Webhooks are configured from the dashboard. Each distributor listens on its own port.

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
      "retry": { "maxRetries": 10, "retryUntilSuccess": true }
    }
  ]
}
```

| Field | Description |
|---|---|
| `maxRetries` | Max attempts after the first failure |
| `retryDelayMs` | Base delay between retries (ms) |
| `backoff` | `exponential` (default) or `fixed` |
| `retryOn` | HTTP status codes that trigger retry (default: `[429, 502, 503, 504]`) |
| `retryUntilSuccess` | Retry on any non-2xx response (respects `maxRetries`) |

Failed deliveries are captured in the **Dead Letter Queue** (`data/dlq.json`) and can be replayed from the dashboard.

### Meta (Facebook / WhatsApp / Instagram) webhook verification

1. Set the **Callback URL** in Meta's App Dashboard to `https://midleman.example.com/webhook?token=your_token`
2. Set the **Verify Token** in Meta to match the **Auth Token** in Midleman
3. Midleman handles the `hub.challenge` handshake automatically

---

## Admin API

All resources available via REST under `/admin` (requires session cookie):

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/profiles` | List HTTP proxy profiles |
| `POST` | `/admin/profiles` | Create / update a profile |
| `DELETE` | `/admin/profiles/:name` | Delete a profile |
| `POST` | `/admin/profiles/:name/restart` | Restart a profile server |
| `GET` | `/admin/tcpudp` | List TCP/UDP proxy profiles |
| `POST` | `/admin/tcpudp` | Create / update a TCP/UDP profile |
| `DELETE` | `/admin/tcpudp/:name` | Delete a TCP/UDP profile |
| `POST` | `/admin/tcpudp/:name/restart` | Restart a TCP/UDP profile |
| `GET` | `/admin/webhooks` | List webhook distributors |
| `POST` | `/admin/webhooks` | Create / update a distributor |
| `DELETE` | `/admin/webhooks/:name` | Delete a distributor |
| `GET` | `/admin/webhooks/dlq` | List failed deliveries |
| `POST` | `/admin/webhooks/dlq/retry-all` | Retry all failed deliveries |
| `POST` | `/admin/webhooks/dlq/:id/retry` | Retry one delivery |
| `DELETE` | `/admin/webhooks/dlq/:id` | Dismiss a failed delivery |
| `GET` | `/admin/requests` | Query request logs |
| `GET` | `/health` | Health check + status of all servers |

---

## Project Structure

```
src/
├── index.ts                  # Entry point — HTTP server, routing, admin API
├── core/
│   ├── config.ts             # Environment config loader (HTTP + TCP/UDP profiles)
│   ├── store.ts              # JSON persistence (profiles, webhooks, DLQ)
│   ├── types.ts              # TypeScript interfaces
│   └── ip-filter.ts          # CIDR/wildcard IP allowlist
├── servers/
│   ├── proxy-server.ts       # HTTP proxy profile servers
│   ├── sip-server.ts         # TCP/UDP/SIP proxy (multi-listener + RTP relay)
│   ├── webhook-server.ts     # Webhook fan-out + DLQ + retry engine
│   └── port-manager.ts       # Dynamic port allocation for all server types
├── proxy/
│   └── proxy.ts              # HTTP request forwarding logic
├── sip/
│   ├── message.ts            # SIP message types, Via parsing/serialization
│   ├── parser.ts             # SipTcpParser (Content-Length framing) + UDP parser
│   ├── headers.ts            # Via/Record-Route rewriting, SIP forward/response logic
│   ├── transaction.ts        # Transaction table (branch → return socket/address)
│   ├── sdp.ts                # SDP parser and rewriter (c=, m=audio)
│   ├── rtp-relay.ts          # RTP media relay manager (single-thread + worker mode)
│   ├── rtp-worker.ts         # Bun Worker thread for parallel RTP packet relay
│   └── acme.ts               # Let's Encrypt ACME HTTP-01 certificate lifecycle
├── auth/
│   └── auth.ts               # TOTP, sessions, JWT, proxy users, rate limiting
├── telemetry/
│   ├── telemetry.ts          # OpenTelemetry setup
│   └── request-log.ts        # SQLite request/response logging
└── views/                    # Dashboard HTML/CSS/JS
    ├── dashboard.html
    ├── partials/
    │   ├── _app.html          # Main app shell + all modals
    │   ├── _login.html        # Login panel
    │   └── _setup.html        # First-run setup wizard
    ├── js/
    │   ├── dashboard-app.js   # Auth, navigation, theme
    │   └── dashboard-data.js  # API calls, rendering, CRUD logic
    └── css/
        └── dashboard.css
```

---

## Contributing

Contributions are welcome. Please open an issue before submitting a large pull request.

---

## License

[MIT](LICENSE)
