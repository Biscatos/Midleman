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

O pedido é **síncrono**: o Midleman só responde depois de a conversa estar criada na
GoContact e a mensagem entregue. Se o cliente ainda não tinha sessão, ela é aberta durante
este pedido — não precisas de fazer polling à espera dela.

```json
{
  "status": "accepted",
  "messages": 1,
  "requestId": "2d141482-a4a3-416a-...",
  "conversationId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "session": {
    "sessionId": "244900333444",
    "conversationId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "contactId": "contact-777",
    "customerId": "244900333444",
    "displayName": "Maria",
    "connector": "mat-whatsapp",
    "channel": "generic",
    "mode": "webchat-api",
    "phoneNumberId": null,
    "isNew": true,
    "agentJoined": false,
    "agentJoinedAt": null,
    "autoReplied": false,
    "createdAt": 1787134589088,
    "lastActivityAt": 1787134589099,
    "expiresAt": 1787141789099
  }
}
```

#### Os três identificadores

São diferentes de propósito — não os troques:

| Campo | O que é | Para que serve |
|---|---|---|
| `sessionId` | Chave interna do Midleman: `chatId`, ou `{phone_number_id}:{chatId}` quando o canal traz número de negócio | Correlacionar do teu lado; é a chave usada no dashboard e no `DELETE /admin/connectors/{nome}/sessions/{id}` |
| `conversationId` | O handle da conversa na GoContact (`dialogGroupUuid` em modo poll, `conversationUuid` em webchat-api) | Referir a conversa em suporte com a GoContact |
| `contactId` | O contacto criado na GoContact | Cruzar com relatórios/CRM |

#### Campos de estado

- **`isNew`** — `true` quando esta mensagem abriu a sessão, `false` quando reutilizou uma já viva.
- **`expiresAt`** — quando a sessão expira por inatividade (`lastActivityAt` + `sessionTtlMinutes`,
  por omissão 120 min). Cada mensagem empurra a data para a frente.
- **`agentJoined` / `agentJoinedAt`** — se algum agente humano já entrou nesta conversa.
  ⚠️ **Não é um sinal em tempo real.** Em modo `poll` só fica a `true` depois de o poller ler
  o episódio `JOIN`, o que pode demorar até um intervalo de polling. Para decidires *agora* se
  o bot deve calar-se, usa o evento `agent_joined` que recebes no webhook (secção 2). Este
  campo serve para recuperares o estado quando reinicias e não guardaste o evento.

#### Quando não há sessão

Nem toda a mensagem abre sessão. Nesses casos vem `session: null` com um `reason` legível
por máquina — antes disto a resposta era indistinguível de um sucesso:

| `reason` | Significado |
|---|---|
| `out_of_hours` | Fora do horário configurado, em modo "só responde" (`forwardToGoContact:false`). Foi enviada a mensagem de fora-de-horas; **não existe sessão GoContact**. |
| `delivery_failed` | A GoContact recusou ou falhou. Vem com `status:"partial"` e `errors[]`. |
| `no_messages` | O payload não produziu mensagens (ver `hint`). |
| `filtered` | O `phone_number_id` não pertence a este conector (`status:"ignored"`). |

Com várias mensagens no mesmo pedido vem **`sessions: []`** em vez de `session`, **alinhado
por índice** com as mensagens extraídas (`null` nas posições sem sessão), mais
`sessionReasons: []` com o motivo de cada `null`. O campo `conversationIds` continua a
existir por retrocompatibilidade, mas **salta** as falhadas — por isso não dá para saber a
que mensagem cada id pertence. Usa `sessions`.

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

### Tipos de Webhook Target

Um target pode ser uma de duas coisas:

**`kind: "url"`** — o Midleman faz `POST` diretamente ao teu endpoint. Podes configurar
autenticação sem escrever headers à mão: **Bearer**, **Basic** ou um **header à escolha**
(ex. `X-Api-Key`). O segredo é guardado redigido nos logs e nunca é devolvido pela API de
administração — ao editares o conector aparece mascarado e, se não lhe tocares, é preservado.

```json
{ "kind": "url", "url": "https://o-meu-bot/eventos",
  "auth": { "type": "bearer", "token": "..." } }
```

**`kind: "webhook"`** — o evento é entregue a um **Webhook Distributor deste Midleman**, que
passa a ser o dono da entrega. Herda tudo o que esse subsistema já faz: política de retry,
*persistent retry* com alerta por email, filtros por condição, `bodyTemplate`, DLQ com replay
e log por tentativa.

```json
{ "kind": "webhook", "webhookName": "bot-feed" }
```

No dashboard escolhes o distributor de uma lista — cria-o primeiro na página **Webhooks**. A
entrega é interna ao processo, por isso o `authToken` e a allowlist de IPs do distributor não
se aplicam a ela — continuam a valer para quem lhe bata de fora.

**Qual usar:** se perderes uma resposta do agente for inaceitável, usa `kind: "webhook"`.

### Semântica de entrega (importante)
- **Responde `2xx`** para confirmar a receção.
- `agent_message` é **at-least-once**: **deduplica sempre pelo `message.uuid`** do teu lado.
- Quantas tentativas depende do modo do conector, porque o que serve de rede de segurança
  é diferente:

| Modo | `agent_message` | Porquê |
|---|---|---|
| `poll` | 1 tentativa | A mensagem não é marcada como lida enquanto não for entregue, por isso o poller volta a apanhá-la. O retry real é o ciclo de polling. |
| `webchat-api` | 3 tentativas, depois **DLQ** | Não há poller — a GoContact empurra cada resposta **uma só vez**. Sem isto, um bot em baixo dois segundos perdia a mensagem em silêncio. |

- `chat_closed` tenta sempre 3 vezes e vai para a DLQ; é *fire-once* (a sessão já não existe).
- Um target `kind: "webhook"` faz 1 tentativa para *entregar ao distributor* — a partir daí a
  durabilidade é dele.
- No replay da DLQ a credencial do target é **re-derivada da configuração atual** do conector,
  não lida da entrada em fila. É por isso que o segredo não está no `dlq.json`, e é também por
  isso que rodar a credencial faz os replays pendentes passarem a usar a nova.

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
| Auth | verify token (`?token=` / `X-Forward-Token`) + IP allowlist | Bearer / Basic / header à escolha; `X-Connector` identifica o conector |
| Ack | resposta síncrona `{status:"accepted", session:{…}}` | responde `2xx`; deduplica por `message.uuid` |
| Sessão | criada durante o pedido; devolvida em `session` (ou `session:null` + `reason`) | `agent_joined` avisa quando um humano assume |

**Configuração mínima do conector `generic`:** credenciais GoContact + **pelo menos um
Webhook Target** (sem ele não há por onde devolver as respostas do agente).
