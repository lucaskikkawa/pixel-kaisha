# Agent history: client ↔ server messages (Pixel Kaisha B2.2)

Additive to the existing WebSocket protocol (`/ws`, see `core/asyncapi.yaml`). Older servers never answer the new request; older clients never send it. Server code: `server/src/agentHistory.ts` (pure, tested in `server/__tests__/agentHistory.test.ts`) and `server/src/agentHistoryLog.ts` (hooks-only buffer).

The Front (F2.2) asks for it when a character is clicked. **No model is called.** The text cutting is the B2.1 one (`truncateSummary`, [protocol-summary.md](protocol-summary.md)), only longer:

| Kind     | Max (code points, `…` included) | Source                                                  |
| -------- | ------------------------------- | ------------------------------------------------------- |
| `speech` | 500 (`HISTORY_TEXT_MAX`)        | a visible user prompt or assistant text                 |
| `action` | 120 (`HISTORY_ACTION_MAX`)      | the provider's `formatToolStatus` label of a `tool_use` |

## `requestAgentHistory` (client → server)

```json
{ "type": "requestAgentHistory", "id": 3, "limit": 100, "before": 1762941600000 }
```

- `id`: the agent's id in the office (integer).
- `limit?`: entries per page, integer 1–500, default 100.
- `before?`: exclusive upper bound in epoch ms (positive integer): only entries with `ts < before`. To page back, send the `ts` of the oldest entry you have.

## `agentHistory` (server → client)

Sent to the asking client only (never broadcast).

```json
{
  "type": "agentHistory",
  "id": 3,
  "sessionId": "8f3a…",
  "entries": [
    {
      "ts": 1762941601000,
      "kind": "speech",
      "role": "user",
      "text": "Build the calculator",
      "shared": true,
      "teamName": "calc-team",
      "authorAgentId": 3
    },
    {
      "ts": 1762941602000,
      "kind": "action",
      "toolName": "Read",
      "text": "Reading calc.ts",
      "shared": true,
      "teamName": "calc-team",
      "authorAgentId": 3
    },
    {
      "ts": 1762941603000,
      "kind": "speech",
      "role": "assistant",
      "text": "Tests pass.",
      "shared": true,
      "teamName": "calc-team",
      "authorAgentId": 4
    }
  ],
  "more": true,
  "group": { "teamName": "calc-team", "leadAgentId": 3, "memberAgentIds": [3, 4] }
}
```

- `entries`: chronological, oldest first: the newest `limit` entries with `ts < before`.
- `role`: speech only (`user` | `assistant`). `toolName`: action only.
- `more: true`: older entries exist past this page, or the transcript was too big to read whole (see Limits). Absent = this is the start.
- `reason?`: set only with empty `entries`: `unknown-agent` (no such agent in the office) or `invalid-request` (`id`, `limit` or `before` malformed; `id` is then echoed when it is an integer, else `-1`). The server never throws on a bad request.

### Groups

When the agent is a Lead or a Teammate (`isTeamLead`, `leadAgentId` or `teamName`):

- The entries come from the **shared session**: the Lead's transcript (or the Lead's hooks-only buffer). If the Lead is not in the office, the agent's own session is used.
- Every entry carries `shared: true` and `teamName` when known.
- `authorAgentId`: the member whose `agentName` the record is tagged with; otherwise the Lead (main chain of the Lead's transcript). Omitted when unknown (no Lead in the office and no matching tag).
- A Teammate with a transcript of its own (own session, e.g. an implicit-team or tmux teammate) also gets its own entries, merged by `ts`, authored by itself, also `shared`.
- `group`: `leadAgentId` and `memberAgentIds` = the agents **currently** in the office that share the `teamName`, the Lead (`leadAgentId`) or the Lead's `sessionId`. The requested agent is always listed.

A solo agent has no `shared`, no `authorAgentId` and no `group`.

## Where the entries come from

- **Transcript (Claude JSONL)**: the agent's `jsonlFile`, re-read on every request. Kept: user prompts and assistant visible text (the same rule as `speechFromTranscriptRecord`, B2.1) and one action per `tool_use`. Skipped: system and meta records, tool results, slash-command echoes, thinking, and **sidechains** in a Lead's or solo agent's transcript (those are Sub-agent turns; this task does not route them to the Sub-agent). A Teammate's own transcript is sidechain top to bottom, so its sidechain records are read.
- **Timestamps**: the record's `timestamp` (ISO) or `ts` (number). A record without one takes the previous record's time (the file's mtime before any), so file order is kept and paging stays stable.
- **Hooks-only agents (agy, Codex)**: no transcript exists to re-read. The server keeps an in-memory `historyLog` (max 500 entries, oldest dropped) on the agent, appended each time `syncAgentSummary` sees a new action (the hook's `PreToolUse`, full label cut at 120, `toolName` from the hook) or a new speech. Hook scripts do not forward prompts, so in practice it holds actions only. **It is lost on server restart** and is never written to disk. An agent that saw no event yet answers `entries: []` (no `reason`).

## Limits

To keep the event loop free, the transcript is read asynchronously and only its tail: the last 2 MB (`HISTORY_READ_MAX_BYTES`) and of those the last 5000 records (`HISTORY_READ_MAX_RECORDS`). When either cut drops something, every page says `more: true`; entries older than the tail are not reachable in this version.

## Privacy

- History text may quote the user. `requestAgentHistory` is answered **only on privileged sockets**: the read-only gate at the top of `handleClientMessage` (`refuseReadOnly`) drops it for a read-only socket, which gets no reply. `agentHistory` is also in `PRIVILEGED_BROADCAST_TYPES` in case it is ever broadcast.
- The server never logs history text (an error building it logs the error message only).
