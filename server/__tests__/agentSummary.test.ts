import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCreatedMessage } from '../src/agentMessages.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  ACTION_MAX,
  actionFromTool,
  existingAgentSummaries,
  SPEECH_MAX,
  speechFromTranscriptRecord,
  speechFromUserOrAssistant,
  syncAgentSummary,
  truncateSummary,
} from '../src/agentSummary.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { agyProvider } from '../src/providers/hook/agy/agy.js';
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

const codePoints = (s: string) => Array.from(s).length;

describe('truncateSummary', () => {
  it('keeps text exactly at the limit without an ellipsis', () => {
    const text = 'a'.repeat(SPEECH_MAX);
    expect(truncateSummary(text)).toBe(text);
    expect(truncateSummary('b'.repeat(ACTION_MAX), ACTION_MAX)).toBe('b'.repeat(ACTION_MAX));
  });

  it('cuts text over the limit to exactly max code points ending in …', () => {
    const out = truncateSummary('x'.repeat(SPEECH_MAX + 25));
    expect(out.endsWith('…')).toBe(true);
    expect(codePoints(out)).toBe(SPEECH_MAX);
    const action = truncateSummary('y'.repeat(200), ACTION_MAX);
    expect(codePoints(action)).toBe(ACTION_MAX);
    expect(action).toBe('y'.repeat(ACTION_MAX - 1) + '…');
  });

  it('returns empty for empty or whitespace-only text', () => {
    expect(truncateSummary('')).toBe('');
    expect(truncateSummary('   \n\t  ')).toBe('');
  });

  it('squashes newlines and tabs to single spaces on one line', () => {
    expect(truncateSummary('  hello\n\n\tworld \r\n again  ')).toBe('hello world again');
  });

  it('counts emoji and accents as single code points and never splits a pair', () => {
    const emoji = '😀'.repeat(SPEECH_MAX); // each is a surrogate pair in UTF-16
    expect(truncateSummary(emoji)).toBe(emoji);
    const cut = truncateSummary('😀'.repeat(SPEECH_MAX + 1));
    expect(codePoints(cut)).toBe(SPEECH_MAX);
    expect(cut).toBe('😀'.repeat(SPEECH_MAX - 1) + '…');
    // No lone surrogate anywhere in the result.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);

    const accents = 'ação é ótima '.repeat(10);
    const out = truncateSummary(accents, 10);
    expect(out).toBe('ação é ót…');
    expect(codePoints(out)).toBe(10);
  });

  it('speech and action helpers use their own limits', () => {
    const long = 'z'.repeat(500);
    expect(codePoints(speechFromUserOrAssistant(long))).toBe(SPEECH_MAX);
    expect(codePoints(actionFromTool(long))).toBe(ACTION_MAX);
    expect(SPEECH_MAX).toBe(80);
    expect(ACTION_MAX).toBe(60);
  });
});

describe('speechFromTranscriptRecord', () => {
  it('reads user prompts and assistant text, ignoring tool traffic and meta', () => {
    expect(speechFromTranscriptRecord({ type: 'user', message: { content: 'hi there' } })).toBe(
      'hi there',
    );
    expect(
      speechFromTranscriptRecord({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'secret' },
            { type: 'text', text: 'Done.' },
            { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } },
          ],
        },
      }),
    ).toBe('Done.');
    expect(
      speechFromTranscriptRecord({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] },
      }),
    ).toBeUndefined();
    expect(
      speechFromTranscriptRecord({ type: 'user', isMeta: true, message: { content: 'x' } }),
    ).toBeUndefined();
    expect(
      speechFromTranscriptRecord({
        type: 'user',
        message: { content: '<command-name>/clear</command-name>' },
      }),
    ).toBeUndefined();
    expect(speechFromTranscriptRecord({ type: 'system', content: 'x' })).toBeUndefined();
    expect(
      speechFromTranscriptRecord({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '  ' }] },
      }),
    ).toBeUndefined();
  });
});

