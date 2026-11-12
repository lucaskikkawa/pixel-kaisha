# Agent balloon summaries: server → UI messages (Pixel Kaisha B2.1)

Additive to the existing WebSocket protocol (`/ws`, see `core/asyncapi.yaml`). Older clients ignore the new message and fields; older servers simply never send them, and the UI shows no balloons.

**No model is called.** A summary is plain text cutting: whitespace squashed to one line, then cut by Unicode code points (never inside a surrogate pair) with a trailing `…` when cut. Server code: `server/src/agentSummary.ts`.

| Field    | Max (code points, `…` included) | Source                                                      |
| -------- | ------------------------------- | ----------------------------------------------------------- |
| `speech` | 80                              | newest visible user prompt or assistant text                |
| `action` | 60                              | the provider's `formatToolStatus` label of the current tool |

## `agentSummary`

Sent to every privileged client **only when** the agent's speech or action changes.

```json
{
  "type": "agentSummary",
  "id": 3,
  "speech": "Fix the failing login test",
  "action": "Reading auth.ts"
}
```

- It is a **full snapshot**: both keys are always present. Replace the agent's whole summary with it.
- `speech`: `string`. `""` = nothing to say yet.
- `action`: `string | null`. `null` = no active tool → clear the action balloon.

## Snapshots on connect / create

- `agentCreated.speech?` / `agentCreated.action?` (`string | null`): present only when the agent already has a summary in memory.
- `existingAgents.summaries?`: `{ [agentId]: { speech?, action? } }`, only for agents that have one. Missing entry = no summary yet.

The server does not re-read transcripts to build these on startup: a summary may stay empty until the agent's next event.

## Where the text comes from

- **Action** — hook `PreToolUse` (via `HookProvider.formatToolStatus`, same label as `agentToolStart.status`), or the transcript's `tool_use` when no hook delivered it. After `PostToolUse`, a tool result, turn end or `agentToolsClear`, `action` falls back to the newest tool still active (e.g. a live background agent), else `null`.
- **Speech** — the transcript JSONL only: a new user prompt replaces the speech, then the assistant's visible `text` blocks replace it in turn. Tool calls, tool results, thinking, system/meta records, sidechains and slash-command echoes are ignored.
- **Hooks-only agents (agy, Codex)**: no transcript is tailed and the hook scripts do **not** forward prompts (agy's consent copy says "Your prompts are not forwarded"; it is respected), so `speech` stays `""` and only `action` updates.

## Privacy

- `speech` can quote the user. `agentSummary` is in `PRIVILEGED_BROADCAST_TYPES` (like `cloudAgents`), and `speech`/`action` are stripped from `agentCreated` / `existingAgents` for read-only sockets.
- The server never logs speech or action text.

## UI side

The Front (F2.1) draws the balloons over the office characters. The server only supplies the text.
