# Hooks do Claude Code

Estudo da Tarefa 0 — 10/11/2026, Claude Code 2.1.310 na box. Payloads descritos a partir de capturas nossas em `/workspace/pixel-agents/sandbox` (só nomes de campos; valores omitidos ou anonimizados).

## 1. Onde ficam

- Global: `~/.claude/settings.json` (chave `hooks`). É onde o fork instala hoje.
- **Projeto:** `<projeto>/.claude/settings.json` (e `settings.local.json`). Mesmo formato.
- Formato: `hooks.<Evento>` = lista de grupos `{ matcher?, hooks: [ { type: "command", command, timeout } ] }`. `matcher` só importa para eventos de ferramenta/permissão.
- O payload chega em JSON no **stdin** do comando; saída vazia + exit 0 = não interfere.

## 2. Teste na sandbox (hooks de projeto)

Config: `sandbox/.claude/settings.json` apontando todos os eventos para um logger passivo (grava o stdin num log fora do repo e não imprime decisão). Comando: `claude -p` com modelo barato, uma escrita de arquivo e um `ls`. Configuração global do Claude **não** foi tocada (sem hooks).

Resultado: **funciona** — os hooks de projeto dispararam em modo `-p`, sem prompt de confiança. Sequência observada:

`SessionStart` → `UserPromptSubmit` → `PreToolUse`(Bash) → `PermissionRequest`(Bash) → `PreToolUse`(Write) → `PostToolUse`(Write) → `PreToolUse`(Bash) → `PostToolUse`(Bash) → `Stop` → `SessionEnd`.

Sessão inteira ~5 s. Uma execução que falhou no parse de argumentos ainda gerou `SessionStart` + `SessionEnd` (útil saber: sessões "vazias" existem).

## 3. Esquema dos payloads (snake_case)

- **Comuns:** `session_id`, `transcript_path` (em `~/.claude/projects/<cwd-sanitizado>/<sessão>.jsonl`), `cwd`, `hook_event_name`. A partir do prompt: `prompt_id`, `permission_mode`, `effort` (objeto).
- `SessionStart`: + `source` (ex.: `startup`; também resume/clear/compact).
- `SessionEnd`: + `reason` (ex.: `other`).
- `UserPromptSubmit`: + `prompt` (texto do usuário — **não encaminhar**, é dado pessoal).
- `PreToolUse`: + `tool_name` (`Bash`, `Write`, …), `tool_input` (objeto; Bash tem comando e descrição, Write tem caminho e conteúdo), `tool_use_id`.
- `PostToolUse`: Pre + `tool_response` (objeto específico da ferramenta) e `duration_ms`.
- `PermissionRequest`: + `tool_name`, `tool_input`, `permission_suggestions` (sem `tool_use_id`).
- `Stop`: + `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.

Eventos que o fork já instala: SessionStart, SessionEnd, Stop, PermissionRequest, Notification, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted. `UserPromptSubmit` fica de fora de propósito (só levaria o prompt).

## 4. Consentimento, instalação e uninstall no fork

- Consentimento pedido na UI (cliente com token). Sem consentimento, nada é instalado.
- Instala copiando o script empacotado para `~/.pixel-agents/hooks/` e adicionando entradas em `~/.claude/settings.json`: backup único, escrita atômica, permissões restritas em arquivo novo, preserva hooks de terceiros; timeout 5 s.
- Uninstall remove só as entradas do Pixel Agents (identificadas pelo comando).
- O script é fail-open: sem servidor, sai rápido sem erro.

## 5. Observações

- No modo interativo, configurações de projeto dependem de o diretório ter sido aceito como confiável (diálogo de confiança, registrado no estado global do Claude). Em `-p` não há diálogo. Não testamos o interativo (não é necessário para a v0.1).
- `PermissionRequest` dispara mesmo quando a ferramenta acaba liberada por regra (`--allowedTools`); a UI não deve deixar o "aguardando permissão" preso — limpar no `PostToolUse`/`Stop` seguinte.

## Implicações para a v0.1

1. **Hooks de projeto do Claude na sandbox funcionam** sem tocar em `~/.claude`. O installer precisa de um alvo configurável: `<dir>/.claude/settings.json` em vez do global.
2. Comando do hook com **caminho absoluto** (o cwd do hook não é garantido).
3. Manter a lista atual de eventos; não instalar `UserPromptSubmit`.
4. Teste de aceitação 4 (`claude -p` na sandbox) é viável com sessões de ~5 s e modelo barato.
5. Uninstall na sandbox = restaurar o arquivo de projeto a partir do backup (diff vazio).