describe('syncAgentSummary', () => {
  it('broadcasts a full snapshot only when speech or action change', () => {
    const agent = testAgent();
    const broadcast = vi.fn();
    expect(syncAgentSummary(1, agent, { broadcast }, 'hello')).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'agentSummary',
      id: 1,
      speech: 'hello',
      action: null,
    });
    // Same speech again, same (no) action: nothing goes out.
    expect(syncAgentSummary(1, agent, { broadcast }, 'hello')).toBe(false);
    expect(syncAgentSummary(1, agent, { broadcast })).toBe(false);
    // Whitespace-only text never wipes the speech.
    expect(syncAgentSummary(1, agent, { broadcast }, '   ')).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('agentSummary via hooks (HookEventHandler)', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  let handler: HookEventHandler;
  const summaries = () => messages.filter((m) => m.type === 'agentSummary');

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

  it('tool start fills action; tool end with no active tool sends action: null', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/app.ts' },
    });
    expect(summaries()).toEqual([
      {
        type: 'agentSummary',
        id: 1,
        speech: '',
        action: actionFromTool(
          claudeProvider.formatToolStatus('Read', { file_path: '/src/app.ts' }),
        ),
      },
    ]);
    expect(agents.get(1)!.action).toBeTruthy();

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
    });
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]).toEqual({ type: 'agentSummary', id: 1, speech: '', action: null });
    expect(agents.get(1)!.action).toBeUndefined();
  });

  it('two identical tool starts do not broadcast twice', () => {
    const pre = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };
    handler.handleEvent('claude', pre);
    handler.handleEvent('claude', pre);
    expect(summaries()).toHaveLength(1);
  });

  it('Stop clears the action', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    handler.handleEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-1' });
    expect(summaries().at(-1)).toMatchObject({ action: null });
  });

  it('agy (hooks-only) gets an action but no speech', () => {
    const agyHandler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      agyProvider,
      new SessionRouter(),
    );
    agents.set(2, testAgent({ id: 2, sessionId: 'agy-1', hooksOnly: true, providerId: 'agy' }));
    agyHandler.registerAgent('agy-1', 2);
    const raw = {
      hook_event_name: 'PreToolUse',
      session_id: 'agy-1',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'npm test' },
    };
    agyHandler.handleEvent('agy', raw);
    expect(summaries().at(-1)).toEqual({
      type: 'agentSummary',
      id: 2,
      speech: '',
      action: actionFromTool(agyProvider.formatToolStatus('run_command', raw.tool_input)),
    });
  });
});

describe('agentSummary via the transcript (processTranscriptLine)', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  const summaries = () => messages.filter((m) => m.type === 'agentSummary');
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

  it('a user prompt then an assistant reply replace the speech', () => {
    line({ type: 'user', message: { content: 'Please fix the login bug' } });
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Looking at the login flow now.' }] },
    });
    expect(summaries().map((m) => m.speech)).toEqual([
      'Please fix the login bug',
      'Looking at the login flow now.',
    ]);
  });

  it('tool_use fills the action and its tool_result clears it', () => {
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    });
    expect(summaries().at(-1)).toMatchObject({
      action: actionFromTool(claudeProvider.formatToolStatus('Read', { file_path: '/a.ts' })),
    });
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    });
    expect(summaries().at(-1)).toEqual({ type: 'agentSummary', id: 1, speech: '', action: null });
  });

  it('does not repeat a value a hook already broadcast', () => {
    const handler = new HookEventHandler(
      agents,
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
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    });
    expect(summaries()).toHaveLength(1);
  });
});

describe('snapshots', () => {
  it('agentCreatedMessage includes speech/action only when present', () => {
    const empty = agentCreatedMessage(1, testAgent());
    expect('speech' in empty).toBe(false);
    expect('action' in empty).toBe(false);

    const withSpeech = agentCreatedMessage(1, testAgent({ speech: 'hi' }));
    expect(withSpeech).toMatchObject({ speech: 'hi', action: null });

    const withBoth = agentCreatedMessage(1, testAgent({ speech: 'hi', action: 'Reading a.ts' }));
    expect(withBoth).toMatchObject({ speech: 'hi', action: 'Reading a.ts' });
  });

  it('existingAgentSummaries lists only agents with a summary, keyed by id string', () => {
    const map = new Map<number, AgentState>([
      [1, testAgent({ speech: 'hello' })],
      [2, testAgent({ id: 2 })],
      [3, testAgent({ id: 3, action: 'Running: ls' })],
    ]);
    expect(existingAgentSummaries(map)).toEqual({
      '1': { speech: 'hello', action: null },
      '3': { speech: '', action: 'Running: ls' },
    });
  });

  it('existingAgents carries summaries for privileged clients only', () => {
    const store = new AgentStateStore();
    store.set(1, testAgent({ speech: 'hello', action: 'Reading a.ts' }));
    store.set(2, testAgent({ id: 2 }));
    const existing = (privileged: boolean) => {
      const sent: Array<Record<string, unknown>> = [];
      handleClientMessage(
        { type: 'webviewReady' },
        (m) => sent.push(m as Record<string, unknown>),
        {
          store,
          runtime: undefined,
          cache: null,
          privileged,
        } as unknown as Parameters<typeof handleClientMessage>[2],
      );
      return sent.find((m) => m.type === 'existingAgents');
    };
    expect(existing(true)?.summaries).toEqual({
      '1': { speech: 'hello', action: 'Reading a.ts' },
    });
    expect(existing(false)).toBeDefined();
    expect(existing(false)?.summaries).toBeUndefined();
  });

  it('agentSummary is a privileged-only broadcast', () => {
    expect(PRIVILEGED_BROADCAST_TYPES.has('agentSummary')).toBe(true);
  });
});
