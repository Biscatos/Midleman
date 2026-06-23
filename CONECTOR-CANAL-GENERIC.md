# Conector GoContact — Canal `generic` (JSON)

Guia de integração do canal **generic** do conector GoContact do Midleman.

Pensa nele como uma ponte bidirecional em JSON simples: **o teu sistema** fala com o
Midleman, e o Midleman trata da ligação à GoContact (criar sessão webchat, injetar a
mensagem do cliente, e devolver as respostas do agente).

```
teu sistema  ──POST──▶  Midleman  ──▶  GoContact          (ENTRADA: mensagem do cliente)
teu sistema  ◀─POST──   Midleman  ◀──  GoContact (agente)  (SAÍDA: resposta do agente)
```

Ao contrário de `meta-whatsapp` e `smooch`, o canal `generic` **não tem `directReply`** —
a "última milha" até ao cliente é da tua responsabilidade. Por isso, para receberes as
respostas do agente, **tens de configurar pelo menos um Webhook Target** no conector.

---

## 1) ENTRADA — o teu sistema → Midleman (mensagem do cliente)

### Endpoint
```
POST http://<host>:<porta-do-conector>/
```
Qualquer path serve (ex. `/`, `/inbound`). A porta é a que o conector mostra no dashboard.

### Autenticação (opcional, recomendada)
Se definires um **verify token** no conector, tens de o enviar em cada pedido, de uma destas formas:
- Query string: `POST .../?token=O_TEU_SEGREDO`
- Header: `X-Forward-Token: O_TEU_SEGREDO`

Sem verify token configurado, o endpoint aceita sem auth. Podes ainda restringir por
**lista de IPs** (campo *Allowed IPs* do conector).

### Corpo — uma mensagem
```json
{
  "chatId": "cliente-244939609354",
  "name": "João Cliente",
  "text": "Olá, preciso de ajuda"
}
```

| Campo | Obrigatório | Aliases aceites | Descrição |
|-------|-------------|-----------------|-----------|
| `chatId` | **Sim** | `idChat`, `from` | Id estável da conversa/cliente. É a chave da sessão. |
| `name` | Não | `displayName` | Nome mostrado ao agente. Default = o `chatId`. |
| `text` | Não* | `message`, `mensagem` | Texto da mensagem. |
| `file` | Não* | — | Anexo (ver abaixo). |

\* Cada mensagem precisa de ter `text` **ou** `file` — sem nenhum dos dois, é ignorada.

### Corpo — com anexo
```json
{
  "chatId": "cliente-244939609354",
  "name": "João Cliente",
  "file": {
    "url": "https://o-teu-cdn.com/ficheiros/foto.jpg",
    "filename": "foto.jpg",
    "mimetype": "image/jpeg",
    "size": 145270
  }
}
```
- `file.url` é **obrigatório** — o Midleman descarrega o ficheiro a partir desse URL e
  injeta-o na GoContact. O URL tem de ser acessível pelo Midleman.
- `filename`, `mimetype`, `size` são opcionais (recomendados).

> **Nota sobre o modo da GoContact:** em modo `poll` (plugin tradicional) qualquer tipo de
> ficheiro é enviado para o storage da instância GoContact. Em modo `webchat-api` a API só
> aceita **jpg/png/pdf** no upload; outros tipos (áudio/vídeo) não são suportados pela API.

### Corpo — várias mensagens de uma vez (batch)
```json
{
  "messages": [
    { "chatId": "cliente-1", "name": "Ana", "text": "Olá" },
    { "chatId": "cliente-2", "name": "Bruno", "text": "Bom dia" }
  ]
}
```

### Resposta
```json
{ "status": "accepted", "messages": 1, "requestId": "2d141482-a4a3-416a-..." }
```
A entrega à GoContact é **assíncrona** — o `accepted` confirma só que o payload foi aceite
e parseado (não que já chegou ao agente).

### Exemplo `curl`
```bash
curl -X POST "http://midleman:4002/?token=O_TEU_SEGREDO" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"cliente-123","name":"João","text":"Olá, preciso de ajuda"}'
```

