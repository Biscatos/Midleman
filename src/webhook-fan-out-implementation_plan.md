# Plano de Implementação: Distribuidor de Webhooks (Fan-out)

O objetivo é criar uma nova funcionalidade no Midleman que actue como um multiplicador (fan-out) de Webhooks. Ele irá escutar numa porta dedicada (à semelhança dos *Targets*) e, sempre que receber um pedido (ex: um POST com JSON), irá duplicá-lo e enviá-lo simultaneamente para **múltiplos endereços de destino** configurados.

> [!IMPORTANT]
> **User Review Required - Decisão de Arquitetura:**
> Quando o Midleman recebe o Webhook original, como deve responder ao cliente que o enviou?
> **Opção A (Recomendado para Webhooks):** Responde imediatamente com `202 Accepted` indicando que recebeu a mensagem e, em pano de fundo (*background/fire-and-forget*), envia os pedidos reais para os múltiplos destinos. Evita problemas de *timeout* caso um dos destinos finais seja lento.
> **Opção B:** Espera que todos os destinos respondam (com `Promise.allSettled`) e devolve um sumário completo de sucessos e erros ao chamador original.
> Diga-me qual prefere!

## Resumo das Alterações

---

### Backend (Core & Servlets)

#### [MODIFY] [src/core/types.ts](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/core/types.ts)
- Adicionar a nova estrutura (ex: `WebhookDistributor`):
  `{ name: string, port: number, targets: string[], authToken?: string }`

#### [MODIFY] [src/core/store.ts](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/core/store.ts)
- Implementar a persistência em ficheiro JSON próprio: `data/webhooks.json`

#### [MODIFY] [src/servers/port-manager.ts](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/servers/port-manager.ts)
- Adicionar o bloco de `webhooks` ao `ports.json` de forma a garantir a persistência das portas (o mesmo sistema robusto que acabámos de resolver para os Targets).

#### [NEW] `src/servers/webhook-server.ts`
- Lógica do novo serviço `Bun.serve`. Irá ler o Payload e os Headers originais num buffer e disparar ciclos [fetch()](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/servers/port-manager.ts#42-43) simultâneos para todos os URLs registados, integrando-se nativamente com a camada de métricas e Telemetria (Log individual na SQLite para cada envio de rescaldo).

#### [MODIFY] [src/index.ts](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/index.ts)
- Adicionar a nova familia de Endpoints ao Admin API (`GET, POST, DELETE /admin/webhooks`).
- Adicionar a rotina de arranque (boot e re-reload) para arrancar automaticamente os servidores de webhook guardados.

---

### Interface Web (Dashboard)

#### [MODIFY] [src/views/dashboard.html](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/views/dashboard.html)
- Adicionar um novo painel lateral na Navbar: **"Webhooks"**.
- Terceira secção no ecrã (perto de Targets e Profiles).
- Novo Modal de criação de Webhook, com uma interface que permite **Adicionar (dinamicamente) múltiplas caixas de alvo** para cada URL da lista, com botão "Remover URL".

#### [MODIFY] [src/views/js/dashboard-data.js](file:///c:/Users/Julio.rei/Documents/GitHub/Midleman/src/views/js/dashboard-data.js)
- Adicionar a ponte JavaScript (operações de CRUD para Webhooks) para ligar as ações do dashboard ao sistema REST API.

---

## Passo Seguinte
Se este plano fizer sentido para si (e após me confirmar a resposta entre a Opção A/B), avançaremos diretamente com a escrita e introdução do backend e do novo store de JSON!
