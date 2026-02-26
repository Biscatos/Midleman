# 🚀 Bun-Forwarder

High-performance HTTP request forwarder built with [Bun](https://bun.sh) runtime and TypeScript. Designed for sub-5ms overhead with complete data integrity and binary-safe payload forwarding.

## ✨ Features

- **🔐 Secure**: Token-based authentication via `X-Forward-Token` header or `?token=xxx` query parameter
- **⚡ Fast**: Sub-5ms processing overhead using Bun's native HTTP server
- **🔄 Complete Forwarding**: Preserves all HTTP methods, headers, and payloads
- **📦 Binary-Safe**: Handles files, images, and binary data without corruption
- **🐳 Docker Ready**: Containerized deployment with health checks
- **📊 Stateless**: Horizontally scalable design

## 🏗️ Architecture

```
Client Request
    ↓
[Token Validation]
    ↓
[Payload Reading (Binary-Safe)]
    ↓
[Headers Preservation]
    ↓
[Forward to TARGET_URL]
    ↓
[Mirror Response]
    ↓
Client Response
```

## 📋 Requirements

- [Bun](https://bun.sh) v1.0 or higher
- (Optional) Docker for containerized deployment

## 🚀 Quick Start

### 1. Installation

```bash
# Clone the repository
git clone <repository-url>
cd bun-forwarder

# Install dependencies (Bun handles TypeScript natively)
bun install
```

### 2. Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
TARGET_URL=https://api.example.com
AUTH_TOKEN=your_secret_token_here  # Optional - leave empty to disable auth
```

### 3. Run Locally

```bash
# Development mode (with hot reload)
bun run dev

# Production mode
bun start
```

## 🐳 Docker Deployment

### Build and Run

```bash
# Build the image
docker build -t bun-forwarder .

# Run the container
docker run -d \
  -p 3000:3000 \
  -e TARGET_URL=https://api.example.com \
  -e AUTH_TOKEN=your_secret_token \
  --name bun-forwarder \
  bun-forwarder
```

### Using Docker Compose

```bash
# Production mode
docker-compose up -d

# Development mode (with hot reload)
docker-compose --profile dev up
```

## 📖 Usage Examples

### Basic Request

```bash
curl -X POST http://localhost:3000/api/users \
  -H "X-Forward-Token: your_secret_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

### File Upload (Binary)

```bash
curl -X POST http://localhost:3000/api/upload \
  -H "X-Forward-Token: your_secret_token" \
  -F "file=@image.png"
```

### With Query Parameters

```bash
curl -X GET "http://localhost:3000/api/users?page=1&limit=10" \
  -H "X-Forward-Token: your_secret_token"
```

### Authentication via Query Parameter

**For systems that don't support custom headers** (webhooks, notifications, etc.):

```bash
# Basic usage
curl "http://localhost:3000/api/webhook?token=your_secret_token"

# Combined with other parameters
curl "http://localhost:3000/api/users?page=1&token=your_secret_token"
```

> **Note**: The `token` query parameter is automatically removed before forwarding to the target URL.

### Unauthorized Request (No Token)

```bash
curl http://localhost:3000/api/users
# Response: 401 Unauthorized
```

## ⚙️ Environment Variables

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Port where the server will listen |
| `TARGET_URL` | Yes | - | Base URL where requests will be forwarded |
| `AUTH_TOKEN` | No | - | Token for authentication (via header or query param). If not set, auth is disabled |
| `FORWARD_PATH` | No | `true` | Set to `false` for fixed webhook URLs |

### Proxy Bypass Profiles

| Variable | Required | Description |
|----------|----------|-------------|
| `PROXY_{NAME}_URL` | Yes | Base URL of the upstream service |
| `PROXY_{NAME}_KEY` | Yes | API key for the upstream service |
| `PROXY_{NAME}_HEADER` | Yes | Header name for the API key (e.g., `Authorization`) |
| `PROXY_{NAME}_PREFIX` | No | Auth prefix (e.g., `Bearer`, `App`) |
| `PROXY_{NAME}_ACCESS` | No | Access key to protect the public link |


## 🔒 Security

- **Authentication**: Optional token-based auth via:
  - `X-Forward-Token` header (recommended)
  - `?token=xxx` query parameter (for systems without header support)
  - Leave `AUTH_TOKEN` empty to disable authentication (development only)
- **HTTPS Support**: Fully compatible with HTTPS target URLs
- **Token Removal**: Authentication tokens are removed before forwarding to prevent leakage
- **Stateless**: No session data or credentials stored

### Use Cases for Query Parameter Authentication

- **Webhook integrations**: Discord, Slack, and other services without custom header support
- **Third-party APIs**: Legacy systems or APIs that can't send custom headers
- **Direct links**: OAuth callbacks or shareable authenticated URLs
- **Notification systems**: Email or SMS-based webhooks

## 📊 Performance

- **Overhead**: < 5ms average processing time
- **Concurrency**: Handles 1000+ concurrent requests
- **Binary-Safe**: Uses `ArrayBuffer` for payload to prevent data corruption
- **Memory Efficient**: Streams data without full buffering

## 🧪 Testing

### Manual Testing

```bash
# 1. Start the server
bun run dev

# 2. Test authentication
curl -i http://localhost:3000/test
# Expected: 401 Unauthorized

# 3. Test valid request
curl -i http://localhost:3000/test \
  -H "X-Forward-Token: your_secret_token"
# Expected: Response from TARGET_URL/test

# 4. Test binary upload
curl -X POST http://localhost:3000/upload \
  -H "X-Forward-Token: your_secret_token" \
  -F "file=@test.jpg"
```

### Load Testing

```bash
# Using Apache Bench
ab -n 1000 -c 100 \
  -H "X-Forward-Token: your_secret_token" \
  http://localhost:3000/api/test
```

## 🔓 Proxy Bypass

Share authenticated resources with colleagues via public links. The Midleman handles upstream API authentication so your colleagues don't need to.

### Setup

Add proxy profiles to your `.env`:

```env
# Infobip example
PROXY_INFOBIP_URL=https://api.infobip.com
PROXY_INFOBIP_KEY=your_infobip_api_key
PROXY_INFOBIP_HEADER=Authorization
PROXY_INFOBIP_PREFIX=App
PROXY_INFOBIP_ACCESS=optional_shared_secret
```

### Usage

```bash
# Public link — share this with colleagues:
curl http://localhost:3000/proxy/infobip/path/to/file.jpg

# With access key protection:
curl "http://localhost:3000/proxy/infobip/path/to/file.jpg?key=optional_shared_secret"
```

### How It Works

```
Colleague (no API key)
    ↓
GET /proxy/infobip/path/to/file.jpg
    ↓
[Access Key Check (optional)]
    ↓
[Add API Key to request headers]
    ↓
GET https://api.infobip.com/path/to/file.jpg
    + Authorization: App your_infobip_api_key
    ↓
[Return response to colleague]
```


## 🛡️ Admin API

The Bun-Forwarder includes an Admin API for runtime management. All admin endpoints require authentication.

### Discovery

Access the base admin endpoint to see available commands:

```bash
curl http://localhost:3000/admin \
  -H "X-Forward-Token: your_secret_token"
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin` | GET | API discovery and system status |
| `/admin/profiles` | GET | List all active proxy profiles |
| `/admin/profiles` | POST | Create or update a profile (persisted to `profiles.json`) |
| `/admin/profiles/:name` | DELETE | Remove a profile (persisted to `profiles.json`) |
| `/admin/reload` | POST | Force reload of `.env` and `profiles.json` |

### Example: Creating a Profile

```bash
curl -X POST http://localhost:3000/admin/profiles \
  -H "X-Forward-Token: your_secret_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "new-api",
    "targetUrl": "https://api.example.com",
    "apiKey": "top-secret",
    "authHeader": "X-API-Key"
  }'
```


## 🛠️ Development

### Project Structure

```
bun-forwarder/
├── src/
│   ├── index.ts      # Main application entry
│   ├── config.ts     # Environment configuration
│   ├── proxy.ts      # Proxy bypass handler
│   └── types.ts      # TypeScript definitions
├── Dockerfile        # Docker image definition
├── docker-compose.yml # Docker orchestration
├── package.json      # Project metadata
├── tsconfig.json     # TypeScript configuration
└── .env.example      # Environment template
```


### Type Checking

```bash
bun run typecheck
```

### Build

```bash
bun run build
```

## 📝 API Specification

### Request Flow

1. **Authentication**: Validates `X-Forward-Token` header
2. **URL Construction**: `TARGET_URL` + `pathname` + `search`
3. **Header Forwarding**: All headers except `Host` (auto-handled)
4. **Payload Forwarding**: Binary-safe using `ArrayBuffer`
5. **Response Mirroring**: Exact status, headers, and body

### Supported HTTP Methods

- GET
- POST
- PUT
- DELETE
- PATCH
- OPTIONS
- HEAD

## 🐛 Troubleshooting

### Server won't start

- Verify `TARGET_URL` and `AUTH_TOKEN` are set in `.env`
- Check if port 3000 is already in use
- Ensure Bun is installed: `bun --version`

### 401 Unauthorized

- Verify `X-Forward-Token` header matches `AUTH_TOKEN`
- Check for typos in the token value

### Binary files corrupted

- Ensure using `ArrayBuffer` (already implemented)
- Verify Content-Type headers are preserved

## 📄 License

MIT

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

---

Built with ⚡ [Bun](https://bun.sh)
