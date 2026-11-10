# Cloud agents and engine badges: server → UI messages (Pixel Kaisha)

Additive to the existing WebSocket protocol (`/ws`, see `core/asyncapi.yaml`). Older servers that never send these keep working: the UI just shows no ghosts and tags every local agent as Claude.

## `cloudAgents` (B3 cloud poller → UI)

Sent once per poll, per cloud provider, and once to each client on connect (after `webviewReady`).

```json
{
  "type": "cloudAgents",
  "providerId": "codex-cloud",
  "providerName": "Codex Cloud",
  "available": true,
  "reason": "optional text when available is false",
  "tasks": [
    {
      "id": "task_e_…",
      "url": "https://chatgpt.com/codex/tasks/task_e_…",
      "title": "…",
      "status": "ready",
      "updatedAt": "2026-11-10T16:00:00.000Z"
    }
  ]
}
```

- `tasks` is the **full** current list for that provider (snapshot, not diff). A task missing from it disappears.
- `status` is the vendor's raw value (`codex cloud list --json`). The UI maps it: `ready`/`completed`/… → ready ✓; `pending`/`running`/… → active; `error`/`failed`/`cancelled`/… → error; anything else → unknown (never breaks).
- `available: false` (logged out, no network, exit ≠ 0): send it with or without `tasks`. Without `tasks`, the UI keeps the last list and greys it out as "unavailable".
- Clicking a ghost opens `url` in a new tab (only `http(s)` URLs are opened).
- Do not log `title` on the server (it may hold user text); sending it to the UI is fine.

UI side: `webview-ui/src/cloud/cloudStore.ts` (`handleCloudMessage`), rendered by `cloud/CloudGhosts.tsx`.

## `providerId` on local agents (B2/B4 → UI)

- `agentCreated.providerId`: `"claude" | "codex" | "agy"` (missing = `claude`).
- `existingAgents.providerIds`: `{ [agentId]: providerId }` (missing entries = `claude`).

UI side: `webview-ui/src/cloud/engineBadge.ts`, shown as a coloured badge on the agent label.

## Dev fixture

`npm run dev` in `webview-ui/`, then open `http://localhost:5173/?mock=cloud` (add `&cloud=unavailable` for the offline state). The fixture (`cloud/cloudMock.ts`) plays three local agents (Claude, Codex, agy) and three Codex Cloud tasks; the running one turns ready after two simulated polls.
