# Saída do `codex cloud` (somente leitura)

Estudo da Tarefa 0 — 10/11/2026, `codex-cli 0.163.0`. Todos os comandos rodaram a partir de um diretório temporário em `/tmp` (apagado depois). Nenhuma tarefa foi criada. Exemplos anonimizados.

## 1. Comandos

- `codex cloud` é marcado **EXPERIMENTAL**. Subcomandos: `list`, `status`, `diff`, `apply`, `exec` (cria tarefa — **não usar**).
- `list`: `--json`, `--limit N` (1–20, padrão 20), `--cursor <c>` (paginação), `--env <id>` (filtro).
- `status <TASK_ID>`: **sem `--json`**; saída em texto.

## 2. `list --json` — esquema

Objeto raiz: `tasks` (lista) e `cursor` (string ou `null`; `null` = última página).

Cada tarefa:

| Campo | Tipo | Observação |
|---|---|---|
| `id` | string | prefixo `task_e_…` |
| `url` | string | página da tarefa no ChatGPT/Codex (o clique do fantasma ☁ abre aqui) |
| `title` | string | título gerado (pode conter texto do usuário) |
| `status` | string | ver §3 |
| `updated_at` | string | ISO-8601 em UTC com nanossegundos |
| `environment_id` | string ou null | null observado |
| `environment_label` | string | nome do ambiente |
| `summary` | objeto | `files_changed`, `lines_added`, `lines_removed` |
| `is_review` | bool | tarefa de review |
| `attempt_total` | int | número de tentativas |

Exemplo anonimizado (capturado por nós):

```
{ "tasks": [ { "id": "task_e_<ID>", "url": "https://chatgpt.com/codex/tasks/task_e_<ID>",
  "title": "<título>", "status": "ready", "updated_at": "2026-06-29T14:29:19.349Z",
  "environment_id": null, "environment_label": "<ambiente>",
  "summary": { "files_changed": 0, "lines_added": 0, "lines_removed": 0 },
  "is_review": false, "attempt_total": 1 } ], "cursor": null }
```

## 3. Status

- **Observado: só `ready`** (a conta tem 1 tarefa; o texto mostra `[READY]`).
- Não observados (hipótese, a validar só com fixtures): algo como pendente/em execução, erro, cancelado/aplicado. O adaptador deve tratar **qualquer valor desconhecido** como "desconhecido" sem quebrar.
- Mapeamento proposto: `ready` → pronto (✓); pendente/rodando → ativo; erro/falha → erro; desconhecido → neutro.

## 4. `status <id>` (texto)

Três linhas: `[STATUS] título`, `ambiente • data local`, e um resumo do diff (ex. "no diff"). Não serve para parsing robusto; o poller deve usar só o `list --json`.

## 5. Erros e códigos de saída

| Situação | Saída | Exit |
|---|---|---|
| OK | JSON no stdout | 0 |
| `--limit` fora de 1–20 | erro de validação do argumento no stderr | 2 |
| id inexistente (`status`) | erro HTTP 404 no stderr ("Invalid task ID") | 1 |
| sem login (`CODEX_HOME` vazio) | stderr pede `codex login` | 1 |

## 6. Logs

- Toda chamada grava/atualiza **`error.log` no diretório atual**, mesmo com sucesso. O arquivo registra a URL base do backend, o modo de auth e o **ID da conta ChatGPT**, além do resumo da chamada (limite, cursor, quantidade).
- Por isso: rodar sempre com `cwd` num diretório temporário próprio do poller (ex. `/tmp/pixel-kaisha-cloud/` ou `~/.pixel-agents/cloud/`), nunca no repo; `.gitignore` com `error.log`.

## Implicações para a v0.1

1. O adaptador `codex-cloud` (B3) usa `execFile` do `list --json --limit 20` com `cwd` em diretório temporário dedicado, segue `cursor` até `null` (com teto de páginas), timeout de ~15 s.
2. Diff por `id` + `status` + `updated_at` contra o snapshot persistido → `AgentEvent` (nova tarefa = sessão headless; mudança para `ready` = fim de turno ✓).
3. Status desconhecido não derruba nada; exit ≠ 0 ou "Not signed in" → estado "indisponível" na UI (teste de aceitação 7).
4. Não enviar `title` para logs; ele pode ter texto do usuário. A UI pode mostrá-lo (já é do Lucas), mas não persistir em lugar público.
5. Fixtures com os status hipotéticos são obrigatórias, porque a conta só tem `ready` e criar tarefa está fora da v0.1.
6. Adicionar `error.log` ao `.gitignore` do repo.
