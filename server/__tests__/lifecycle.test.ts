import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentCreatedMessage } from '../src/agentMessages.js';
import { restoredAgentInit, toPersistedAgent } from '../src/agentPersistence.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { normalizeAgyHookEvent } from '../src/providers/hook/agy/agy.js';
import { toWireEvent } from '../src/providers/hook/agy/agyPayload.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { normalizeCodexHookEvent } from '../src/providers/hook/codex/codex.js';
import { CODEX_HOOK_EVENTS } from '../src/providers/hook/codex/constants.js';
import { cliProcessPid } from '../src/providers/hook/shared/cliPid.js';
import { hookProviders } from '../src/providers/index.js';
import { hasActiveSession, isResidualAgent, RESIDUAL_IDLE_MS } from '../src/residualAgents.js';
import type { AgentState } from '../src/types.js';

/**
 * Pixel Kaisha B2.5 — agent lifecycle: agy sessions end with the agy process,
 * residual agents leave after 10 min with no live session, Codex sub-agents
 * appear tied to their parent and leave with it. Fixtures only, no CLI runs;
 * the clock and the process probe are injected.
 */

type Raw = Record<string, unknown>;
const agySession: Raw[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'agy', 'session.json'), 'utf8'),
);
const agyWire = agySession.map((e) => toWireEvent(e)!);
const codexSub: Raw[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'codex', 'subagents.json'), 'utf8'),
);

const AGY_PID = 31337;

interface World {
  store: AgentStateStore;
  runtime: AgentRuntime;
  removed: number[];
  added: AgentState[];
  alive: Set<number>;
  clock: { t: number };
}

let world: World | undefined;

function makeWorld(): World {
  const store = new AgentStateStore();
  const alive = new Set<number>();
  const clock = { t: 1_800_000_000_000 };
  const runtime = new AgentRuntime(store, claudeProvider, {
    now: () => clock.t,
    isProcessAlive: (pid) => alive.has(pid),
  });
  runtime.setHookProviders(hookProviders);
  // Adopt every session (the tracked-cwd gate is tested elsewhere).
  runtime.watchAllSessions.current = true;
  const removed: number[] = [];
  const added: AgentState[] = [];
  // agentRemoved is what the server sends to every office as agentClosed.
  store.on('agentRemoved', (id) => removed.push(id));
  store.on('agentAdded', (_id, a) => added.push(a));
  world = { store, runtime, removed, added, alive, clock };
  return world;
}

afterEach(() => {
  world?.runtime.dispose();
  world = undefined;
});

function onlyAgent(store: AgentStateStore): AgentState {
  const agents = [...store.values()];
  expect(agents).toHaveLength(1);
  return agents[0];
}

// ── 1. agy SessionEnd ─────────────────────────────────────────────────────

describe('agy: the session ends with the agy process, not with a Stop', () => {
  it('normalizes SessionEnd (synthetic or agy-sent) to sessionEnd', () => {
    expect(
      normalizeAgyHookEvent({
        session_id: 's',
        hook_event_name: 'SessionEnd',
        reason: 'process_exit',
      })?.event,
    ).toEqual({ kind: 'sessionEnd', reason: 'process_exit' });
    expect(
      normalizeAgyHookEvent({ session_id: 's', hook_event_name: 'SessionEnd' })?.event,
    ).toEqual({
      kind: 'sessionEnd',
      reason: 'exit',
    });
  });

  it('a turn-ending Stop (NO_TOOL_CALL, with or without fullyIdle) is a turnEnd, never sessionEnd', () => {
    const stop = agyWire[3];
    expect(stop).toMatchObject({ termination_reason: 'NO_TOOL_CALL', fully_idle: true });
    expect(normalizeAgyHookEvent(stop)?.event.kind).toBe('turnEnd');
    expect(normalizeAgyHookEvent({ ...stop, fully_idle: false })?.event.kind).toBe('turnEnd');
    expect(
      normalizeAgyHookEvent({ ...stop, termination_reason: 'USER_CANCELED' })?.event.kind,
    ).toBe('turnEnd');
  });

  it('forwards fully_idle / termination_reason / reason but still no prompt', () => {
    const w = toWireEvent({ ...agySession[3], reason: 'exit' })!;
    expect(w).toMatchObject({
      fully_idle: true,
      termination_reason: 'NO_TOOL_CALL',
      reason: 'exit',
    });
    expect(JSON.stringify(w)).not.toContain('PRIVATE PROMPT TEXT');
  });

  function runAgySession(w: World): AgentState {
    w.alive.add(AGY_PID);
    for (const e of agyWire) w.runtime.handleHookEvent('agy', { ...e, cli_pid: AGY_PID });
    const agent = onlyAgent(w.store);
    expect(agent.providerId).toBe('agy');
    expect(agent.processPid).toBe(AGY_PID);
    return agent;
  }

  it('after the last Stop the agent stays while agy runs (an interactive session idles)', () => {
    const w = makeWorld();
    const agent = runAgySession(w);
    expect(agent.isWaiting).toBe(true);
    w.runtime.endExitedSessions();
    expect(w.store.has(agent.id)).toBe(true);
    expect(w.removed).toEqual([]);
  });

  it('agy -p exits after its Stop: the agent is closed through the SessionEnd path', () => {
    const w = makeWorld();
    const agent = runAgySession(w);
    w.alive.delete(AGY_PID);
    w.runtime.endExitedSessions();
    expect(w.store.has(agent.id)).toBe(false);
    expect(w.removed).toEqual([agent.id]);
  });

  it('only providers whose session is their process are closed on exit (Codex has SessionEnd)', () => {
    const w = makeWorld();
    w.runtime.handleHookEvent('codex', { ...codexSub[0] });
    w.runtime.handleHookEvent('codex', { ...codexSub[1] });
    const agent = onlyAgent(w.store);
    expect(agent.processPid).toBe(4242);
    w.runtime.endExitedSessions(); // 4242 is not alive
    expect(w.store.has(agent.id)).toBe(true);
  });
});

