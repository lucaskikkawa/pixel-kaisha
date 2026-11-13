# Office rooms and presence: work, meeting, rest (Pixel Kaisha B2.3)

Additive to the existing WebSocket protocol (`/ws`, see `core/asyncapi.yaml`). Older clients ignore the new messages and fields; older servers never send them, and the UI keeps everyone in one office. Server code: `server/src/agentRoom.ts`.

```ts
type AgentRoom = 'work' | 'meeting' | 'rest';
```

| Room      | Who is there                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| `work`    | An agent at work: turn running, tool running, or waiting on the user at its desk (`awaitingInput`) |
| `rest`    | An idle agent: its turn is over and nobody asked anything. Also a new or restored agent            |
| `meeting` | Chosen by a client with `setAgentRoom`. No Scrum or ceremony logic (that is v0.3)                  |

## Automatic: work ↔ rest

The room follows the same `agentStatus` the office already receives:

| `agentStatus`                        | Room   |
| ------------------------------------ | ------ |
| `active`                             | `work` |
| `waiting` with `awaitingInput: true` | `work` |
| `waiting` without `awaitingInput`    | `rest` |
| (new agent, no turn seen yet)        | `rest` |

A new agent only enters `work` with real activity. There is one seam: every `agentStatus` the server broadcasts passes through `AgentStateStore.broadcast`, which applies the room rule right after it. So hooks (`PreToolUse`, `Stop`, `Notification idle_prompt`, …), the transcript fallback (`tool_use`, `turn_duration`) and the timers all move the agent the same way, and the room can never disagree with the status.

## Meeting: chosen by a client

### `setAgentRoom` (client → server)

```json
{ "type": "setAgentRoom", "id": 3, "room": "meeting" }
```

- `room: "meeting"`: the agent goes to the meeting and **stays there**. Activity no longer moves it (`agentStatus` keeps flowing as usual) until a client sends `setAgentRoom` with `work` or `rest`, or the agent closes.
- `room: "work"` / `"rest"`: releases the meeting and hands the room back to activity, recomputed at once from the last `agentStatus`. So the agent lands in the chosen room when it matches what it is doing; otherwise the activity's room wins (a working agent sent to `rest` lands in `work`, and goes to `rest` at its next Stop). At most one `agentRoom` goes out, for the final room.
- Unknown agent id, a room that is not one of the three, or a malformed message: ignored. No throw, no reply.
- Privileged sockets only, like every client message. A read-only client is sent `agentRoom` with the agent's current room, so a UI that moved the character optimistically puts it back.
- One agent per message. To move a group (e.g. a team) to the meeting, send one `setAgentRoom` per agent.

## `agentRoom` (server → client)

Broadcast to every client (privileged or not: a room carries no user text) **only when** the agent's room changes.

```json
{ "type": "agentRoom", "id": 3, "room": "rest" }
```

Two Stops in a row send one `agentRoom`. An activity `agentRoom` is sent right after the `agentStatus` that caused it.

## Snapshots on connect / create

- `agentCreated.room`: the new agent's room (`rest` for a fresh agent).
- `existingAgents.rooms`: `{ [agentId]: AgentRoom }`, **every** agent listed (default `rest`).

The reconnect resend (`agentStatus` etc. after `layoutLoaded`) does not move anyone: the snapshot already says where each agent is.

## Persistence

The room is **not persisted**. It is derived from activity, and a meeting is ephemeral: after a server restart, restored agents start in `rest` until their next event, and a meeting hold is lost. `PersistedAgent` is unchanged, so older state files restore as before.

## UI side

The Front (F2.3) draws the rooms and moves the characters between them. The server only says who is in which room.
