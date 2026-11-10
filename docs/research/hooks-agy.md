# Hooks do Antigravity CLI (`agy`)

Estudo da Tarefa 0 — 10/11/2026, `agy` 1.5.4 na box. Fontes: documentação embutida do próprio CLI (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`) + capturas nossas na sandbox (só nomes de campos; valores omitidos).

## 1. Onde ficam

- Um `hooks.json` na **raiz de customização do projeto**: `<projeto>/.agents/hooks.json` (também aceitos `.agent/`, `_agents/`, `_agent/`). Na box **não existe** `~/.gemini/config/hooks.json` hoje; o escopo natural é o projeto.
- Formato: objeto cujas chaves são **nomes de hook** (ex.: `pixel-kaisha`), cada um com `enabled` opcional e listas por evento. Eventos de ferramenta usam grupos `{ matcher, hooks: [...] }` (matcher regex sobre o nome da ferramenta, `*` = todas); os demais usam lista direta de handlers.
- Handler: só `type: "command"`, `command` (rodado via `sh -c`), `timeout` em segundos (padrão 30).
- **O cwd do hook é a pasta que contém o `hooks.json`** (ex.: `.agents/`), não o projeto. Caminho relativo errado quebra o hook (vimos isso).
- Sem trust/consentimento: o arquivo no projeto basta.

## 2. Teste na sandbox

Config `sandbox/.agents/hooks.json` com os 6 eventos → logger passivo. `agy -p` com uma tarefa de 1 comando shell (~15–20 s). Nada global tocado.

Resultado: **funciona**, com três achados importantes:

1. **Saída `{}` no `PreToolUse` = NEGAR.** O campo `decision` é obrigatório; objeto vazio fez o agy bloquear `run_command` ("tool call denied by pre-tool hook").
2. **Hook que falha (exit ≠ 0) também BLOQUEIA a ferramenta** (fail-closed): com caminho relativo errado (exit 127) o agy recusou o comando e pediu para consertar o hook.
3. **Saída vazia + exit 0 no `PreToolUse` = segue o fluxo normal de permissões.** É o único modo passivo seguro. Com isso o arquivo foi criado e a sequência foi:

`SessionStart` → `PreInvocation` → `PreToolUse`(run_command) → `PostToolUse`(run_command) → `PostInvocation` → `PreInvocation` → `PostInvocation` → `Stop`.

Não existe `SessionEnd`: o fim é o `Stop` (com `terminationReason`, ex. `NO_TOOL_CALL` = turno normal) ou silêncio.

## 3. Esquema do payload (camelCase)

- **Comuns:** `conversationId`, `workspacePaths` (lista), `transcriptPath` (em `~/.gemini/antigravity-cli/brain/<conversa>/…/transcript_full.jsonl`), `artifactDirectoryPath`, `modelName`, `lastUserInput` (**texto do usuário — não encaminhar**), `hookEventName`, `cwd`.
- **Correção do plano:** o payload **traz o nome do evento** (`hookEventName`). Não é preciso um handler por evento; ainda assim passar o evento como argumento do comando é um cinto de segurança barato.
- `PreToolUse`: + `stepIdx`, `toolCall` { `id`, `name` (ex. `run_command`), `args` (objeto com chaves em PascalCase, ex. linha de comando, espera, resumo) }.
- `PostToolUse`: igual ao Pre (mesmo `toolCall.id`) + `error` (string; vazia no sucesso).
- `PreInvocation`/`PostInvocation`: + `invocationNum`, `initialNumSteps`.
- `Stop`: + `executionNum`, `terminationReason`, `error`, `fullyIdle`.
- Saídas permitidas: Pre pode `allow`/`deny`/`ask`/`force_ask` e reescrever argumentos; Session/Invocation podem injetar mensagens; Stop/PostInvocation podem forçar continuação. **Nada disso será usado.**

## 4. Mapeamento para `AgentEvent`

| agy | AgentEvent |
|---|---|
| `SessionStart` | sessionStart (id = `conversationId`) |
| `PreToolUse` | toolStart (id = `toolCall.id`, rótulo a partir de `toolCall.name`) |
| `PostToolUse` | toolEnd (falha se `error` não vazio) |
| `PreInvocation` | progress (opcional; "pensando") |
| `Stop` | turnEnd (`awaitingInput` quando `NO_TOOL_CALL` e `fullyIdle`) |
| — | sessionEnd por inatividade (timer), já que não há evento |

## 5. Custo estimado

- Provider `agy` no padrão do Codex: installer de `<dir>/.agents/hooks.json` (merge preservando outros nomes de hook, backup, uninstall), script passivo com tradução camelCase → `session_id`/`hook_event_name` antes do POST, normalizador da tabela acima, `isPresent` (`agy` no PATH), testes com fixtures.
- Depende do roteamento por `providerId` (que o Codex também precisa). Sem trust, sem config global.
- **Estimativa: ~0,5 dia-bot no padrão antigo** (no ritmo atual, ~20–30 min de implementação + teste curto). Cabe no limite de ≤ 1 dia.

## Implicações para a v0.1

1. **agy entra na v0.1.**
2. **Hooks de projeto do agy na sandbox funcionam** sem nada global.
3. Regra de ouro do script agy: **sempre exit 0, nunca imprimir nada no `PreToolUse`**, envolver tudo em try/catch, timeout curto (≤ 2 s) e POST em segundo plano — um bug aqui **bloqueia as ferramentas do agente**. Para os outros eventos, imprimir `{}`.
4. Comando com caminho absoluto (cwd = pasta do `hooks.json`).
5. Hooks são síncronos: medir o overhead no teste de aceitação 8 também para o agy.
6. Não encaminhar `lastUserInput` nem `toolCall.args` completos ao servidor; mandar só o necessário para o rótulo.
