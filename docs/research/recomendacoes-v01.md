# Recomendações para a v0.1

Fecho da Tarefa 0 — 10/11/2026. Base: `fork-internals.md`, `hooks-claude.md`, `hooks-codex.md`, `hooks-agy.md`, `codex-cloud-output.md`.

## Decisão 1 — agy na v0.1?

**SIM, agy entra na v0.1 (B4).**

- Esforço estimado ≤ 1 dia (≈ 0,5 dia-bot no padrão antigo; ~20–30 min no ritmo atual), porque:
  - hooks de projeto do agy **funcionaram na sandbox** sem trust e sem config global;
  - o payload traz `hookEventName` (o plano supunha o contrário), então um único script resolve;
  - o trabalho pesado (roteamento por `providerId`) já é necessário para o Codex.
- Condições: script passivo que **sempre** sai com 0 e **não imprime nada no `PreToolUse`** (`{}` nega a ferramenta; falha do hook também bloqueia). Sem isso, o agy de qualquer bot que usar a sandbox fica travado.

## Decisão 2 — hooks de projeto na sandbox funcionam?

Regra do Lucas: hooks **só** em `/workspace/pixel-agents/sandbox`, nunca em `~/.claude`, `~/.codex`, `~/.gemini`.

| Motor               | Arquivo na sandbox              | Funciona?                      | Observação                                                                                                                      |
| ------------------- | ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.310 | `sandbox/.claude/settings.json` | **Sim** (testado, `claude -p`) | Sem trust em `-p`; 10 eventos capturados                                                                                        |
| agy 1.5.4           | `sandbox/.agents/hooks.json`    | **Sim** (testado, `agy -p`)    | Cuidado com o `PreToolUse` (ver acima); cwd do hook = `.agents/`                                                                |
| Codex 0.163.0       | `sandbox/.codex/hooks.json`     | **Não, sozinho**               | Arquivo é lido, mas hooks ficam em silêncio sem trust de projeto **e** trust por hash, ambos gravados no `~/.codex/config.toml` |

### Bloqueio do Codex — decisão necessária do Lucas

Escolher um:

- **(a) Recomendado:** uma sessão interativa do `codex` na sandbox para confiar o projeto e os hooks em `/hooks`. Grava só **registros de confiança** no `~/.codex/config.toml` (nenhum hook global; outros bots não são afetados). Precisa repetir se o hook mudar.
- (b) `--dangerously-bypass-hook-trust` só nas execuções de teste da sandbox (nada gravado; o plano tinha descartado).
- (c) Sem prova ao vivo: provider Codex validado só com fixtures na v0.1; prova ao vivo na v0.2.

Sem resposta, B2 segue com (c) e não trava B3/F1.

## Outras recomendações (para B1–B4 e F1)

1. **B2 começa pelo roteamento por `providerId`** (runtime com mapa de providers; handler e buffer de sessão usam o provider do id). É pré-requisito de Codex e agy.
2. **Installers com alvo configurável** (diretório do projeto) para os três motores, com backup e uninstall por diff vazio. Modo global fica desligado na v0.1.
3. Scripts de hook: caminho absoluto, fail-open (exceto o cuidado especial do agy), timeout ≤ 2 s, POST assíncrono, sem encaminhar prompt (`prompt`, `lastUserInput`) nem argumentos completos.
4. Gate HTTP: o script do agy traduz para `session_id`/`hook_event_name`; o Codex já usa snake_case.
5. **B3:** criar o tipo de provider por polling no core; `codex cloud list --json` com `cwd` em diretório temporário (o CLI grava `error.log` com o ID da conta), paginação por `cursor`, status desconhecido tolerado, fixtures para os status não vistos (só `ready` existe na conta).
6. **F1:** o protocolo WS já tem tudo para agentes locais; o fantasma ☁ precisa de um campo aditivo de origem/URL/fornecedor nas mensagens de criação de agente (mudança no AsyncAPI; o Front pode mockar).
7. Repo: adicionar `error.log` ao `.gitignore`. Rodar o servidor com `--port 3100` (porta padrão é efêmera).
8. Teste de aceitação: não depender do exit code do `codex exec` (saiu 1 por causa de um MCP global sem auth, mesmo concluindo).

## Implicações para a v0.1

- Escopo da v0.1: Claude + agy ao vivo na sandbox; Codex local com fixtures e prova ao vivo **condicionada à decisão (a)/(b)**; Codex Cloud por polling somente leitura.
- Nada global é escrito por nenhum bot sem novo ok do Lucas.
- Ordem: B1 → B2 (roteamento + installers de projeto + Codex) → B4 (agy, logo depois do roteamento) ‖ B3; F1 começa já com mock.
