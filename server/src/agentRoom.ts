/**
 * Office rooms and presence (Pixel Kaisha B2.3): work, meeting, rest.
 *
 * The room follows activity on its own: an agent at work (turn running, tool
 * running, or waiting on the user at its desk) is in `work`; an idle one
 * (turn over, nobody asked) is in `rest`; a new agent starts in `rest` until
 * its first real activity. `meeting` is chosen by a client (`setAgentRoom`)
 * and holds the agent there, activity or not, until a client moves it to
 * work or rest or the agent closes. No Scrum or ceremony logic here.
 *
 * Activity reaches this module through ONE seam: every `agentStatus` the
 * AgentStateStore broadcasts (see AgentStateStore.broadcast), so the room can
 * never disagree with the status the office was sent.
 * See docs/kaisha/protocol-rooms.md.
 */

import type { AgentActivityStatus, AgentRoom } from '../../core/src/messages.js';
import type { AgentState } from './types.js';

export type { AgentRoom };

/** Every room, in display order. */
export const AGENT_ROOMS: readonly AgentRoom[] = ['work', 'meeting', 'rest'];

/** A room activity can put an agent in (meeting is only ever chosen). */
export type ActivityRoom = Extract<AgentRoom, 'work' | 'rest'>;

/** Room of an agent with no turn seen yet, and of a restored one. */
export const DEFAULT_ROOM: ActivityRoom = 'rest';

export function isAgentRoom(value: unknown): value is AgentRoom {
  return typeof value === 'string' && (AGENT_ROOMS as readonly string[]).includes(value);
}

/**
 * The room an `agentStatus` means: active → work; waiting on the user
 * (`awaitingInput`) → work, at the desk; waiting otherwise (turn done) → rest.
 */
export function roomForActivity(
  status: AgentActivityStatus,
  awaitingInput?: boolean,
): ActivityRoom {
  if (status === 'active') return 'work';
  return awaitingInput === true ? 'work' : 'rest';
}

/** The room the agent is in now (`rest` for a state built without one). */
export function roomOf(agent: Pick<AgentState, 'room'>): AgentRoom {
  return agent.room ?? DEFAULT_ROOM;
}

/**
 * The room the agent should be in after this activity: unchanged while a
 * client holds it in a meeting, else the room the activity means.
 */
export function nextRoom(
  agent: Pick<AgentState, 'room' | 'roomPinned'>,
  status: AgentActivityStatus,
  awaitingInput?: boolean,
): AgentRoom {
  if (agent.roomPinned) return roomOf(agent);
  return roomForActivity(status, awaitingInput);
}

/** The `agentRoom` message. */
export function agentRoomMessage(id: number, room: AgentRoom): Record<string, unknown> {
  return { type: 'agentRoom', id, room };
}

type Broadcast = (message: Record<string, unknown>) => void;

/** Set the room; broadcast `agentRoom` only when it changed. True when sent. */
function moveTo(
  agentId: number,
  agent: AgentState,
  room: AgentRoom,
  broadcast: Broadcast,
): boolean {
  if (roomOf(agent) === room) {
    agent.room = room;
    return false;
  }
  agent.room = room;
  broadcast(agentRoomMessage(agentId, room));
  return true;
}

/**
 * An activity change (an `agentStatus` the office was sent). Remembers the
 * room it means (so releasing a meeting can return to it) and moves the agent
 * there unless it is held in a meeting. Broadcasts `agentRoom` only when the
 * room changed. Returns true when a message went out.
 */
export function applyActivityRoom(
  agentId: number,
  agent: AgentState,
  status: AgentActivityStatus,
  awaitingInput: boolean | undefined,
  broadcast: Broadcast,
): boolean {
  agent.activityRoom = roomForActivity(status, awaitingInput);
  return moveTo(agentId, agent, nextRoom(agent, status, awaitingInput), broadcast);
}

/**
 * Apply an `agentStatus` message, if it is one for an agent `lookup` knows.
 * The AgentStateStore calls this on every broadcast; anything else is ignored.
 */
export function applyStatusMessageRoom(
  message: Record<string, unknown>,
  lookup: (id: number) => AgentState | undefined,
  broadcast: Broadcast,
): boolean {
  if (message.type !== 'agentStatus' || typeof message.id !== 'number') return false;
  if (message.status !== 'active' && message.status !== 'waiting') return false;
  const agent = lookup(message.id);
  if (!agent) return false;
  return applyActivityRoom(
    message.id,
    agent,
    message.status,
    message.awaitingInput === true,
    broadcast,
  );
}

/**
 * A client's `setAgentRoom`. `meeting` holds the agent there; `work` / `rest`
 * release the hold and hand the room back to activity, recomputed at once
 * from the last `agentStatus` (so it is never out of step with the status).
 * The chosen room is therefore where the agent lands when it matches its
 * activity; otherwise the activity's room wins. One `agentRoom` at most, for
 * the final room. An unknown agent or room is ignored (no throw, no reply).
 * Returns true when an `agentRoom` went out.
 */
export function setAgentRoom(
  msg: Record<string, unknown>,
  lookup: (id: number) => AgentState | undefined,
  broadcast: Broadcast,
): boolean {
  const id = msg.id;
  const room = msg.room;
  if (typeof id !== 'number' || !isAgentRoom(room)) return false;
  const agent = lookup(id);
  if (!agent) return false;
  if (room === 'meeting') {
    agent.roomPinned = true;
    return moveTo(id, agent, 'meeting', broadcast);
  }
  agent.roomPinned = false;
  return moveTo(id, agent, agent.activityRoom ?? DEFAULT_ROOM, broadcast);
}

/** `existingAgents.rooms`: every agent, keyed by id string. */
export function existingAgentRooms(
  agents: Iterable<[number, AgentState]>,
): Record<string, AgentRoom> {
  const out: Record<string, AgentRoom> = {};
  for (const [id, agent] of agents) out[String(id)] = roomOf(agent);
  return out;
}
