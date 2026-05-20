# Plano — Suporte completo a Nginx Proxy Manager na aba NPM

> Objectivo: dentro da aba **NPM** do dashboard, replicar todas as funcionalidades do Nginx Proxy Manager (NPM) que o utilizador usa hoje na UI nativa do NPM, mantendo o nosso padrão de design actual (CSS variables `--surface`, `--surface2`, `--border`, `--accent`, `--text/2/3`, `--err-text`, classes `.btn`, `.btn-sm`, `.btn-primary`, `.card`, `.modal-overlay`, `.modal`, `.form-grid`, `.form-group`). **Não** copiar o look-and-feel do NPM — só a estrutura/campos dos formulários, e só campos que realmente estiverem implementados ponta-a-ponta.

## Estado actual (linha de base)

### Já implementado
| Camada | Recurso | Onde |
|---|---|---|
| Backend (NPM client) | Proxy Hosts CRUD + enable/disable | [src/npm/client.ts:146-172](src/npm/client.ts#L146) |
| Backend (NPM client) | Certificates: list/get/createLetsEncrypt/delete | [src/npm/client.ts:174-188](src/npm/client.ts#L174) |
| Backend (rotas) | `/admin/npm`, `/admin/npm/test`, `/admin/npm/status` | [src/index.ts:2038-2099](src/index.ts#L2038) |
| Backend (rotas) | `/admin/npm/proxy-hosts` (lista, get, create, update, delete, enable, disable, preview-adopt, bulk-adopt, link-profile) | [src/index.ts:2103-2482](src/index.ts#L2103) |
| Backend (rotas) | `/admin/npm/certificates` (lista, create LE, delete) | [src/index.ts:2295-2335](src/index.ts#L2295) |
| Frontend (UI) | Sidebar nav `npm` → `pageNpm` | [src/views/partials/_app.html:118](src/views/partials/_app.html#L118), [_app.html:1352-1443](src/views/partials/_app.html#L1352) |
| Frontend (UI) | Connection Settings modal | [_app.html:1446-1487](src/views/partials/_app.html#L1446) |
| Frontend (UI) | Proxy Host modal (tabs Details / Custom Locations / SSL) | [_app.html:1490-1613](src/views/partials/_app.html#L1490) |
| Frontend (JS) | `fetchNpmConfig`, `openNpmConfigModal`, `saveNpmConfig`, `testNpmConnectionUi`, `clearNpmConfig` | [dashboard-data.js:5198+](src/views/js/dashboard-data.js#L5198) |
| Frontend (JS) | `fetchNpmHostsTable`, `renderNpmHostsTable`, `toggleNpmHost`, `deleteNpmHost`, `openNpmHostModal`, `saveNpmHost`, locations CRUD | [dashboard-data.js:5664-5957](src/views/js/dashboard-data.js#L5664) |
| Backend (sync) | `profileToNpmHost`, `profileToCertPayload`, `syncProfile` | [src/npm/mapper.ts](src/npm/mapper.ts), [src/npm/sync.ts](src/npm/sync.ts) |

### Em falta (recursos do NPM que não temos)
1. **UI de Certificates** — tabela com nome/provider/domínios/expiração colorida, Add LE (via UI dedicada), Add Custom (upload), Renew LE, Delete. Backend só falta upload de Custom.
2. **Custom Certificate upload** — backend (`POST /api/nginx/certificates` provider=other + `POST /api/nginx/certificates/{id}/upload` multipart) + rota Midleman + UI.
3. **Redirection Hosts** — CRUD completo (backend + UI). NPM endpoint: `/api/nginx/redirection-hosts`.
4. **404 Hosts (dead-hosts)** — CRUD completo. NPM endpoint: `/api/nginx/dead-hosts`.
5. **Streams** (TCP/UDP) — CRUD completo. NPM endpoint: `/api/nginx/streams`.
6. **Access Lists** — CRUD completo + items (authorization basic-auth, client allow/deny). NPM endpoint: `/api/nginx/access-lists`. Lookup no Proxy Host modal (seleccionar Access List).

---

## Sub-abas dentro da página NPM

A página `pageNpm` actual mostra directamente a tabela de proxy hosts. Vamos transformar em **sub-abas horizontais** logo abaixo do header da página, no padrão actual do projecto (usando o mesmo estilo dos tabs do modal de Proxy Host em [_app.html:1497-1501](src/views/partials/_app.html#L1497)):

```
[ Proxy Hosts ] [ Redirection Hosts ] [ Streams ] [ 404 Hosts ] [ Access Lists ] [ Certificates ]
```

Cada sub-aba é um `<div class="npm-subpage" data-subpage="...">` que mostra/esconde via JS, mantendo o estado em `_npmCurrentSubpage` e persistindo em `localStorage` (chave `npm.subpage`).

Header da página passa a ter: pill de conexão + Refresh + Settings. O botão `+ Proxy Host` (e equivalentes) deixa de viver no header global e passa a viver em cada sub-aba (cada sub-aba tem o seu botão `+ Add ...`).

---

## Fatia 1 — UI de Certificates (sub-aba `Certificates`)

**Valor:** o utilizador pediu explicitamente ver lista de certificados com expirados/perto-de-expirar. Backend já está pronto para LE.

### Backend (zero alterações)
Reutiliza:
- `GET /admin/npm/certificates` → lista
- `POST /admin/npm/certificates` (LE) — já existe
- `DELETE /admin/npm/certificates/{id}` — já existe

**Adicionar** (mínimo):
- `POST /admin/npm/certificates/{id}/renew` → chama NPM `POST /api/nginx/certificates/{id}/renew`. Cliente: nova função `renewCertificate(id)` em [src/npm/client.ts](src/npm/client.ts).

### Frontend
- HTML novo em [_app.html](src/views/partials/_app.html), sub-aba `certificates`:
  - Header da sub-aba: search input + 2 botões → `+ Let's Encrypt` (abre modal já existente refactored, ver abaixo) e `+ Custom Certificate` (desabilitado nesta fatia, fica enabled na Fatia 2 — ou escondido por feature flag até Fatia 2).
  - Tabela: colunas `Name`, `Provider`, `Domains`, `Expires`, `Actions`.
  - Coluna `Expires`: cor dinâmica
    - vermelho (`var(--err-text)`) se `expires_on < now`
    - laranja (`#f59e0b`) se `expires_on - now < 30d`
    - verde (`#22c55e`) caso contrário
    - "—" se sem `expires_on` (provider=other sem upload)
  - Actions por linha: `Renew` (só LE), `Download` (Fatia 2), `Delete`.
- JS novo em [dashboard-data.js](src/views/js/dashboard-data.js):
  - `fetchNpmCertsTable()` — fetch `/admin/npm/certificates` (já existe rota, podemos usar a mesma).
  - `renderNpmCertsTable()` com search + sort por expiração ascendente por defeito.
  - `_certExpiryBadge(expires_on)` helper de cor + texto formatado (DD/MM/YYYY HH:mm em PT).
  - `openNpmCertLEModal()` — novo modal "Add Let's Encrypt Certificate" autónomo (não dentro de Proxy Host).
  - `saveNpmCertLE()` — POST `/admin/npm/certificates` com `{provider:'letsencrypt', nice_name, domain_names, meta:{letsencrypt_email, letsencrypt_agree, dns_challenge?}}`.
  - `renewNpmCert(id)` — POST `/admin/npm/certificates/{id}/renew` com confirmação.
  - `deleteNpmCert(id)` — DELETE, com confirmação e check de "está em uso por host X" (cruzar com `listProxyHosts`).
- Modal novo: **`npmCertLEModal`** — campos
  - Domain Names (csv) *
  - Nice Name (opcional, default `letsencrypt:{first-domain}`)
  - Email for Let's Encrypt *
  - Checkbox: "Use DNS Challenge" (mostra warning de que requer DNS provider configurado na instância NPM — sem expor configuração de DNS provider nesta fatia, porque exige integração específica por provider).
  - Checkbox: "I agree to Let's Encrypt ToS" *

### Tarefas Fatia 1
0. **Schema check** (pré-requisito): `curl -H "Authorization: Bearer ..." http://<npm>:81/api/nginx/certificates` na instância real e confirmar os campos retornados (`expires_on`, `provider`, `nice_name`, `domain_names`). Confirmar também que `POST /api/nginx/certificates/{id}/renew` existe nesta versão.
1. [src/npm/client.ts](src/npm/client.ts): adicionar `renewCertificate(id)`.
2. [src/index.ts](src/index.ts): nova rota `POST /admin/npm/certificates/:id/renew` (com audit log `npm.cert.renew`).
3. [_app.html](src/views/partials/_app.html): refactor de `pageNpm` para sub-abas; mover tabela actual para sub-aba `proxy-hosts`; criar sub-aba `certificates` com tabela e header próprio; criar `npmCertLEModal`.
4. [dashboard-data.js](src/views/js/dashboard-data.js): funções `switchNpmSubpage`, `fetchNpmCertsTable`, `renderNpmCertsTable`, `_certExpiryBadge`, `openNpmCertLEModal`/`closeNpmCertLEModal`/`saveNpmCertLE`, `renewNpmCert`, `deleteNpmCert`.
5. Persistência da sub-aba em `localStorage`.
6. Cache local `_npmCertsAll` reutilizada pelo Proxy Host modal (`reloadNhCerts` passa a usar a cache se fresca <30s).

### Critério de aceitação
- Carrega a sub-aba Certificates e vejo todos os certs com expiração colorida.
- Posso criar um LE novo via modal e ele aparece na lista.
- Posso renovar LE → status muda.
- Posso apagar → desaparece da lista. Tenta apagar um em uso → erro do NPM exibido.

---

## Fatia 2 — Custom Certificate upload

**Armadilha conhecida:** o NPM exige fluxo em 2 passos:
1. `POST /api/nginx/certificates` com `{provider:"other", nice_name:"..."}` → retorna `{id, ...}`.
2. `POST /api/nginx/certificates/{id}/upload` com **multipart/form-data** (campos `certificate`, `certificate_key`, opcional `intermediate_certificate`). **Não é JSON.**

O `authedRequest` actual em [src/npm/client.ts:79](src/npm/client.ts#L79) só envia JSON. Precisamos de uma variante.

### Backend
- [src/npm/client.ts](src/npm/client.ts):
  - Função `authedFormRequest<T>(method, path, formData)` — análoga a `authedRequest` mas sem `Content-Type: application/json`; passa FormData directamente. Mantém o retry 401 e backoff 5xx.
  - `createOtherCertificate(niceName: string)` → POST JSON `{provider:'other', nice_name}`.
  - `uploadCertificateFiles(id, {certificate, certificate_key, intermediate_certificate?})` → POST multipart usando `authedFormRequest`.
  - `validateCertificateFiles(form)` → POST `/api/nginx/certificates/validate` multipart (opcional, mas útil para validar antes do upload final — devolve info do cert).
  - `downloadCertificate(id): Promise<ArrayBuffer>` → GET `/api/nginx/certificates/{id}/download` (zip).
- [src/index.ts](src/index.ts):
  - `POST /admin/npm/certificates/custom` — aceita multipart no nosso lado (`req.formData()`), valida (tipos `.crt`/`.pem`/`.key`, tamanho máx 256 KB cada, sem passphrase — rejeitar key encriptada inspeccionando se contém `ENCRYPTED`), depois chama `createOtherCertificate(niceName)` + `uploadCertificateFiles(id, ...)`. Em caso de falha no upload, faz `deleteCertificate(id)` para não deixar lixo. Audit log `npm.cert.create.custom`.
  - `GET /admin/npm/certificates/:id/download` — proxy do zip do NPM, com header `Content-Disposition: attachment; filename="..."`.

### Frontend
- Modal novo: **`npmCertCustomModal`** (não tentar replicar o look do screenshot — só o que está implementado):
  - Name * (mapeia para `nice_name`)
  - Certificate Key (file input, `.key` ou `.pem`) *
  - Certificate (file input, `.crt` ou `.pem`) *
  - Intermediate Certificate (file input, opcional)
- Botão `+ Custom Certificate` no header da sub-aba Certificates abre este modal.
- Acção de linha `Download` (todos os certs com `expires_on` ou `provider=other`).

### Tarefas Fatia 2
0. **Schema check**: testar `POST /api/nginx/certificates {provider:"other", nice_name}` → `POST /api/nginx/certificates/{id}/upload` (multipart) manualmente via `curl` para confirmar campos exactos e códigos de resposta.
1. `authedFormRequest` em client.ts.
2. `createOtherCertificate`, `uploadCertificateFiles`, `validateCertificateFiles`, `downloadCertificate`.
3. Rotas `POST /admin/npm/certificates/custom` e `GET /admin/npm/certificates/:id/download`.
4. Modal HTML + JS (`openNpmCertCustomModal`, `saveNpmCertCustom` com `FormData`, `downloadNpmCert(id)`).
5. Validação client-side: tamanho ficheiro, extensão, key sem passphrase (best-effort — ler primeiros 200 bytes e procurar `ENCRYPTED`).

### Critério de aceitação
- Posso fazer upload de um cert custom; aparece na lista com provider "Custom".
- Posso fazer download do zip e abrir os ficheiros.
- Upload com key inválida (encriptada) → erro claro.
- Falha no upload limpa o cert criado a meio.

---

## Fatia 3 — Redirection Hosts

NPM endpoint: `/api/nginx/redirection-hosts` (GET/POST/PUT/DELETE + `/enable` + `/disable`).

### Modelo (campos efectivamente suportados pelo NPM)
```ts
interface NpmRedirectionHost {
  id: number;
  domain_names: string[];
  forward_scheme: 'http' | 'https' | 'auto';   // "auto" = $scheme
  forward_domain_name: string;                 // ex: example.com (sem scheme)
  forward_http_code: 300 | 301 | 302 | 307 | 308;
  preserve_path: boolean;
  certificate_id: number | 'new' | null;
  ssl_forced: boolean;
  http2_support: boolean;
  hsts_enabled: boolean;
  hsts_subdomains: boolean;
  block_exploits: boolean;
  advanced_config?: string;
  enabled: boolean;
  meta?: Record<string, unknown>;
}
```

### Backend
- [src/npm/types.ts](src/npm/types.ts): `NpmRedirectionHost` e `NpmRedirectionHostPayload`.
- [src/npm/client.ts](src/npm/client.ts): `listRedirectionHosts`, `getRedirectionHost`, `createRedirectionHost`, `updateRedirectionHost`, `deleteRedirectionHost`, `enableRedirectionHost`, `disableRedirectionHost`.
- [src/index.ts](src/index.ts): rotas espelhadas em `/admin/npm/redirection-hosts/...` com audit logs (`npm.redirection.create/update/delete/toggle`).

### Frontend
- Sub-aba `redirection-hosts`: tabela colunas `#`, `Source domains`, `Forward → http_code`, `SSL`, `Status`, `Actions`. Search + filtro (enabled/disabled/ssl).
- Modal `npmRedirectionModal` com tabs: **Details** | **SSL**.
  - Details: Domain Names *, Scheme (http/https/auto), Forward Domain *, HTTP Code (300/301/302/307/308), Preserve Path (checkbox), Block Common Exploits, Advanced Config (textarea).
  - SSL: mesmo padrão do Proxy Host (cert select / Force SSL / HTTP/2 / HSTS / HSTS subdomains).
- Reutilizar dropdown de certs com cache da Fatia 1.

### Tarefas Fatia 3
0. **Schema check**: `curl .../api/nginx/redirection-hosts` numa redirection-host existente (criar uma via UI nativa primeiro) e capturar shape real — alguns campos opcionais variam por versão NPM.
1. Tipos + client.
2. Rotas backend.
3. HTML sub-aba + modal.
4. JS (`fetchNpmRedirections`, `renderNpmRedirections`, `openNpmRedirectionModal`, `saveNpmRedirection`, `toggleNpmRedirection`, `deleteNpmRedirection`).

### Critério de aceitação
- CRUD completo funcional.
- Filtros funcionam.
- Pode usar cert da Fatia 1.

---

## Fatia 4 — 404 Hosts (dead-hosts)

NPM endpoint: `/api/nginx/dead-hosts` (GET/POST/PUT/DELETE + enable/disable).

### Modelo
```ts
interface NpmDeadHost {
  id: number;
  domain_names: string[];
  certificate_id: number | 'new' | null;
  ssl_forced: boolean;
  http2_support: boolean;
  hsts_enabled: boolean;
  hsts_subdomains: boolean;
  advanced_config?: string;
  enabled: boolean;
  meta?: Record<string, unknown>;
}
```

Não tem forward — é só "catch domain e devolve 404 com cert SSL próprio". Útil para "domínio parqueado".

### Backend
**Schema check** primeiro (criar 1 dead-host via UI nativa NPM, capturar shape). Depois espelha Fatia 3. Tipos + client + rotas `/admin/npm/dead-hosts`.

### Frontend
- Sub-aba `dead-hosts`. Tabela: `#`, `Domains`, `SSL`, `Status`, `Actions`.
- Modal `npmDeadHostModal` com tabs **Details** (só Domain Names + Advanced Config) e **SSL** (cert + Force SSL + HTTP/2 + HSTS + HSTS subdomains).

### Critério de aceitação
- CRUD completo, podem ter SSL próprio.

---

## Fatia 5 — Access Lists

Mais complexo: tem **dois sub-recursos** dentro de cada Access List — `items` (basic auth username/password) e `clients` (IP allow/deny).

### Modelo
```ts
interface NpmAccessListItem { id?: number; username: string; password?: string; }
interface NpmAccessListClient { id?: number; address: string; directive: 'allow' | 'deny'; }
interface NpmAccessList {
  id: number;
  name: string;
  satisfy_any: boolean;            // OR vs AND entre auth+IP
  pass_auth: boolean;              // passa o Authorization header upstream
  items: NpmAccessListItem[];
  clients: NpmAccessListClient[];
  proxy_host_count?: number;       // expand=proxy_hosts
}
```

NPM endpoints: `GET/POST/PUT/DELETE /api/nginx/access-lists`. Itens/clientes vão **dentro** do POST/PUT — array no body. Listar com `?expand=items,clients`.

### Backend
- Tipos + client (`listAccessLists(expand=true)`, `getAccessList`, `createAccessList`, `updateAccessList`, `deleteAccessList`).
- Rotas backend espelhadas.

### Frontend
- Sub-aba `access-lists`. Tabela: `#`, `Name`, `Authorization (count)`, `Clients (count)`, `Used by (proxy_host_count)`, `Actions`.
- Modal `npmAccessListModal` com tabs **Details** (name, satisfy_any switch labeled "Satisfy Any", pass_auth checkbox "Pass Auth to Host"), **Authorization** (lista editável de username/password rows, botão + Add User), **Access** (lista editável de address+allow/deny rows, botão + Add).
- Adicionar dropdown "Access List" no Proxy Host modal (já existe — só adicionar na tab Details ou criar tab nova "Access").

### Tarefas Fatia 5
0. **Schema check + verificação inline vs separado**: criar uma ACL via UI nativa NPM com 1 user + 1 client, fazer `GET .../api/nginx/access-lists?expand=items,clients` para confirmar shape. **Armadilha de versão**: em algumas versões `items`/`clients` não vão inline no POST/PUT — são geridos em endpoints separados (`/api/nginx/access-lists/{id}/items`). Testar inline primeiro; se 400/422, implementar via endpoints dedicados.
1. Tipos + client.
2. Rotas backend.
3. HTML sub-aba + modal multi-tab.
4. JS para rows dinâmicas (`addAclItem`, `removeAclItem`, `addAclClient`, `removeAclClient`, `readAclItems`, `readAclClients`).
5. Integração no Proxy Host modal (campo `access_list_id`).

### Critério de aceitação
- CRUD ACLs com items + clients.
- Posso ligar uma ACL a um Proxy Host e ela é aplicada.

---

## Fatia 6 — Streams (TCP/UDP)

NPM endpoint: `/api/nginx/streams`.

### Modelo
```ts
interface NpmStream {
  id: number;
  incoming_port: number;
  forwarding_host: string;
  forwarding_port: number;
  tcp_forwarding: boolean;
  udp_forwarding: boolean;
  certificate_id?: number | null;   // só usado para TLS termination em TCP
  meta?: Record<string, unknown>;
  enabled: boolean;
}
```

### Backend
**Schema check** primeiro — `certificate_id` em streams só existe em NPM ≥ 2.10. Se a versão for mais antiga, omitir TLS termination do form. Tipos + client + rotas.

### Frontend
- Sub-aba `streams`. Tabela: `#`, `Incoming port`, `Forward`, `TCP/UDP`, `Status`, `Actions`.
- Modal simples: Incoming Port *, Forwarding Host *, Forwarding Port *, checkboxes TCP / UDP (pelo menos um obrigatório). Sem tabs.

### Critério de aceitação
- CRUD streams. Conflito de porta no NPM é reportado ao utilizador.

---

## Considerações transversais

### Manter consistência de design
- Todos os novos modais usam `class="modal-overlay"` + `class="modal"` + `class="modal-header/-body/-footer"` como em [_app.html:1446-1487](src/views/partials/_app.html#L1446).
- Tabs internos do modal seguem o padrão de [_app.html:1497-1501](src/views/partials/_app.html#L1497) (border-bottom 2px + `var(--accent)`).
- Tabelas seguem o padrão da tabela de proxy hosts existente em [_app.html:1402-1417](src/views/partials/_app.html#L1402).
- Sub-abas da página (não confundir com tabs de modal) — usam classe nova `.npm-subpage-tab` com o mesmo estilo visual dos tabs do modal Proxy Host (border-bottom 2px + `var(--accent)`), mas **sem renomear/refactor** as `.npm-host-tab` existentes — convivem em paralelo (zero risco de regressão no modal que já funciona).
- Cores de status (verde/vermelho/laranja) reutilizar as inline já existentes para SSL/Enabled badges em [dashboard-data.js:5746-5754](src/views/js/dashboard-data.js#L5746).

### Permissões e audit
- Todas as novas rotas requerem admin (igual às actuais).
- Audit log em todas as mutações: `npm.redirection.create/update/delete/toggle`, `npm.deadhost.create/update/delete/toggle`, `npm.acl.create/update/delete`, `npm.stream.create/update/delete/toggle`, `npm.cert.renew`, `npm.cert.create.custom`, `npm.cert.download`.
- Adicionar todas as actions novas ao dropdown em [_app.html:1631-1668](src/views/partials/_app.html#L1631).

### Erros
- Todas as funções JS de fetch tratam erros com `_esc(d.error || ...)` e mostram em status pill inline do modal/tabela, como já é padrão.
- Erros do NPM passam por `NpmError` em [src/npm/client.ts:28](src/npm/client.ts#L28). Backend já transforma 400/4xx em jsonRes com mensagem.

### Schema check antes de cada fatia (pré-requisito obrigatório)
Cada fatia começa com tarefa #0 de schema check — `curl` à instância NPM real para confirmar shape exacto antes de escrever tipos. Campos opcionais variam entre versões NPM (especialmente Streams TLS ≥ 2.10 e Access Lists items/clients inline vs endpoints separados). **Implicação**: os campos exactos de cada modal só ficam congelados após a verificação contra a tua instância — este plano lista campos esperados, mas a implementação ajustará se a tua versão diferir. Constraint "só põe o que funciona" obriga a este ciclo verificar→ajustar→implementar por fatia.

### Não-objectivos (excluído explicitamente)
- DNS provider configuration (apenas o checkbox "Use DNS Challenge" — assume que o utilizador configurou o DNS provider directamente na UI nativa do NPM ou via env vars).
- Cert renew automático agendado (manual via botão).
- Bulk operations (delete/enable múltiplos) — fora deste plano.
- Importação/sincronização inversa (NPM→Midleman) para os novos recursos — o `syncProfile` actual fica como está; só Proxy Hosts são sincronizados com profiles Midleman.

---

## Ordem de execução recomendada

| # | Fatia | Esforço estimado | Dependências |
|---|---|---|---|
| 1 | Certificates UI (LE + listar) + sub-abas refactor | Médio | — |
| 2 | Custom Cert upload (multipart) | Médio | Fatia 1 |
| 3 | Redirection Hosts | Médio | Fatia 1 (usa certs) |
| 4 | 404 Hosts | Pequeno | Fatia 1 |
| 5 | Access Lists | Grande | — (mas Proxy Host modal sofre alteração para integrar) |
| 6 | Streams | Pequeno | Fatia 1 (TLS opcional) |

Cada fatia é um commit/PR independente, testável isoladamente. Critérios de aceitação no fim de cada secção acima.

---

## Ficheiros tocados (sumário)

| Ficheiro | Fatias |
|---|---|
| [src/npm/types.ts](src/npm/types.ts) | 2,3,4,5,6 |
| [src/npm/client.ts](src/npm/client.ts) | 1,2,3,4,5,6 |
| [src/index.ts](src/index.ts) | 1,2,3,4,5,6 |
| [src/views/partials/_app.html](src/views/partials/_app.html) | 1,2,3,4,5,6 |
| [src/views/js/dashboard-data.js](src/views/js/dashboard-data.js) | 1,2,3,4,5,6 |
| [src/views/css/dashboard.css](src/views/css/dashboard.css) | 1 (refactor pequeno) |
| [src/views/js/dashboard-app.js](src/views/js/dashboard-app.js) | 1 (navigate hook para sub-abas) |
