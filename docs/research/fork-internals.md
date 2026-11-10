# Fork internals (Pixel Kaisha, base upstream v1.6.0)

Estudo da Tarefa 0 — 10/11/2026. Só conclusões e esquemas descritos com nossas palavras; nenhum trecho de código do upstream foi copiado. Base: `main` do fork em `9a154fd` (upstream Pixel Agents v1.6.0, MIT).

## 1. Camadas

- `core/` — tipos e protocolo, sem efeitos colaterais. Define o contrato de provider, a união de eventos normalizados e o esquema AsyncAPI (`core/asyncapi.yaml`, "Pixel Agents Protocol" 1.0.0).
- `server/` — servidor Fastify + WebSocket, runtime dos agentes, providers concretos, persistência em `~/.pixel-agents/`.
- `webview-ui/` — SPA React (a mesma no VS Code e no standalone).
- `adapters/vscode/` — extensão VS Code. O CLI standalone (`server/src/cli.ts` → `dist/cli.js`) **não** depende dele.

## 2. Contrato de provider

- **Evento normalizado (`AgentEvent`)**: união discriminada por `kind`, com os casos: início/fim de ferramenta, fim de turno (com flag "aguardando input"), início/fim/fim-de-turno de subagente, progresso, pedido de permissão, início e fim de sessão. É a única coisa que o runtime entende; cada motor traduz o seu formato para isso.
- **`HookProvider`** (`kind: 'hook'`): identidade (`id`, nome de exibição, versão de protocolo = 1), uma função que normaliza o payload bruto do hook em `AgentEvent`, instalação/remoção/checagem dos hooks, texto de consentimento, tabelas de nomes de ferramentas e opcionais (diretórios de sessão, comando de lançamento/resume, ponte de uso/limites, título de conversa, times).
- Não existe tipo de provider por polling nem por stream. O próprio arquivo deixa isso para quando houver um segundo provider real. **O cloud poller (B3) terá de criar esse tipo.**
- Registro: uma lista estática de hook providers em `server/src/providers/index.ts`, hoje só com `claude`, e uma busca por id.

## 3. Caminho de um evento de hook

1. O motor (Claude) executa o script de hook copiado para `~/.pixel-agents/hooks/`.
2. O script lê o **registry de servidores** (`~/.pixel-agents/servers/<pid>-<porta>.json`, um arquivo por servidor vivo, com porta e token) e faz `POST /api/hooks/<providerId>` com `Authorization: Bearer <token>` para **todos** os servidores vivos (fan-out), com timeout curto (~2 s). Servidor ausente = o script sai sem erro (fail-open).
3. A rota HTTP só aceita o corpo se ele tiver `session_id` e `hook_event_name` (formato snake_case do Claude). Payload camelCase (agy) é descartado aqui.
4. O runtime entrega ao `HookEventHandler`, que **ignora o `providerId`** e normaliza sempre com o provider único recebido no construtor. Tanto o CLI quanto o adapter VS Code constroem o runtime com o provider Claude fixo.
5. Eventos de sessões ainda desconhecidas ficam num buffer (`sessionRouter`) até a sessão ser associada a um agente; o descarte do buffer também passa pelo mesmo caminho single-provider.
6. O handler atualiza o `AgentStateStore`, que emite eventos; a camada WebSocket transforma em mensagens para a UI.

Fallback sem hooks: leitura dos transcripts JSONL do Claude em `~/.claude/projects/<cwd-sanitizado>/` (file watcher + parser).

## 4. Protocolo servidor ↔ UI

- Um único canal WebSocket bidirecional em `/ws`, descrito em AsyncAPI.
- **Servidor → cliente**: capacidades de provider; ciclo de vida de agente (criado, fechado, selecionado, lista de existentes); status e atividade de ferramentas (início, fim, limpar, permissão pendente e limpeza); atividade de subagentes; info de times; uso de contexto; layout; assets (móveis, personagens, sprites, pets); configurações e consentimento de hooks. Cada mensagem tem um campo `type` discriminante.
- **Cliente → servidor**: comandos (`webviewReady`, abrir/fechar agente, salvar layout, configurações, resposta de consentimento etc.).
- Também há rotas HTTP: `/api/health`, `/api/hooks/:providerId`, `/api/usage/:providerId` e o terminal (`/terminal/:id`).

## 5. Token e modo só leitura

- Standalone gera um token persistido em `~/.pixel-agents/standalone-token` e imprime `http://<host>:<porta>/?token=…`. A porta padrão é efêmera; precisamos fixar com `--port 3100`.
- Conexão WS: no standalone basta handshake same-origin; **privilégio** exige o `?token=` correto e um Host permitido (loopback ou `--allowed-host`). Sem token a conexão é aceita, mas é **somente leitura**: não lança agentes, não muda config e não recebe mensagens privilegiadas (ex.: uso da conta). Token com Host não listado também vira só leitura (com aviso no log).
- O token é removido dos logs de request. `--no-terminal` desliga o terminal remoto; `--rotate-token` troca o segredo.
- Hooks usam o mesmo token, via Bearer, lido do registry.

## 6. Consentimento de hooks

- Pedido na UI (não no CLI): quando um cliente com token envia `webviewReady`, o servidor pergunta se pode instalar hooks. Sem resposta, o servidor roda sem hooks.
- Instalação do Claude: copia o script empacotado, escreve entradas no settings global do Claude com backup único e escrita atômica, preserva hooks de terceiros. Remoção restaura.

## Implicações para a v0.1

1. **Primeira mudança obrigatória (B2):** rotear por `providerId` — runtime com mapa de providers, handler usando o provider do id da rota, buffer de sessão guardando o id. Sem isso, Codex e agy seriam normalizados como Claude.
2. **Gate HTTP:** aceitar o formato de cada provider (delegar a validação ao provider) ou exigir que os scripts traduzam para `session_id`/`hook_event_name`. Recomendado: o script do agy traduz (menos mudança no core), e o gate vira "provider existe + normalização não-nula".
3. **Instalação no CLI** deve iterar sobre providers (consentimento, cópia de script, install) em vez de ser Claude-only; portar `isPresent?()` do PR #409.
4. **Hooks em escopo de projeto** (sandbox) não existem no fork: os installers só conhecem configs globais. Para a v0.1 basta um modo "instalar no diretório X" (`.claude/settings.json`, `.codex/hooks.json`, `.agents/hooks.json` da sandbox), com uninstall por diff/backup.
5. **B3:** criar o tipo de provider por polling no core; o poller emite `AgentEvent` sintéticos (`sessionStart` headless → `turnEnd`/`sessionEnd`) para reaproveitar o mesmo protocolo, mais um campo de origem (`cloud`, URL) que o Front precisa para o fantasma ☁ — mudança aditiva no AsyncAPI.
6. Rodar sempre com `--port 3100` e, se for demonstrar ao vivo, `--no-terminal`.