// ── 2. Residual agents ────────────────────────────────────────────────────

describe('residual agents: >10 min without events AND no live session', () => {
  function hooksOnlyAgent(w: World, over: Partial<AgentState> = {}): AgentState {
    const id = w.store.nextAgentId.current++;
    const agent = createAgentState({
      id,
      sessionId: `sess-${id}`,
      isExternal: true,
      projectDir: '/sandbox',
      jsonlFile: '',
      hooksOnly: true,
      hookDelivered: true,
      providerId: 'codex',
      isWaiting: true,
      lastDataAt: w.clock.t,
      ...over,
    });
    w.store.set(id, agent);
    return agent;
  }

  it('(i) 10 min + 1 ms without events and no process: removed (agentClosed)', () => {
    const w = makeWorld();
    const a = hooksOnlyAgent(w, { processPid: 777 }); // 777 not alive
    w.clock.t += RESIDUAL_IDLE_MS + 1;
    w.runtime.sweepResidualAgents();
    expect(w.removed).toEqual([a.id]);
  });

  it('(i) also for an agent with no pid whose turn ended (old hook script)', () => {
    const w = makeWorld();
    const a = hooksOnlyAgent(w);
    w.clock.t += RESIDUAL_IDLE_MS + 1;
    w.runtime.sweepResidualAgents();
    expect(w.removed).toEqual([a.id]);
  });

  it('(ii) 10 min without events but the process is alive: stays, however long', () => {
    const w = makeWorld();
    const a = hooksOnlyAgent(w, { processPid: 778 });
    w.alive.add(778);
    w.clock.t += RESIDUAL_IDLE_MS * 12;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(true);
  });

  it('(ii) 10 min without events but a turn / tool is active (no pid): stays', () => {
    const w = makeWorld();
    const turn = hooksOnlyAgent(w, { isWaiting: false, turnActive: true });
    const tool = hooksOnlyAgent(w, { currentHookToolId: 'hook-1' });
    const notWaiting = hooksOnlyAgent(w, { isWaiting: false });
    w.clock.t += RESIDUAL_IDLE_MS + 1;
    w.runtime.sweepResidualAgents();
    expect(w.removed).toEqual([]);
    for (const a of [turn, tool, notWaiting]) expect(w.store.has(a.id)).toBe(true);
  });

  it('(iii) 9 min 59 s without events and no process: stays', () => {
    const w = makeWorld();
    const a = hooksOnlyAgent(w, { processPid: 779 });
    w.clock.t += RESIDUAL_IDLE_MS - 1000;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(true);
    // Exactly 10 min is not "more than" 10 min either.
    w.clock.t += 1000;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(true);
    w.clock.t += 1;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(false);
  });

  it('(iv) every hook event restarts the clock (injected, no real wait)', () => {
    const w = makeWorld();
    w.runtime.handleHookEvent('codex', { ...codexSub[0], cli_pid: undefined });
    w.runtime.handleHookEvent('codex', { ...codexSub[1], cli_pid: undefined });
    const agent = onlyAgent(w.store);
    // The handler stamps with the real clock; line the fake one up with it.
    w.clock.t = agent.lastDataAt;
    w.runtime.handleHookEvent('codex', {
      hook_event_name: 'Stop',
      session_id: agent.sessionId,
    });
    expect(agent.isWaiting).toBe(true);
    w.clock.t = agent.lastDataAt + RESIDUAL_IDLE_MS;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(agent.id)).toBe(true);
    w.clock.t += 1;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(agent.id)).toBe(false);
  });

  it('a never-stamped agent (lastDataAt 0) is stamped, not swept as idle since 1970', () => {
    const w = makeWorld();
    const a = hooksOnlyAgent(w, { lastDataAt: 0 });
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(true);
    expect(a.lastDataAt).toBe(w.clock.t);
    w.clock.t += RESIDUAL_IDLE_MS + 1;
    w.runtime.sweepResidualAgents();
    expect(w.store.has(a.id)).toBe(false);
  });

  it('a residual lead takes its children along', () => {
    const w = makeWorld();
    const lead = hooksOnlyAgent(w, { processPid: 780 });
    const child = hooksOnlyAgent(w, {
      leadAgentId: lead.id,
      hookSubagentId: 'x',
      spawnToolUseId: 'hook-subagent:x',
      sessionId: lead.sessionId,
    });
    w.clock.t += RESIDUAL_IDLE_MS + 1;
    w.runtime.sweepResidualAgents();
    expect(w.removed.sort()).toEqual([lead.id, child.id].sort());
  });

  it('never residual: launched agents, terminals, children, transcript agents of unknown pid', () => {
    const base = createAgentState({
      id: 1,
      sessionId: 's',
      isExternal: true,
      projectDir: '/p',
      jsonlFile: '',
      hooksOnly: true,
      isWaiting: true,
      lastDataAt: 1,
    });
    const now = 1 + RESIDUAL_IDLE_MS + 1;
    const opts = { isProcessAlive: () => false };
    expect(isResidualAgent(base, now, opts)).toBe(true);
    expect(isResidualAgent({ ...base, isExternal: false }, now, opts)).toBe(false);
    expect(isResidualAgent(base, now, { ...opts, hasLiveTerminal: () => true })).toBe(false);
    expect(isResidualAgent({ ...base, leadAgentId: 9 }, now, opts)).toBe(false);
    expect(isResidualAgent({ ...base, pendingClear: true }, now, opts)).toBe(false);
    const transcript = { ...base, hooksOnly: false, jsonlFile: '/t.jsonl' };
    expect(hasActiveSession(transcript, opts)).toBe(true);
    expect(isResidualAgent({ ...transcript, processPid: 5 }, now, opts)).toBe(true);
  });

  it('the restore gives a 10 min grace and keeps the pid', () => {
    const agent = createAgentState({
      id: 4,
      sessionId: 's4',
      isExternal: true,
      projectDir: '/p',
      jsonlFile: '/p/s4.jsonl',
      processPid: 4321,
    });
    const persisted = toPersistedAgent(agent)!;
    expect(persisted.processPid).toBe(4321);
    expect(restoredAgentInit(persisted).processPid).toBe(4321);
  });
});

