import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentHistoryRequestFrom,
  buildAgentHistory,
  entriesFromTranscriptLines,
  entriesFromTranscriptRecord,
  historyGroupOf,
  historyPage,
  readTranscriptTail,
  recordTimestamp,
  type ToolStatusFormatter,
} from '../src/agentHistory.js';
import { appendHistoryEntry } from '../src/agentHistoryLog.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import {
  HISTORY_ACTION_MAX,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_LIMIT_MAX,
  HISTORY_TEXT_MAX,
} from '../src/constants.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { agyProvider } from '../src/providers/hook/agy/agy.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';
import { PRIVILEGED_BROADCAST_TYPES } from '../src/usageLimits.js';

const claudeFormat: ToolStatusFormatter = (name, input) =>
  claudeProvider.formatToolStatus(name, input);
const formatterFor = () => claudeFormat;
const codePoints = (s: string) => Array.from(s).length;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function testAgent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    sessionId: 'sess-1',
    projectDir: tmpDir,
    jsonlFile: '',
    isExternal: true,
    ...overrides,
  });
}

function writeTranscript(name: string, records: unknown[]): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** A small solo session: prompt, tool, result, reply, plus noise to skip. */
const SOLO_RECORDS = [
  { type: 'system', subtype: 'init', timestamp: at(0) },
  { type: 'user', timestamp: at(1), message: { content: 'Fix the login test' } },
  {
    type: 'user',
    isMeta: true,
    timestamp: at(1),
    message: { content: 'meta reminder' },
  },
  {
    type: 'user',
    timestamp: at(1),
    message: { content: '<command-name>/clear</command-name>' },
  },
  {
    type: 'assistant',
    timestamp: at(2),
    message: {
      content: [
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/auth.ts' } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: at(3),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] },
  },
  {
    type: 'assistant',
    isSidechain: true,
    timestamp: at(3),
    message: { content: [{ type: 'text', text: 'sub-agent chatter' }] },
  },
  {
    type: 'assistant',
    timestamp: at(4),
    message: { content: [{ type: 'text', text: 'Fixed it.' }] },
  },
];

describe('entriesFromTranscriptRecord / entriesFromTranscriptLines', () => {
  it('extracts user → assistant speech and actions in chronological order', () => {
    const lines = SOLO_RECORDS.map((r) => JSON.stringify(r));
    const entries = entriesFromTranscriptLines(lines, 0, { formatToolStatus: claudeFormat });
    expect(entries).toEqual([
      { ts: T0 + 1000, kind: 'speech', role: 'user', text: 'Fix the login test' },
      { ts: T0 + 2000, kind: 'speech', role: 'assistant', text: 'Looking at it.' },
      {
        ts: T0 + 2000,
        kind: 'action',
        text: claudeProvider.formatToolStatus('Read', { file_path: '/src/auth.ts' }),
        toolName: 'Read',
      },
      { ts: T0 + 4000, kind: 'speech', role: 'assistant', text: 'Fixed it.' },
    ]);
  });

  it('cuts speech at 500 and actions at 120 code points, Unicode-safe', () => {
    const speech = entriesFromTranscriptRecord(
      { type: 'user', message: { content: '😀'.repeat(HISTORY_TEXT_MAX + 10) } },
      1,
      { formatToolStatus: claudeFormat },
    );
    expect(codePoints(speech[0].text)).toBe(HISTORY_TEXT_MAX);
    expect(speech[0].text).toBe('😀'.repeat(HISTORY_TEXT_MAX - 1) + '…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(speech[0].text)).toBe(false);

    const exact = entriesFromTranscriptRecord(
      { type: 'user', message: { content: 'ç'.repeat(HISTORY_TEXT_MAX) } },
      1,
      { formatToolStatus: claudeFormat },
    );
    expect(exact[0].text).toBe('ç'.repeat(HISTORY_TEXT_MAX));

    const action = entriesFromTranscriptRecord(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
      },
      1,
      { formatToolStatus: () => 'ação '.repeat(100) },
    );
    expect(codePoints(action[0].text)).toBe(HISTORY_ACTION_MAX);
    expect(action[0].text.endsWith('…')).toBe(true);
    expect(action[0].toolName).toBe('Bash');
  });

  it('reads sidechains only when asked (a Teammate own transcript)', () => {
    const rec = {
      type: 'assistant',
      isSidechain: true,
      agentName: 'tester',
      message: { content: [{ type: 'text', text: 'hi from teammate' }] },
    };
    expect(entriesFromTranscriptRecord(rec, 1, { formatToolStatus: claudeFormat })).toEqual([]);
    expect(
      entriesFromTranscriptRecord(rec, 1, {
        formatToolStatus: claudeFormat,
        includeSidechain: true,
      }),
    ).toEqual([
      { ts: 1, kind: 'speech', role: 'assistant', text: 'hi from teammate', agentName: 'tester' },
    ]);
  });

  it('a record without a time takes the previous one, else the fallback', () => {
    const lines = [
      { type: 'user', message: { content: 'first' } },
      { type: 'user', timestamp: at(5), message: { content: 'second' } },
      { type: 'user', message: { content: 'third' } },
      'not json',
    ].map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
    const entries = entriesFromTranscriptLines(lines, 42, { formatToolStatus: claudeFormat });
    expect(entries.map((e) => e.ts)).toEqual([42, T0 + 5000, T0 + 5000]);
  });

  it('recordTimestamp reads ISO strings and numbers', () => {
    expect(recordTimestamp({ timestamp: at(0) })).toBe(T0);
    expect(recordTimestamp({ ts: 1234 })).toBe(1234);
    expect(recordTimestamp({ timestamp: 'nope' })).toBeUndefined();
    expect(recordTimestamp({})).toBeUndefined();
  });
});

describe('pagination', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ ts: (i + 1) * 10 }));

  it('limit takes the newest, oldest first, with more', () => {
    const page = historyPage(entries, { limit: 3 });
    expect(page.entries.map((e) => e.ts)).toEqual([80, 90, 100]);
    expect(page.more).toBe(true);
    expect(historyPage(entries, { limit: 10 }).more).toBe(false);
  });

  it('before is an exclusive upper bound', () => {
    const page = historyPage(entries, { before: 40, limit: 2 });
    expect(page.entries.map((e) => e.ts)).toEqual([20, 30]);
    expect(page.more).toBe(true);
    const last = historyPage(entries, { before: 20, limit: 5 });
    expect(last.entries.map((e) => e.ts)).toEqual([10]);
    expect(last.more).toBe(false);
  });

  it('a cut source always says more', () => {
    expect(historyPage(entries, { limit: 50 }, true).more).toBe(true);
  });

  it('validates the request', () => {
    expect(agentHistoryRequestFrom({ id: 3 })).toEqual({ id: 3, limit: HISTORY_DEFAULT_LIMIT });
    expect(agentHistoryRequestFrom({ id: 3, limit: 500, before: 99 })).toEqual({
      id: 3,
      limit: 500,
      before: 99,
    });
    expect(agentHistoryRequestFrom({ id: '3' })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 1.5 })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 3, limit: 0 })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 3, limit: HISTORY_LIMIT_MAX + 1 })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 3, limit: 2.5 })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 3, before: -1 })).toBeNull();
    expect(agentHistoryRequestFrom({ id: 3, before: 'x' })).toBeNull();
  });

  it('pages a real transcript through buildAgentHistory', async () => {
    const store = new AgentStateStore();
    const file = writeTranscript('sess-1.jsonl', SOLO_RECORDS);
    store.set(1, testAgent({ jsonlFile: file }));
    const first = await buildAgentHistory(store, { id: 1, limit: 2 }, formatterFor);
    expect(first.entries.map((e) => e.text)).toEqual([
      claudeProvider.formatToolStatus('Read', { file_path: '/src/auth.ts' }),
      'Fixed it.',
    ]);
    expect(first.more).toBe(true);
    const older = await buildAgentHistory(
      store,
      { id: 1, limit: 2, before: first.entries[0].ts },
      formatterFor,
    );
    expect(older.entries.map((e) => e.text)).toEqual(['Fix the login test']);
    expect(older.more).toBeUndefined();
  });
});

