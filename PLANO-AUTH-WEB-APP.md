# Plano — Proteger UI + API com um único proxy (auth "web application")

## Contexto

Hoje o Midleman tem auth `login` (JWT em cookie por profile) que funciona bem para uma aplicação web atrás de **um único upstream**. Não cobre o caso real em que a mesma aplicação tem duas faces — uma UI (`app.exemplo.com`) e uma API (`api.exemplo.com`, ou domínio totalmente diferente) — e queremos:

1. **Não tocar nos upstreams** (mantêm-se como hoje, sem código novo lá dentro).
2. **Mesmo modelo de segurança dos proxies actuais** (JWT/sessão, IP allowlist, 2FA, rate limit já existentes).
3. **Idealmente um só profile** a cobrir UI + API, com uma identidade de utilizador partilhada.

Limitações actuais (confirmadas no código):
- Routing é name-based (`/proxy/{nome}/`) ou por porta dedicada — **não há matching por `Host`**.
- Cookie JWT é `SameSite=Strict` sem `Domain` → **não atravessa subdomínios** nem cross-origin.
- Não existe CSRF token explícito; defesa actual depende inteiramente do `SameSite=Strict`.
- Não há ponte sessão↔bearer para clientes programáticos da API.

Estas três coisas têm de mudar para o objectivo ser atingível.

## Decisões fechadas

- **Cenários de domínio**: suportar **ambos** — subdomínios partilhados (cookie cross-subdomain) e domínios totalmente diferentes (bearer token).
- **Routing**: estender `ProxyProfile` com `upstreams[]` por hostname, mantendo retrocompatibilidade com `targetUrl`.
- **Bridge cookie↔API (decisão recomendada, revisitável)**: endpoint `/auth/token` que troca sessão de browser por um bearer curto. Justificação: separa segredos por canal (o cookie HttpOnly da UI nunca é exposto a JS; o bearer pode ser revogado isoladamente; permite expiração diferente para UI e clientes M2M).

## Desenho

### 1. Tipo `ProxyProfile` — múltiplos upstreams por hostname
**Ficheiro**: [src/core/types.ts](src/core/types.ts)

Adicionar opcionalmente:
```ts
upstreams?: Array<{
  hostnames: string[];        // ["app.exemplo.com", "www.exemplo.com"]
  targetUrl: string;
  role: 'ui' | 'api';         // governa redirecionamentos vs respostas 401 JSON
}>;
cookieDomain?: string;        // ex: ".exemplo.com" — habilita SSO cross-subdomain
allowedOrigins?: string[];    // CORS para o caso API-em-domínio-diferente
```
`targetUrl` continua a funcionar (single-upstream). Se `upstreams[]` estiver presente, a selecção passa a ser por `Host` header.

### 2. Routing por Host
**Ficheiro**: [src/proxy/proxy.ts](src/proxy/proxy.ts) e [src/servers/proxy-server.ts](src/servers/proxy-server.ts)

Após o profile ser resolvido (por path/cookie como hoje), se `profile.upstreams` existir, escolher o upstream cujo `hostnames[]` inclua `request.headers.get('host')`. Fallback: 404 com mensagem explícita ("hostname não configurado neste profile"). Roles:
- `role: 'ui'` → comportamento actual (HTML 401, redirect para login).
- `role: 'api'` → 401 JSON, sem redirect, aceita Bearer em `Authorization`.

### 3. Cookie cross-subdomain
**Ficheiro**: [src/servers/proxy-server.ts](src/servers/proxy-server.ts) (handler `/auth/login`)

Se `profile.cookieDomain` definido, emitir o cookie JWT com:
- `Domain=<cookieDomain>` (ex: `.exemplo.com`)
- `SameSite=Lax` (necessário para top-level navigation entre subdomínios; `Strict` partia o fluxo)
- `Secure` obrigatório (TLS-only)

Mantém-se `HttpOnly`. Sem `cookieDomain`, comportamento fica idêntico ao actual (`SameSite=Strict`, sem `Domain`).

### 4. Bridge sessão → bearer (`/auth/token`)
**Ficheiro**: [src/servers/proxy-server.ts](src/servers/proxy-server.ts)

Novo endpoint `POST /auth/token` no servidor dedicado do profile:
- Requer cookie JWT válido (mesmo `verifyProxyJwt` actual).
- Devolve `{ token, expiresIn }` — token JWT separado, assinado pela mesma chave, com `aud: 'api'`, TTL curto (recomendado 15 min, configurável por profile).
- API valida o bearer pelo mesmo middleware do JWT, mas só aceita tokens com `aud: 'api'`.

