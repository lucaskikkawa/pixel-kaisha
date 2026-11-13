import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCreatedMessage } from '../src/agentMessages.js';
import {
  AGENT_ROOMS,
  applyActivityRoom,
  existingAgentRooms,
  isAgentRoom,
  nextRoom,
  roomForActivity,
  setAgentRoom,
} from '../src/agentRoom.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';
import { PRIVILEGED_BROADCAST_TYPES } from '../src/usageLimits.js';

function testAgent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    sessionId: 'sess-1',
    projectDir: '/test',
    jsonlFile: '/test/sess-1.jsonl',
    isExternal: true,
    ...overrides,
  });
}

type Ctx = Parameters<typeof handleClientMessage>[2];

function ctxFor(store: AgentStateStore, privileged = true): Ctx {
  return { store, runtime: undefined, cache: null, privileged } as unknown as Ctx;
}

describe('room rules (pure)', () => {
  it('active → work; waiting on the user → work; waiting otherwise → rest', () => {
    expect(roomForActivity('active')).toBe('work');
    expect(roomForActivity('waiting', true)).toBe('work');
    expect(roomForActivity('waiting', false)).toBe('rest');
    expect(roomForActivity('waiting')).toBe('rest');
  });

  it('a pinned meeting ignores activity', () => {
    expect(nextRoom({ room: 'meeting', roomPinned: true }, 'active')).toBe('meeting');
    expect(nextRoom({ room: 'meeting', roomPinned: true }, 'waiting')).toBe('meeting');
    expect(nextRoom({ room: 'rest', roomPinned: false }, 'active')).toBe('work');
  });

  it('knows its rooms', () => {
    expect(AGENT_ROOMS).toEqual(['work', 'meeting', 'rest']);
    for (const r of AGENT_ROOMS) expect(isAgentRoom(r)).toBe(true);
    expect(isAgentRoom('kitchen')).toBe(false);
    expect(isAgentRoom(undefined)).toBe(false);
    expect(isAgentRoom(1)).toBe(false);
  });

  it('a new agent starts in rest', () => {
    const agent = testAgent();
    expect(agent.room).toBe('rest');
    expect(agent.roomPinned).toBeFalsy();
  });

  it('applyActivityRoom broadcasts only on change', () => {
    const agent = testAgent();
    const sent: Array<Record<string, unknown>> = [];
    const push = (m: Record<string, unknown>) => sent.push(m);
    expect(applyActivityRoom(1, agent, 'waiting', false, push)).toBe(false);
    expect(applyActivityRoom(1, agent, 'active', undefined, push)).toBe(true);
    expect(applyActivityRoom(1, agent, 'active', undefined, push)).toBe(false);
    expect(sent).toEqual([{ type: 'agentRoom', id: 1, room: 'work' }]);
  });
});

