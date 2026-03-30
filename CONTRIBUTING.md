# Contributing to Midleman

Thank you for your interest in contributing! This document explains how to get the project running locally and what to keep in mind when submitting changes.

## Getting Started

### Requirements

- [Bun](https://bun.sh/) >= 1.0
- Git

### Local setup

```bash
git clone https://github.com/Biscatos/Midleman.git
cd Midleman
bun install
cp .env.example .env
bun run dev
```

The dashboard will be available at `http://localhost:3000/dashboard`. On first run, complete the TOTP setup wizard.

### Type checking

```bash
bunx tsc --noEmit
```

Always run this before submitting a PR — the CI will reject type errors.

---

## How to Contribute

### Reporting bugs

Open an issue using the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs. actual behavior
- Bun version (`bun --version`) and OS
- Relevant logs or screenshots

### Suggesting features

Open an issue using the **Feature Request** template. Describe the use case clearly — why does it matter and who benefits?

### Submitting a pull request

1. **Fork** the repository and create a branch from `master`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes.
3. Run `bunx tsc --noEmit` and fix any type errors.
4. Open a pull request against `master`. Fill in the PR template.

---

## Code Guidelines

- **TypeScript strict mode** is enforced. No `any` unless genuinely unavoidable.
- **No speculative abstractions** — only implement what the feature actually requires.
- **No error handling for impossible scenarios** — trust internal contracts and Bun's guarantees.
- Keep new features behind the existing patterns: config in `src/core/types.ts`, persistence in `src/core/store.ts`, server logic in `src/servers/`.
- Dashboard UI lives entirely in `src/views/` — plain HTML/CSS/JS (no framework).

### Naming conventions

- Webhook distributor names: `[a-z0-9_-]`, 2–48 characters, no spaces.
- Environment variables: `TARGET_<NAME>_<FIELD>`, `PROXY_<NAME>_<FIELD>`.

---

## Project Structure (quick reference)

```
src/
├── index.ts            # HTTP server, routing, admin API
├── core/               # Types, config loader, persistence
├── servers/            # One file per server type (target, proxy, webhook)
├── proxy/              # Request forwarding
├── auth/               # TOTP, sessions
├── telemetry/          # OpenTelemetry + SQLite logging
└── views/              # Dashboard (HTML/CSS/JS)
```

---

## Questions?

Open a [Discussion](https://github.com/Biscatos/Midleman/discussions) for anything that doesn't fit a bug report or feature request.