Cobre dois usos:
- **Cross-subdomain partilhando cookie**: a UI nem precisa pedir bearer — o cookie é enviado directamente. `/auth/token` fica disponível mas opcional.
- **Cross-domain**: a UI chama `/auth/token` (via `fetch` com `credentials: 'include'`), guarda em memória, e envia `Authorization: Bearer …` para `api-y.com`. Aqui é necessário também `allowedOrigins[]` para CORS.

### 5. CSRF — passa a obrigatório quando `cookieDomain` está activo
**Ficheiro**: [src/proxy/proxy.ts](src/proxy/proxy.ts)

Ao relaxar `SameSite` para `Lax`, perdemos a defesa actual em pedidos `POST/PUT/DELETE` cross-subdomain. Solução mínima — **origin check**:
- Para métodos não-safe, comparar `Origin`/`Referer` contra a lista de hostnames do profile.
- Falha → 403.

Não introduzir double-submit token nesta fase (mais código, mais UI a tocar); origin check é suficiente para o modelo de ameaça actual e zero-touch para os upstreams.

### 6. CORS no modo cross-domain
**Ficheiro**: [src/proxy/proxy.ts](src/proxy/proxy.ts)

Quando o upstream tem `role: 'api'` e o pedido vem com `Origin` listado em `allowedOrigins`, devolver `Access-Control-Allow-Origin: <origem>` + `Allow-Credentials: true` + headers relevantes. Sem isto, a UI em `app-x.com` não consegue chamar `api-y.com` com bearer.

### 7. Dashboard do Midleman
Sem alteração funcional. Ganha visibilidade no painel de profiles para configurar `upstreams[]`, `cookieDomain`, `allowedOrigins`:
- [src/views/partials/_app.html](src/views/partials/_app.html) — modal de profile, campos novos
- [src/views/js/dashboard-data.js](src/views/js/dashboard-data.js) — payload da API admin

## Ficheiros críticos a modificar

| Ficheiro | O quê |
|---|---|
| [src/core/types.ts](src/core/types.ts) | Adicionar `upstreams[]`, `cookieDomain`, `allowedOrigins` ao `ProxyProfile` |
| [src/proxy/proxy.ts](src/proxy/proxy.ts) | Routing por Host, CSRF origin check, CORS para `role: 'api'` |
| [src/servers/proxy-server.ts](src/servers/proxy-server.ts) | Endpoint `/auth/token`, cookie com `Domain`/`SameSite=Lax` |
| [src/auth/auth.ts](src/auth/auth.ts) | `verifyProxyJwt` aceitar `aud` no token, função `issueApiToken()` |
| [src/views/partials/_app.html](src/views/partials/_app.html) | UI dos campos novos no modal de profile |
| [src/views/js/dashboard-data.js](src/views/js/dashboard-data.js) | Serializar campos novos |

## Reaproveitamento

- `verifyProxyJwt` e a key store RS256 actuais — já assinam/verificam JWT, basta acrescentar `aud`.
- Rate limiter de login ([src/auth/auth.ts](src/auth/auth.ts)) — aplica-se também a `/auth/token` sem mudança.
- `checkIpAllowed` ([src/core/ip-filter.ts](src/core/ip-filter.ts)) — continua a correr antes de tudo, cobre UI e API.
- Request logging ([src/telemetry/request-log.ts](src/telemetry/request-log.ts)) — captura o novo endpoint automaticamente.
- TOTP 2FA — herdado, sem alteração; o token derivado herda a propriedade de já ter feito 2FA.

## Verificação end-to-end

Três cenários a validar manualmente após implementação:

1. **Single-host (regressão)**: profile com `targetUrl` apenas, sem `upstreams[]`. Login na UI → cookie funciona como hoje. Comportamento idêntico ao actual.
2. **Subdomínios partilhados**: profile com `cookieDomain=".exemplo.com"`, `upstreams[]` mapeando `app.exemplo.com` (role UI) e `api.exemplo.com` (role api). Login em `app.exemplo.com` → `fetch('https://api.exemplo.com/...', { credentials: 'include' })` deve passar com mesmo cookie. POST sem `Origin` válido → 403.
3. **Cross-domain**: profile com `upstreams[]` em `app-x.com` (UI) e `api-y.com` (api), `allowedOrigins: ['https://app-x.com']`. Login → `POST /auth/token` → guardar token → chamar `api-y.com` com `Authorization: Bearer`. Sem token → 401 JSON. Bearer expirado → 401.

Cada cenário deve aparecer correctamente no dashboard de request logs com IP, identidade e duração.

## Fora de escopo (deixar para depois)

- Double-submit CSRF token (origin check é suficiente nesta fase).
- Refresh token para o bearer da API (cliente pede `/auth/token` de novo enquanto o cookie da UI for válido).
- mTLS no canal Midleman ↔ upstream.
- Routing por path dentro do mesmo upstream (`/api/*` vs `/*`) — pode ser feito com dois upstreams partilhando hostname e role diferente, mas adia-se até pedido concreto.