describe('rooms via hooks (HookEventHandler → store)', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  let handler: HookEventHandler;
  const rooms = () => messages.filter((m) => m.type === 'agentRoom');
  const statuses = () => messages.filter((m) => m.type === 'agentStatus');
  const toolStart = () =>
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
  const stop = () =>
    handler.handleEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-1' });
  const idlePrompt = () =>
    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'idle_prompt',
    });
  const send = (msg: Record<string, unknown>) =>
    handleClientMessage(msg, (m) => messages.push(m as Record<string, unknown>), ctxFor(agents));

  beforeEach(() => {
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    handler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    agents.set(1, testAgent());
    handler.registerAgent('sess-1', 1);
  });

  it('active → work, then Stop without awaitingInput → rest', () => {
    toolStart();
    expect(agents.get(1)!.room).toBe('work');
    expect(rooms()).toEqual([{ type: 'agentRoom', id: 1, room: 'work' }]);
    stop();
    expect(agents.get(1)!.room).toBe('rest');
    expect(rooms().at(-1)).toEqual({ type: 'agentRoom', id: 1, room: 'rest' });
  });

  it('agentRoom follows the agentStatus that caused it', () => {
    toolStart();
    const statusAt = messages.findIndex((m) => m.type === 'agentStatus');
    const roomAt = messages.findIndex((m) => m.type === 'agentRoom');
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(roomAt).toBeGreaterThan(statusAt);
  });

  it('waiting on the user (awaitingInput) keeps the agent at work', () => {
    toolStart();
    idlePrompt();
    expect(statuses().at(-1)).toMatchObject({ status: 'waiting', awaitingInput: true });
    expect(agents.get(1)!.room).toBe('work');
    expect(rooms()).toHaveLength(1);
  });

  it('resuming activity (tool start) from rest → work', () => {
    toolStart();
    stop();
    expect(agents.get(1)!.room).toBe('rest');
    toolStart();
    expect(agents.get(1)!.room).toBe('work');
    expect(rooms().map((m) => m.room)).toEqual(['work', 'rest', 'work']);
  });

  it('two Stops in a row send one agentRoom', () => {
    toolStart();
    stop();
    stop();
    expect(rooms().map((m) => m.room)).toEqual(['work', 'rest']);
    // agentStatus is still sent every time.
    expect(statuses().filter((m) => m.status === 'waiting')).toHaveLength(2);
  });

  it('meeting holds through tool start and Stop; agentStatus still flows', () => {
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    expect(agents.get(1)!.room).toBe('meeting');
    expect(agents.get(1)!.roomPinned).toBe(true);
    expect(rooms()).toEqual([{ type: 'agentRoom', id: 1, room: 'meeting' }]);

    toolStart();
    stop();
    idlePrompt();
    expect(agents.get(1)!.room).toBe('meeting');
    expect(rooms()).toHaveLength(1);
    expect(statuses().map((m) => m.status)).toEqual(['active', 'waiting', 'waiting']);
  });

  it('setAgentRoom work/rest releases the meeting and recomputes from activity', () => {
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    toolStart(); // working while in the meeting
    send({ type: 'setAgentRoom', id: 1, room: 'rest' });
    // Released: the agent is working, so it lands at work (one message).
    expect(agents.get(1)!.roomPinned).toBe(false);
    expect(agents.get(1)!.room).toBe('work');
    expect(rooms().map((m) => m.room)).toEqual(['meeting', 'work']);

    // Automatic again.
    stop();
    expect(agents.get(1)!.room).toBe('rest');
    expect(rooms().at(-1)).toMatchObject({ room: 'rest' });
  });

  it('setAgentRoom rest for an idle agent in a meeting → rest', () => {
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    send({ type: 'setAgentRoom', id: 1, room: 'rest' });
    expect(agents.get(1)!.room).toBe('rest');
    expect(rooms().map((m) => m.room)).toEqual(['meeting', 'rest']);
  });

  it('setAgentRoom with the current room sends nothing', () => {
    send({ type: 'setAgentRoom', id: 1, room: 'rest' });
    expect(rooms()).toHaveLength(0);
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    expect(rooms()).toHaveLength(1);
  });

  it('unknown agent, bad room or bad id does not throw and changes nothing', () => {
    expect(() => send({ type: 'setAgentRoom', id: 99, room: 'meeting' })).not.toThrow();
    expect(() => send({ type: 'setAgentRoom', id: 1, room: 'kitchen' })).not.toThrow();
    expect(() => send({ type: 'setAgentRoom', id: '1', room: 'meeting' })).not.toThrow();
    expect(() => send({ type: 'setAgentRoom' })).not.toThrow();
    expect(rooms()).toHaveLength(0);
    expect(agents.get(1)!.room).toBe('rest');
    expect(setAgentRoom({ id: 99, room: 'work' }, (id) => agents.get(id), vi.fn())).toBe(false);
  });

  it('a read-only client cannot move an agent; it gets the current room back', () => {
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage(
      { type: 'setAgentRoom', id: 1, room: 'meeting' },
      (m) => sent.push(m as Record<string, unknown>),
      ctxFor(agents, false),
    );
    expect(agents.get(1)!.room).toBe('rest');
    expect(agents.get(1)!.roomPinned).toBeFalsy();
    expect(rooms()).toHaveLength(0);
    expect(sent).toEqual([{ type: 'agentRoom', id: 1, room: 'rest' }]);
  });

  it('a closed agent takes its meeting with it', () => {
    send({ type: 'setAgentRoom', id: 1, room: 'meeting' });
    agents.delete(1);
    agents.set(1, testAgent());
    expect(agents.get(1)!.room).toBe('rest');
    expect(agents.get(1)!.roomPinned).toBeFalsy();
  });

  it('agentRoom is not privileged (every office draws the rooms)', () => {
    expect(PRIVILEGED_BROADCAST_TYPES.has('agentRoom')).toBe(false);
  });
});

describe('rooms via the transcript (heuristic mode)', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  const rooms = () => messages.filter((m) => m.type === 'agentRoom');
  const line = (record: unknown) =>
    processTranscriptLine(1, JSON.stringify(record), agents, new Map(), new Map());

  beforeEach(() => {
    vi.useFakeTimers();
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    agents.set(1, testAgent());
    return () => vi.useRealTimers();
  });

  it('tool_use → work, turn_duration → rest', () => {
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }],
      },
    });
    expect(agents.get(1)!.room).toBe('work');
    line({ type: 'system', subtype: 'turn_duration', durationMs: 10 });
    expect(agents.get(1)!.room).toBe('rest');
    expect(rooms().map((m) => m.room)).toEqual(['work', 'rest']);
  });
});

describe('snapshots', () => {
  it('agentCreated carries the room', () => {
    expect(agentCreatedMessage(1, testAgent())).toMatchObject({ room: 'rest' });
    expect(agentCreatedMessage(1, testAgent({ room: 'meeting' }))).toMatchObject({
      room: 'meeting',
    });
  });

  it('existingAgentRooms lists every agent, default rest', () => {
    const map = new Map<number, AgentState>([
      [1, testAgent({ room: 'work' })],
      [2, testAgent({ id: 2 })],
      [3, testAgent({ id: 3, room: 'meeting', roomPinned: true })],
      [4, { ...testAgent({ id: 4 }), room: undefined }],
    ]);
    expect(existingAgentRooms(map)).toEqual({
      '1': 'work',
      '2': 'rest',
      '3': 'meeting',
      '4': 'rest',
    });
  });

  it('existingAgents.rooms goes to privileged and read-only clients alike', () => {
    const store = new AgentStateStore();
    store.set(1, testAgent({ room: 'work' }));
    store.set(2, testAgent({ id: 2 }));
    for (const privileged of [true, false]) {
      const sent: Array<Record<string, unknown>> = [];
      handleClientMessage(
        { type: 'webviewReady' },
        (m) => sent.push(m as Record<string, unknown>),
        ctxFor(store, privileged),
      );
      expect(sent.find((m) => m.type === 'existingAgents')?.rooms).toEqual({
        '1': 'work',
        '2': 'rest',
      });
    }
  });

  it('agentCreated reaches the socket with its room (store agentAdded)', () => {
    const store = new AgentStateStore();
    const created: Array<Record<string, unknown>> = [];
    store.on('agentAdded', (id, agent) => created.push(agentCreatedMessage(id, agent)));
    store.set(5, testAgent({ id: 5 }));
    expect(created[0]).toMatchObject({ type: 'agentCreated', id: 5, room: 'rest' });
  });
});