describe('big transcripts', () => {
  it('reads only the tail and says more', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      type: 'user',
      timestamp: at(i),
      message: { content: `prompt ${i}` },
    }));
    const file = writeTranscript('big.jsonl', records);
    const byRecords = await readTranscriptTail(file, 10 * 1024 * 1024, 10);
    expect(byRecords?.truncated).toBe(true);
    expect(byRecords?.lines).toHaveLength(10);
    expect(JSON.parse(byRecords!.lines[9]).message.content).toBe('prompt 49');

    const bytes = await readTranscriptTail(file, 500, 5000);
    expect(bytes?.truncated).toBe(true);
    // Every kept line is whole (the partial first one is dropped).
    for (const line of bytes!.lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(bytes!.lines.at(-1)!).message.content).toBe('prompt 49');

    const whole = await readTranscriptTail(file);
    expect(whole?.truncated).toBe(false);
    expect(whole?.lines).toHaveLength(50);
  });

  it('a missing transcript is unreadable, not a throw', async () => {
    expect(await readTranscriptTail(path.join(tmpDir, 'nope.jsonl'))).toBeUndefined();
  });
});

describe('buildAgentHistory', () => {
  it('unknown agent → empty entries with a reason', async () => {
    const store = new AgentStateStore();
    expect(await buildAgentHistory(store, { id: 7 }, formatterFor)).toEqual({
      type: 'agentHistory',
      id: 7,
      entries: [],
      reason: 'unknown-agent',
    });
  });

  it('invalid request → empty entries with a reason, no throw', async () => {
    const store = new AgentStateStore();
    store.set(1, testAgent());
    expect(await buildAgentHistory(store, { id: 1, limit: 9999 }, formatterFor)).toMatchObject({
      id: 1,
      entries: [],
      reason: 'invalid-request',
    });
    expect(await buildAgentHistory(store, { id: 'x' }, formatterFor)).toMatchObject({
      id: -1,
      reason: 'invalid-request',
    });
  });

  it('a solo agent has no shared flag and no group', async () => {
    const store = new AgentStateStore();
    store.set(1, testAgent({ jsonlFile: writeTranscript('sess-1.jsonl', SOLO_RECORDS) }));
    const history = await buildAgentHistory(store, { id: 1 }, formatterFor);
    expect(history.sessionId).toBe('sess-1');
    expect(history.group).toBeUndefined();
    expect(history.entries).toHaveLength(4);
    for (const e of history.entries) {
      expect(e.shared).toBeUndefined();
      expect(e.authorAgentId).toBeUndefined();
    }
  });

  describe('group (lead + teammate sharing the session)', () => {
    function teamStore(): AgentStateStore {
      const store = new AgentStateStore();
      const leadFile = writeTranscript('lead.jsonl', [
        { type: 'user', timestamp: at(1), message: { content: 'Build the calculator' } },
        {
          type: 'assistant',
          timestamp: at(2),
          message: {
            content: [
              { type: 'text', text: 'Spawning a tester.' },
              { type: 'tool_use', id: 's1', name: 'Agent', input: { name: 'tester' } },
            ],
          },
        },
        {
          type: 'assistant',
          timestamp: at(3),
          agentName: 'tester',
          message: { content: [{ type: 'text', text: 'Tests pass.' }] },
        },
      ]);
      store.set(
        1,
        testAgent({ id: 1, jsonlFile: leadFile, isTeamLead: true, teamName: 'calc-team' }),
      );
      // Inline Teammate: shares the Lead's session id and transcript.
      store.set(
        2,
        testAgent({
          id: 2,
          jsonlFile: leadFile,
          leadAgentId: 1,
          teamName: 'calc-team',
          agentName: 'tester',
        }),
      );
      // A solo agent elsewhere is not a member.
      store.set(3, testAgent({ id: 3, sessionId: 'other' }));
      return store;
    }

    it('lists both members and marks every entry shared', async () => {
      const store = teamStore();
      for (const id of [1, 2]) {
        const history = await buildAgentHistory(store, { id }, formatterFor);
        expect(history.group).toEqual({
          teamName: 'calc-team',
          leadAgentId: 1,
          memberAgentIds: [1, 2],
        });
        expect(history.entries).toHaveLength(4);
        for (const e of history.entries) {
          expect(e.shared).toBe(true);
          expect(e.teamName).toBe('calc-team');
        }
        // Main chain → the Lead; a record tagged with a member's name → that member.
        expect(history.entries.map((e) => e.authorAgentId)).toEqual([1, 1, 1, 2]);
      }
    });

    it('historyGroupOf: solo agent has none', () => {
      expect(historyGroupOf(3, teamStore())).toBeUndefined();
    });

    it('a Teammate with its own transcript gets its own entries merged in', async () => {
      const store = teamStore();
      const ownFile = writeTranscript('teammate.jsonl', [
        {
          type: 'assistant',
          isSidechain: true,
          agentName: 'tester',
          timestamp: at(2.5),
          message: {
            content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }],
          },
        },
      ]);
      store.get(2)!.jsonlFile = ownFile;
      store.get(2)!.sessionId = 'teammate-sess';
      const history = await buildAgentHistory(store, { id: 2 }, formatterFor);
      expect(history.entries.map((e) => [e.kind, e.authorAgentId])).toEqual([
        ['speech', 1],
        ['speech', 1],
        ['action', 1],
        ['action', 2],
        ['speech', 2],
      ]);
      expect(history.entries[3]).toMatchObject({ toolName: 'Bash', shared: true });
    });
  });
});

