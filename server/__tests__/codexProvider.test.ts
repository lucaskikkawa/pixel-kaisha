import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  codexProvider,
  formatCodexToolStatus,
  normalizeCodexHookEvent,
} from '../src/providers/hook/codex/codex.js';
import {
  codexHookCommand,
  codexHooksFilePath,
  codexHooksInstalled,
  installCodexHooks,
  uninstallCodexHooks,
} from '../src/providers/hook/codex/codexHooksFile.js';
import { CODEX_HOOK_EVENTS } from '../src/providers/hook/codex/constants.js';
import { HOOKS_PROJECT_DIR_ENV } from '../src/providers/hook/shared/hooksScope.js';
import { hookProviderById, hookProviders } from '../src/providers/index.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

type Raw = Record<string, unknown>;
const session: Raw[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'codex', 'session.json'), 'utf8'),
);
const byEvent = (name: string): Raw => session.find((e) => e.hook_event_name === name)!;

describe('codex provider: normalization (fixtures)', () => {
  it('maps every fixture event to the expected AgentEvent kind', () => {
    const kinds = session.map((e) => normalizeCodexHookEvent(e)?.event.kind);
    expect(kinds).toEqual([
      'sessionStart',
      'toolStart',
      'permissionRequest',
      'toolEnd',
      'toolStart',
      'toolEnd',
      'turnEnd',
      'sessionEnd',
    ]);
  });

  it('sessionStart carries cwd but no transcript (hooks-only agent)', () => {
    const n = normalizeCodexHookEvent(byEvent('SessionStart'))!;
    expect(n.sessionId).toBe('0000aaaa-1111-2222-3333-444455556666');
    expect(n.event).toEqual({ kind: 'sessionStart', source: 'startup', cwd: '/sandbox/calc' });
  });

  it('toolStart keeps tool name and input, with an id derived from tool_use_id', () => {
    const n = normalizeCodexHookEvent(byEvent('PreToolUse'))!;
    expect(n.event).toMatchObject({
      kind: 'toolStart',
      toolName: 'Bash',
      toolId: 'hook-codex-call_001',
    });
  });

  it('ignores unknown events and malformed payloads', () => {
    expect(
      normalizeCodexHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's' }),
    ).toBeNull();
    expect(normalizeCodexHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    expect(normalizeCodexHookEvent({ session_id: 's' })).toBeNull();
  });

  it('formats tool status labels', () => {
    expect(formatCodexToolStatus('Bash', { command: "printf 'hi' > calc.txt" })).toBe(
      "Running: printf 'hi' > calc.txt",
    );
    expect(formatCodexToolStatus('exec_command', { cmd: ['ls', '-la'] })).toBe('Running: ls -la');
    expect(formatCodexToolStatus('apply_patch', {})).toBe('Editing files');
    expect(formatCodexToolStatus('update_plan')).toBe('Planning');
    expect(formatCodexToolStatus('mcp__docs__search')).toBe('Using mcp__docs__search');
  });

  it('is registered next to claude', () => {
    expect(hookProviders.map((p) => p.id)).toEqual(['claude', 'codex', 'agy']);
    expect(hookProviderById('codex')).toBe(codexProvider);
  });
});

describe('hook routing by providerId', () => {
  function agent(overrides: Partial<AgentState>): AgentState {
    return {
      id: 1,
      sessionId: '',
      isExternal: true,
      projectDir: '/sandbox/calc',
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundSpawns: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      hooksOnly: true,
      ...overrides,
    } as AgentState;
  }

  function setup() {
    const store = new AgentStateStore();
    const messages: Raw[] = [];
    store.on('broadcast', (m) => messages.push(m));
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    handler.setProviders(hookProviders);
    return { store, messages, handler };
  }

  it('normalizes /api/hooks/codex events with the codex provider (codex tool label)', () => {
    const { store, messages, handler } = setup();
    store.set(1, agent({ id: 1, sessionId: 'sess-codex' }));
    handler.registerAgent('sess-codex', 1);
    handler.handleEvent('codex', { ...byEvent('PreToolUse'), session_id: 'sess-codex' } as never);
    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start?.status).toBe("Running: printf 'hi' > calc.txt");
  });

  it('keeps claude events on the claude provider', () => {
    const { handler } = setup();
    expect(handler.providerFor('claude')).toBe(claudeProvider);
    expect(handler.providerFor('codex')).toBe(codexProvider);
    // Unknown ids keep the legacy default.
    expect(handler.providerFor('nope')).toBe(claudeProvider);
  });

  it('tags agents adopted from a codex session with providerId=codex', () => {
    const { store, handler } = setup();
    handler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, _t, cwd) => {
        store.set(7, agent({ id: 7, sessionId, projectDir: cwd }));
        handler.registerAgent(sessionId, 7);
      },
    });
    handler.handleEvent('codex', byEvent('SessionStart') as never);
    handler.handleEvent('codex', byEvent('PreToolUse') as never);
    expect(store.get(7)?.providerId).toBe('codex');
  });
});

describe('codex hooks.json install/uninstall (project-scoped)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaisha-codex-'));
    process.env[HOOKS_PROJECT_DIR_ENV] = dir;
  });
  afterEach(() => {
    delete process.env[HOOKS_PROJECT_DIR_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('targets <project>/.codex/hooks.json, never the home directory', () => {
    expect(codexHooksFilePath()).toBe(path.join(dir, '.codex', 'hooks.json'));
  });

  it('installs one passive handler per event and removes the file when it did not exist', () => {
    const file = codexHooksFilePath();
    installCodexHooks();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(written.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    expect(written.hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: codexHookCommand(), timeout: 3 }],
    });
    expect(codexHooksInstalled()).toBe(true);
    installCodexHooks(); // idempotent
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop).toHaveLength(1);
    uninstallCodexHooks();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(file + '.pixel-kaisha.backup')).toBe(false);
    expect(codexHooksInstalled()).toBe(false);
  });

  it('preserves foreign hooks and restores the original bytes on uninstall', () => {
    const file = codexHooksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"./lint.sh"}]}]},"x":1}\n';
    fs.writeFileSync(file, original);
    installCodexHooks();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.x).toBe(1);
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].command).toBe('./lint.sh');
    uninstallCodexHooks();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('refuses to rewrite an unparseable file', () => {
    const file = codexHooksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(() => installCodexHooks()).toThrow(/parse/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });
});
