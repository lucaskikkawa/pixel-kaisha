import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import {
  agyProvider,
  formatAgyToolStatus,
  normalizeAgyHookEvent,
} from '../src/providers/hook/agy/agy.js';
import {
  agyHookCommand,
  agyHooksFilePath,
  agyHooksInstalled,
  installAgyHooks,
  uninstallAgyHooks,
} from '../src/providers/hook/agy/agyHooksFile.js';
import { toWireEvent } from '../src/providers/hook/agy/agyPayload.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { HOOKS_PROJECT_DIR_ENV } from '../src/providers/hook/shared/hooksScope.js';
import { hookProviderById, hookProviders } from '../src/providers/index.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

type Raw = Record<string, unknown>;
const session: Raw[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'agy', 'session.json'), 'utf8'),
);
const wire = session.map((e) => toWireEvent(e)!);

describe('agy payload translation (fixtures)', () => {
  it('turns camelCase payloads into the snake_case wire body', () => {
    expect(wire[1]).toEqual({
      session_id: '0000bbbb-1111-2222-3333-444455556666',
      hook_event_name: 'PreToolUse',
      cwd: '/sandbox',
      tool_name: 'run_command',
      tool_use_id: 'toolu_example1',
      tool_input: { CommandLine: 'python3 calc/calc.py 2 + 3' },
    });
    expect(wire[3]).toMatchObject({ termination_reason: 'NO_TOOL_CALL', fully_idle: true });
  });

  it('never forwards the user prompt or transcript paths', () => {
    for (const w of wire) {
      const text = JSON.stringify(w);
      expect(text).not.toContain('PRIVATE PROMPT TEXT');
      expect(text).not.toContain('transcript');
    }
  });

  it('uses the argv event name only as a fallback', () => {
    const { hookEventName: _drop, ...noName } = session[0];
    expect(toWireEvent(noName, 'SessionStart')?.hook_event_name).toBe('SessionStart');
    expect(toWireEvent({})).toBeNull();
  });
});

describe('agy provider normalization', () => {
  it('maps the fixture session', () => {
    expect(wire.map((w) => normalizeAgyHookEvent(w)?.event.kind)).toEqual([
      'sessionStart',
      'toolStart',
      'toolEnd',
      'turnEnd',
    ]);
    expect(normalizeAgyHookEvent(wire[3])?.event).toEqual({
      kind: 'turnEnd',
      awaitingInput: undefined,
    });
    expect(normalizeAgyHookEvent({ ...wire[3], termination_reason: 'ERROR' })?.event).toEqual({
      kind: 'turnEnd',
      awaitingInput: true,
    });
    expect(normalizeAgyHookEvent({ session_id: 's', hook_event_name: 'PreInvocation' })).toBeNull();
  });

  it('formats tool labels', () => {
    expect(formatAgyToolStatus('run_command', { CommandLine: 'ls -la' })).toBe('Running: ls -la');
    expect(formatAgyToolStatus('view_file', { AbsolutePath: '/x/calc.py' })).toBe(
      'Reading calc.py',
    );
    expect(formatAgyToolStatus('write_to_file', { TargetFile: '/x/calc.py' })).toBe(
      'Editing calc.py',
    );
    expect(formatAgyToolStatus('grep_search')).toBe('Searching');
    // Names seen live on agy 1.5.4 (no path in the forwarded args).
    expect(formatAgyToolStatus('read_file', {})).toBe('Reading file');
    expect(formatAgyToolStatus('edit_file', {})).toBe('Editing file');
  });

  it('is registered and routed by id', () => {
    expect(hookProviders.map((p) => p.id)).toContain('agy');
    expect(hookProviderById('agy')).toBe(agyProvider);
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
    handler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, _t, cwd, providerId) => {
        store.set(3, {
          id: 3,
          sessionId,
          isExternal: true,
          projectDir: cwd,
          jsonlFile: '',
          activeToolIds: new Set(),
          activeToolStatuses: new Map(),
          activeToolNames: new Map(),
          activeSubagentToolIds: new Map(),
          activeSubagentToolNames: new Map(),
          backgroundSpawns: new Map(),
          seenUnknownRecordTypes: new Set(),
          hooksOnly: true,
          providerId,
        } as unknown as AgentState);
        handler.registerAgent(sessionId, 3);
      },
    });
    handler.handleEvent('agy', wire[0] as never);
    handler.handleEvent('agy', wire[1] as never);
    expect(store.get(3)?.providerId).toBe('agy');
    expect(messages.find((m) => m.type === 'agentToolStart')?.status).toBe(
      'Running: python3 calc/calc.py 2 + 3',
    );
  });
});

describe('agy hooks.json install/uninstall', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaisha-agy-'));
    process.env[HOOKS_PROJECT_DIR_ENV] = dir;
  });
  afterEach(() => {
    delete process.env[HOOKS_PROJECT_DIR_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to install without a project directory', () => {
    delete process.env[HOOKS_PROJECT_DIR_ENV];
    expect(agyHooksFilePath()).toBeUndefined();
    expect(() => installAgyHooks()).toThrow(/project-scoped/);
  });

  it('writes one named hook with absolute commands and removes it cleanly', () => {
    const file = agyHooksFilePath()!;
    expect(file).toBe(path.join(dir, '.agents', 'hooks.json'));
    installAgyHooks();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(written)).toEqual(['pixel-kaisha']);
    expect(written['pixel-kaisha'].PreToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: agyHookCommand('PreToolUse'), timeout: 3 }],
      },
    ]);
    expect(written['pixel-kaisha'].Stop[0].command).toMatch(/^node "\/.+agy-hook\.js" Stop$/);
    expect(agyHooksInstalled()).toBe(true);
    uninstallAgyHooks();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps other named hooks and restores the original bytes', () => {
    const file = agyHooksFilePath()!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  "lint": { "PostToolUse": [] }\n}\n';
    fs.writeFileSync(file, original);
    installAgyHooks();
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([
      'lint',
      'pixel-kaisha',
    ]);
    uninstallAgyHooks();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('bundled agy-hook.js (fail-open, never denies)', () => {
  const script = path.join(__dirname, '../../dist/hooks/agy-hook.js');
  const itBuilt = it.skipIf(!fs.existsSync(script));
  const run = (stdin: string, arg = 'PreToolUse') =>
    spawnSync('node', [script, arg], { input: stdin, encoding: 'utf8', timeout: 10_000 });

  itBuilt('PreToolUse: prints nothing and exits 0 (no server running)', () => {
    const r = run(JSON.stringify(session[1]));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  itBuilt('other events: prints {} and exits 0', () => {
    const r = run(JSON.stringify(session[3]), 'Stop');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{}');
  });

  itBuilt('garbage input still exits 0 without a decision', () => {
    const r = run('not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