// ── 3. Codex sub-agents ───────────────────────────────────────────────────

describe('Codex sub-agents: tied to the parent, gone with it', () => {
  const childKey = codexSub[2].agent_id as string;

  it('normalizes SubagentStart / SubagentStop keyed by agent_id', () => {
    expect(normalizeCodexHookEvent(codexSub[2])?.event).toEqual({
      kind: 'subagentStart',
      parentToolId: '',
      toolId: childKey,
      toolName: 'explorer',
    });
    expect(normalizeCodexHookEvent(codexSub[4])?.event).toMatchObject({
      kind: 'subagentEnd',
      toolId: childKey,
    });
    expect(
      normalizeCodexHookEvent({ session_id: 's', hook_event_name: 'SubagentStart' }),
    ).toBeNull();
  });

  it('installs SubagentStart / SubagentStop with the other events', () => {
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStart');
    expect(CODEX_HOOK_EVENTS).toContain('SubagentStop');
  });

  function startParentAndChild(w: World): { parent: AgentState; child: AgentState } {
    for (const e of codexSub.slice(0, 3)) w.runtime.handleHookEvent('codex', { ...e });
    const parent = [...w.store.values()].find((a) => a.leadAgentId === undefined)!;
    const child = [...w.store.values()].find((a) => a.leadAgentId !== undefined)!;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    return { parent, child };
  }

  it('creates the child with parentAgentId, the parent look, and routes its tools to it', () => {
    const w = makeWorld();
    const messages: Raw[] = [];
    w.store.on('broadcast', (m) => messages.push(m));
    const { parent, child } = startParentAndChild(w);
    expect(child.leadAgentId).toBe(parent.id);
    expect(child.hookSubagentId).toBe(childKey);
    expect(child.providerId).toBe('codex');
    expect(child.palette).toBe(parent.palette);
    expect(agentCreatedMessage(child.id, child)).toMatchObject({
      parentAgentId: parent.id,
      isTeammate: true,
      teammateName: 'explorer',
      providerId: 'codex',
    });
    // Never persisted (derived from the parent's hooks).
    expect(toPersistedAgent(child)).toBeNull();
    // A repeated SubagentStart does not duplicate it.
    w.runtime.handleHookEvent('codex', { ...codexSub[2] });
    expect(w.store.size).toBe(2);

    messages.length = 0;
    w.runtime.handleHookEvent('codex', { ...codexSub[3] });
    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start?.id).toBe(child.id);
    expect(start?.status).toBe('Running: ls calc');
    // The parent's own tools still show on the parent.
    messages.length = 0;
    w.runtime.handleHookEvent('codex', { ...codexSub[1] });
    expect(messages.find((m) => m.type === 'agentToolStart')?.id).toBe(parent.id);
  });

  it('SessionEnd of the parent closes the parent AND the child', () => {
    const w = makeWorld();
    const { parent, child } = startParentAndChild(w);
    w.runtime.handleHookEvent('codex', { ...codexSub[5] });
    expect(w.removed.sort()).toEqual([parent.id, child.id].sort());
    expect(w.store.size).toBe(0);
  });

  it('SubagentStop closes only the child; the parent stays', () => {
    const w = makeWorld();
    const { parent, child } = startParentAndChild(w);
    w.runtime.handleHookEvent('codex', { ...codexSub[4] });
    expect(w.removed).toEqual([child.id]);
    expect(w.store.has(parent.id)).toBe(true);
    // The parent's session is still routed to it.
    w.runtime.handleHookEvent('codex', { ...codexSub[5] });
    expect(w.removed).toEqual([child.id, parent.id]);
  });
});

