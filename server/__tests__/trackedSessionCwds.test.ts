import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { agyProvider } from '../src/providers/hook/agy/agy.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { clearTrackedCwds, isTrackedCwd, registerTrackedCwd } from '../src/trackedSessionCwds.js';

/**
 * Pixel Kaisha v0.1.1 (QA failure A): with hooks scoped to one project and
 * Watch All Sessions off, sessions started in that project must be adopted,
 * matched by the session's cwd -- not by dirname(transcript_path), which for
 * Claude is ~/.claude/projects/<slug>.
 */
describe('trackedSessionCwds', () => {
  afterEach(() => clearTrackedCwds());

  it('matches the dir itself and anything below it, not siblings', () => {
    const dir = path.join(os.tmpdir(), `pxk-sbx-${crypto.randomUUID()}`);
    registerTrackedCwd(dir);
    expect(isTrackedCwd(dir)).toBe(true);
    expect(isTrackedCwd(path.join(dir, 'qa-calc'))).toBe(true);
    expect(isTrackedCwd(dir + '-other')).toBe(false);
    expect(isTrackedCwd(path.dirname(dir))).toBe(false);
    expect(isTrackedCwd(undefined)).toBe(false);
  });
});

describe('AgentRuntime -- hooks project dir adoption (Watch All off)', () => {
  let runtime: AgentRuntime | undefined;
  let tmp: string | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    clearTrackedCwds();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function setup(): { store: AgentStateStore; sandbox: string } {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxk-adopt-'));
    const sandbox = path.join(tmp, 'sandbox');
    fs.mkdirSync(sandbox);
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.setHookProviders([claudeProvider, codexProvider, agyProvider]);
    expect(runtime.watchAllSessions.current).toBe(false);
    return { store, sandbox };
  }

  function fire(providerId: string, sessionId: string, start: Record<string, unknown>): void {
    runtime!.handleHookEvent(providerId, {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      ...start,
    });
    runtime!.handleHookEvent(providerId, { hook_event_name: 'Stop', session_id: sessionId });
  }

  /** A Claude transcript lives under ~/.claude/projects/<slug>/, never in the cwd. */
  function claudeTranscript(sessionId: string): string {
    const dir = path.join(tmp!, '.claude', 'projects', '-workspace-pixel-agents-sandbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '');
    return file;
  }

  it('claude: adopts by cwd although dirname(transcript) is ~/.claude/projects/...', () => {
    const { store, sandbox } = setup();
    registerTrackedCwd(sandbox);
    const sid = crypto.randomUUID();
    fire('claude', sid, { cwd: sandbox, transcript_path: claudeTranscript(sid) });
    expect(store.size).toBe(1);
  });

  it('claude: still drops the same session when the hooks dir is not registered', () => {
    const { store, sandbox } = setup();
    const sid = crypto.randomUUID();
    fire('claude', sid, { cwd: sandbox, transcript_path: claudeTranscript(sid) });
    expect(store.size).toBe(0);
  });

  it('codex: adopts a session whose cwd is a subfolder of the hooks dir', () => {
    const { store, sandbox } = setup();
    registerTrackedCwd(sandbox);
    fire('codex', crypto.randomUUID(), { cwd: path.join(sandbox, 'qa-calc') });
    expect(store.size).toBe(1);
    expect([...store.values()][0].providerId).toBe('codex');
  });

  it('agy: adopts a session in the hooks dir', () => {
    const { store, sandbox } = setup();
    registerTrackedCwd(sandbox);
    fire('agy', crypto.randomUUID(), { cwd: sandbox });
    expect(store.size).toBe(1);
    expect([...store.values()][0].providerId).toBe('agy');
  });

  it('codex/agy: sessions outside the hooks dir stay unadopted', () => {
    const { store, sandbox } = setup();
    registerTrackedCwd(sandbox);
    fire('codex', crypto.randomUUID(), { cwd: path.join(tmp!, 'elsewhere') });
    fire('agy', crypto.randomUUID(), { cwd: tmp! });
    expect(store.size).toBe(0);
  });
});