---

## 2) SAÍDA — Midleman → o teu sistema (resposta do agente)

Quando o agente responde na GoContact, o Midleman faz `POST` do evento para **cada Webhook
Target** configurado no conector.

### Headers
- `Content-Type: application/json`
- `X-Connector: <nome-do-conector>`
- (+ quaisquer *custom headers* que definas no Webhook Target)

### Corpo — `agent_message` (resposta de texto)
```json
{
  "connector": "o-meu-conector",
  "channel": "generic",
  "event": "agent_message",
  "chatId": "cliente-244939609354",
  "displayName": "João Cliente",
  "message": {
    "uuid": "id-unico-da-mensagem",
    "text": "Olá! Em que posso ajudar?",
    "timestamp": 1781700000000,
    "agentName": "Maria Agente",
    "userType": "AGENT",
    "file": null
  }
}
```

### Corpo — `agent_message` com ficheiro
```json
{
  "connector": "o-meu-conector",
  "channel": "generic",
  "event": "agent_message",
  "chatId": "cliente-244939609354",
  "displayName": "João Cliente",
  "message": {
    "uuid": "id-unico-da-mensagem",
    "text": null,
    "timestamp": 1781700000000,
    "agentName": "Maria Agente",
    "userType": "AGENT",
    "file": {
      "url": "https://gotaag.ucall.co.ao/storage/webchat-attachments/.../ficheiro.jpg",
      "filename": "ficheiro.jpg",
      "mimetype": "image/jpeg",
      "size": 145270
    }
  }
}
```

### Tipos de evento (`event`)
| `event` | Quando | `message` |
|---------|--------|-----------|
| `agent_message` | O agente enviou texto e/ou ficheiro | Preenchido (texto e/ou `file`) |
| `agent_joined` | O agente entrou na conversa | Informativo |
| `chat_closed` | A conversa foi fechada | `null`; vem `"reason": "agent" \| "admin" \| "expired"` |

Exemplo de `chat_closed`:
```json
{
  "connector": "o-meu-conector",
  "channel": "generic",
  "event": "chat_closed",
  "reason": "agent",
  "chatId": "cliente-244939609354",
  "displayName": "João Cliente",
  "message": null
}
```

### Semântica de entrega (importante)
- **Responde `2xx`** para confirmar a receção.
- `agent_message` é **at-least-once**: se o teu endpoint falhar (não-2xx ou timeout), o
  Midleman **repete** mais tarde. **Deduplica sempre pelo `message.uuid`** do teu lado.
- `chat_closed` tenta 3 vezes; se falhar, fica na **DLQ** (replay manual pelo dashboard).

### Exemplo de recetor mínimo (Bun/Node)
```js
Bun.serve({
  port: 9000,
  async fetch(req) {
    const ev = await req.json();
    if (ev.event === "agent_message" && ev.message) {
      // TODO: deduplicar por ev.message.uuid antes de entregar
      console.log(`[${ev.chatId}] ${ev.message.agentName}: ${ev.message.text ?? "(ficheiro)"}`);
      // ... entregar ao cliente final (o teu canal) ...
    } else if (ev.event === "chat_closed") {
      console.log(`[${ev.chatId}] conversa fechada (${ev.reason})`);
    }
    return new Response("ok"); // 2xx = ack
  },
});
```

---

## 3) Resumo

| | Entrada (cliente → Midleman) | Saída (agente → ti) |
|---|---|---|
| Direção | `POST` para a porta do conector | `POST` para os teus Webhook Targets |
| Formato | `{chatId, name?, text?, file?}` ou `{messages:[…]}` | `AgentEvent` (`event` + `message`) |
| Auth | verify token (`?token=` / `X-Forward-Token`) + IP allowlist | os teus custom headers; `X-Connector` identifica o conector |
| Ack | resposta `{status:"accepted"}` | responde `2xx`; deduplica por `message.uuid` |

**Configuração mínima do conector `generic`:** credenciais GoContact + **pelo menos um
Webhook Target** (sem ele não há por onde devolver as respostas do agente).