// ── The hook scripts' pid ─────────────────────────────────────────────────

describe('cliProcessPid (the CLI behind the hook script)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaisha-proc-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function proc(pid: number, comm: string, ppid: number): void {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0`);
  }

  it('skips the shell agy runs hooks through (agy -> sh -> node, seen live)', () => {
    proc(200, 'agy', 100);
    proc(300, 'sh', 200);
    expect(cliProcessPid(300, root, 'linux')).toBe(200);
    expect(cliProcessPid(200, root, 'linux')).toBe(200);
  });

  it('gives up rather than guess: not Linux, unreadable, init, shells all the way', () => {
    proc(300, 'sh', 200);
    expect(cliProcessPid(300, root, 'darwin')).toBeUndefined();
    expect(cliProcessPid(300, root, 'linux')).toBeUndefined(); // 200 unreadable
    proc(400, 'bash', 1);
    expect(cliProcessPid(400, root, 'linux')).toBeUndefined();
    proc(10, 'sh', 11);
    proc(11, 'sh', 12);
    proc(12, 'sh', 13);
    proc(13, 'sh', 14);
    proc(14, 'codex', 1);
    expect(cliProcessPid(10, root, 'linux')).toBeUndefined();
  });

  it('reads a comm holding spaces and parentheses', () => {
    proc(500, 'we(ird) x', 1);
    fs.writeFileSync(path.join(root, '500', 'stat'), '500 (we(ird) x) S 77 1 1 0');
    proc(600, 'sh', 500);
    expect(cliProcessPid(600, root, 'linux')).toBe(500);
  });

  it('the real process: this test runner is not a shell', () => {
    if (process.platform !== 'linux') return;
    expect(cliProcessPid(process.pid)).toBe(process.pid);
  });
});
