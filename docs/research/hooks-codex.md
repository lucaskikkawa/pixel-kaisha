# Hooks do Codex CLI

Estudo da Tarefa 0 — 10/11/2026, `codex-cli 0.163.0` na box (feature `hooks` = stable, ligada). Fontes: testes nossos na sandbox + documentação oficial de hooks do Codex + leitura do PR #409 do upstream (só conclusões).

## 1. Onde ficam

- Codex procura hooks ao lado de cada camada de config ativa: `hooks.json` ou tabelas `[hooks]` no `config.toml`.
- Global: `~/.codex/hooks.json` / `~/.codex/config.toml` (o PR #409 usa `~/.codex/hooks.json` e não mexe no `config.toml`).
- **Projeto:** `<projeto>/.codex/hooks.json` ou `<projeto>/.codex/config.toml` — **só carrega se a camada `.codex/` do projeto estiver confiável**.
- Fontes se somam (uma camada não substitui a outra). Hooks do mesmo evento rodam em paralelo.
- Formato: igual em espírito ao do Claude — `hooks.<Evento>` = grupos `{ matcher?, hooks: [ { type: "command", command, timeout } ] }`.

## 2. Trust de hooks (o ponto crítico)

Dois níveis de confiança, ambos guardados no **config global** `~/.codex/config.toml`:

1. **Projeto confiável:** entrada `[projects."<caminho>"]` com `trust_level = "trusted"` (Codex procura a pasta e depois a raiz do repo git).
2. **Cada hook não-gerenciado** precisa de um registro de confiança com o **hash da definição** (seção de estado de hooks). Trust é dado no TUI em `/hooks`. Editar o hook invalida o hash → o hook volta a ser ignorado **em silêncio**.

Alternativas: hooks "managed" (sistema/MDM/`requirements.toml`) são confiáveis por política; `--dangerously-bypass-hook-trust` roda sem trust por invocação — **não vamos usar** (decisão do plano).

## 3. Teste na sandbox

Config: `sandbox/.codex/hooks.json` com SessionStart, SessionEnd, Stop, PermissionRequest, PreToolUse, PostToolUse, SubagentStart, SubagentStop, UserPromptSubmit → logger passivo. Sem nenhuma escrita em `~/.codex`.

- **Execução 1** (`codex exec`, modelo barato, 1 comando shell): o arquivo foi **lido** (Codex avisou que limitou o timeout de `SessionEnd` a 3 s), mas **nenhum hook executou**. Nenhum aviso de "precisa de review" no `exec`.
- **Execução 2**: mesma coisa com o projeto marcado como confiável **só na linha de comando** (`-c projects."<sandbox>".trust_level="trusted"`, sem gravar arquivo): **nenhum hook executou** — falta o trust por hash, que só existe no config global.
- Conclusão: **hooks de projeto do Codex não rodam na sandbox sem escrever no `~/.codex/config.toml`** (ou sem o flag perigoso). Isso bate com uma issue reportada no repositório do Codex sobre hooks de projeto ignorados em silêncio no `exec`.
- Efeito colateral notado: `codex exec` saiu com código 1 mesmo concluindo a tarefa (erro de um MCP global sem auth). Não é dos hooks, mas o teste de aceitação não deve depender do exit code.

## 4. Eventos e payload (documentação oficial + PR #409; não capturado por nós)

- Eventos: `SessionStart` (início/resume/clear/compact/fork), `SessionEnd` (fim, arquivamento ou 30 min ocioso; timeout padrão 1 s, **máx. 3 s**), `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `Stop` (fim de turno), `Interrupt`.
- Payload em **snake_case**, no estilo do Claude: id de sessão, caminho do transcript (rollout em `~/.codex/sessions/AAAA/MM/DD/`), `cwd`, nome do evento, modelo; nos eventos de ferramenta, nome da ferramenta (`exec_command`/shell, `apply_patch`, MCP, …), entrada e id da chamada; no Post, a resposta.
- `PreToolUse` cobre shell, `apply_patch`, MCP e ferramentas locais; ferramentas hospedadas (web search) não.
- Hooks podem negar/reescrever (`PreToolUse`) ou decidir permissão; o nosso tem de ser **passivo** (sem decisão). O #409 usa modo assíncrono para não atrasar o motor, exceto `SessionEnd` (síncrono, 3 s).

## Implicações para a v0.1

1. **Hooks de projeto do Codex na sandbox NÃO funcionam sem config global.** Para provar o teste de aceitação 5 há três caminhos, todos precisam de decisão do Lucas:
   - **(a) Recomendado:** uma única sessão interativa `codex` na sandbox, confiar o projeto e os hooks em `/hooks`. Isso grava só **registros de confiança** (projeto + hash) no `~/.codex/config.toml` — nenhum hook global; os hooks continuam só na sandbox. Re-trust a cada mudança do hook.
   - (b) `--dangerously-bypass-hook-trust` apenas nas execuções de teste na sandbox (o plano disse não).
   - (c) Hook global em `~/.codex/hooks.json` (o que o PR #409 faz) — vetado pelo Lucas.
2. Sem (a) ou (b), B2 entrega o provider Codex com testes por **fixtures** e a prova ao vivo fica pendente.
3. O installer do provider Codex precisa do alvo `<dir>/.codex/hooks.json` e deve **avisar que é preciso dar trust em `/hooks`** (instalar ≠ aparecer personagem). O `areHooksInstalled` não consegue saber se há trust; mostrar isso na UI como "instalado, aguardando trust".
4. Respeitar o limite de 3 s do `SessionEnd`; hooks assíncronos nos demais; nunca emitir decisão.
5. O normalizador do Codex é parecido com o do Claude (snake_case), então o gate HTTP atual aceita o formato; o que falta é o roteamento por `providerId` (ver `fork-internals.md`).