describe('hooks-only buffer', () => {
  it('is empty when no event ever came', async () => {
    const store = new AgentStateStore();
    store.set(1, testAgent({ hooksOnly: true, providerId: 'agy' }));
    const history = await buildAgentHistory(store, { id: 1 }, formatterFor);
    expect(history.entries).toEqual([]);
    expect(history.reason).toBeUndefined();
  });

  it('keeps the actions hooks reported during the session', async () => {
    const store = new AgentStateStore();
    store.set(2, testAgent({ id: 2, sessionId: 'agy-1', hooksOnly: true, providerId: 'agy' }));
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      agyProvider,
      new SessionRouter(),
    );
    handler.registerAgent('agy-1', 2);
    const input = { CommandLine: 'npm test' };
    handler.handleEvent('agy', {
      hook_event_name: 'PreToolUse',
      session_id: 'agy-1',
      tool_name: 'run_command',
      tool_input: input,
    });
    handler.handleEvent('agy', {
      hook_event_name: 'PostToolUse',
      session_id: 'agy-1',
      tool_name: 'run_command',
      tool_input: input,
    });
    const history = await buildAgentHistory(
      store,
      { id: 2 },
      () => (n, i) => agyProvider.formatToolStatus(n, i),
    );
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      kind: 'action',
      text: agyProvider.formatToolStatus('run_command', input),
      toolName: 'run_command',
    });
    expect(typeof history.entries[0].ts).toBe('number');
  });

  it('is capped at HISTORY_LIMIT_MAX, dropping the oldest', () => {
    const agent = testAgent({ hooksOnly: true });
    for (let i = 0; i < HISTORY_LIMIT_MAX + 5; i++) {
      appendHistoryEntry(agent, { ts: i, kind: 'action', text: `t${i}` });
    }
    expect(agent.historyLog).toHaveLength(HISTORY_LIMIT_MAX);
    expect(agent.historyLog![0].ts).toBe(5);
  });

  it('a transcript agent keeps no buffer (its file is re-read)', () => {
    const store = new AgentStateStore();
    store.set(1, testAgent({ jsonlFile: '/x.jsonl', providerId: 'claude' }));
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    handler.registerAgent('sess-1', 1);
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/a.ts' },
    });
    expect(store.get(1)!.historyLog).toBeUndefined();
  });
});

describe('requestAgentHistory over the client handler', () => {
  async function request(privileged: boolean): Promise<Array<Record<string, unknown>>> {
    const store = new AgentStateStore();
    store.set(1, testAgent({ jsonlFile: writeTranscript('sess-1.jsonl', SOLO_RECORDS) }));
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage(
      { type: 'requestAgentHistory', id: 1, limit: 10 },
      (m) => sent.push(m as Record<string, unknown>),
      { store, runtime: undefined, cache: null, privileged } as unknown as Parameters<
        typeof handleClientMessage
      >[2],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return sent;
  }

  it('answers a privileged client with its history', async () => {
    const sent = await request(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentHistory', id: 1 });
    expect((sent[0].entries as unknown[]).length).toBe(4);
  });

  it('sends a read-only client nothing', async () => {
    expect((await request(false)).filter((m) => m.type === 'agentHistory')).toEqual([]);
  });

  it('agentHistory is in the privileged-only list', () => {
    expect(PRIVILEGED_BROADCAST_TYPES.has('agentHistory')).toBe(true);
  });
});
