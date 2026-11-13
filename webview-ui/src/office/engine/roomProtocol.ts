export type AgentRoom = 'work' | 'meeting' | 'rest';

export function isAgentRoom(value: unknown): value is AgentRoom {
  return value === 'work' || value === 'meeting' || value === 'rest';
}

export function setAgentRoomMessage(id: number, room: AgentRoom) {
  return { type: 'setAgentRoom' as const, id, room };
}
