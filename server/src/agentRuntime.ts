/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { isPersistedSpawnChild, restoredAgentInit } from './agentPersistence.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { pausedSpawnFate } from './backgroundSpawns.js';
import {
  PAUSED_SPAWN_CHECK_INTERVAL_MS,
  PROCESS_EXIT_CHECK_INTERVAL_MS,
  RESIDUAL_SWEEP_INTERVAL_MS,
} from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import { isResidualAgent, pidAlive } from './residualAgents.js';
import { SessionRouter } from './sessionRouter.js';
import { SubagentWatch } from './subagentWatch.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { isTrackedCwd } from './trackedSessionCwds.js';
import {
  endBackgroundSpawn,
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setTeamSwitchCallback,
} from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

/** What the lifecycle sweeps (B2.5) read from the world; injectable for tests. */
export interface RuntimeLifecycleOptions {
  /** The clock (ms since epoch). */
  now?: () => number;
  /** Is this pid a running process? */
  isProcessAlive?: (pid: number) => boolean;
  /** Does the host hold a live terminal (PTY) for this agent? */
  hasLiveTerminal?: (agentId: number) => boolean;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pausedSpawnTimer: ReturnType<typeof setInterval> | null = null;
  private processExitTimer: ReturnType<typeof setInterval> | null = null;
  private residualTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly hasLiveTerminal?: (agentId: number) => boolean;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  readonly subagentWatch: SubagentWatch;
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
    lifecycle: RuntimeLifecycleOptions = {},
  ) {
    this.now = lifecycle.now ?? Date.now;
    this.isProcessAlive = lifecycle.isProcessAlive ?? pidAlive;
    this.hasLiveTerminal = lifecycle.hasLiveTerminal;
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    this.subagentWatch = new SubagentWatch(store);
    setSubagentWatch(this.subagentWatch);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      // The new spawn has to survive a restart, so its completion still matches.
      this.store.persist();
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      this.subagentWatch.removeBySpawn(leadId, toolUseId);
      // Save at once, so the saved list stops naming the finished spawn. (A
      // notice written while no server was running is caught on restore
      // instead, by stillRunningSpawns reading the transcript.)
      this.store.persist();
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd, providerId) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        // Pixel Kaisha: also match by the session's cwd (the hooks project dir
        // is registered in trackedSessionCwds), not only dirname(transcript).
        const tracked =
          isTrackedProjectDir(projectDir) ||
          (!!cwd && (isTrackedCwd(cwd) || isTrackedProjectDir(cwd)));
        if (!tracked && !this.watchAllSessions.current) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
          providerId,
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => this.endSession(agentId),
      onHookSubagentStart: (parentId, key, agentType) =>
        this.addHookSubagent(parentId, key, agentType),
      onHookSubagentEnd: (parentId, key) => {
        for (const [id, a] of this.store) {
          if (a.leadAgentId === parentId && a.hookSubagentId === key) {
            this.removeTeammate(id, 'subagent-stop');
            return;
          }
        }
      },
      onTurnEnd: () => this.sweepResidualAgents(),
    });
  }

  /**
   * A session ended (SessionEnd hook, a session-is-its-process CLI that
   * exited, or a residual agent): its children go with it, its transcript is
   * dismissed, and an external agent leaves the office. The ONE end-of-session
   * path; agents we launched leave with their terminal instead.
   */
  private endSession(agentId: number): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Covers real team leads, leads of background teammates (which have
    // children but no teamName) and hook sub-agents (Codex). No-op when childless.
    this.removeTeammates(agentId);
    // Unnamed background spawns die with their lead's session too.
    this.subagentWatch.removeByLead(agentId);
    if (agent.isExternal) {
      this.unregisterAgent(agent.sessionId);
      this.removeAgent(agentId);
    }
  }

  /**
   * A sub-agent a provider without a TeamProvider announced by hook (Codex
   * SubagentStart): its own character, tied to its parent (parentAgentId on
   * agentCreated), wearing the parent's look. It shares the parent's session
   * (spawnToolUseId set, so removing it never unregisters that session) and
   * is never persisted. Leaves on its SubagentStop or with its parent.
   */
  private addHookSubagent(parentId: number, key: string, agentType: string): void {
    const parent = this.store.get(parentId);
    if (!parent) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === parentId && a.hookSubagentId === key) return;
    }
    const id = this.store.nextAgentId.current++;
    const child = createAgentState({
      id,
      sessionId: parent.sessionId,
      isExternal: true,
      projectDir: parent.projectDir,
      jsonlFile: '',
      hooksOnly: true,
      hookDelivered: true,
      lastDataAt: this.now(),
      providerId: parent.providerId,
      directoryName: parent.directoryName,
      leadAgentId: parentId,
      agentName: agentType,
      spawnToolUseId: `hook-subagent:${key}`,
      hookSubagentId: key,
      processPid: parent.processPid,
      turnActive: true,
    });
    if (parent.palette !== undefined) {
      child.palette = parent.palette;
      child.repeat = parent.repeat ?? 0;
    } else {
      assignPaletteIfNeeded(child, this.store);
    }
    this.store.set(id, child);
    console.log(
      `[Pixel Agents] Hook sub-agent "${agentType}" (Agent ${id}) for parent Agent ${parentId}`,
    );
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Register every hook provider the server accepts events from, so each
   *  event is normalized by the provider named in its route. */
  setHookProviders(providers: readonly HookProvider[]): void {
    this.hookEventHandler.setProviders(providers);
  }

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    this.stopWatching(id);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Stop an agent's watchers and timers, leaving it in the store. */
  private stopWatching(id: number): void {
    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /**
   * Close an agent the user (or its process) ended: its Teammates and watched
   * Sub-agents go with it, and its transcript is dismissed so no scanner
   * re-adopts it. Children first — once the Lead is gone, nothing can find
   * them (a later sessionEnd resolves no agent).
   */
  closeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.removeTeammates(id);
    this.subagentWatch.removeByLead(id);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.removeAgent(id);
  }

  // ── Lifecycle sweeps (Pixel Kaisha B2.5) ──

  /**
   * Run the lifecycle sweeps while the server runs, client or not: exited
   * session-is-its-process CLIs (agy) every PROCESS_EXIT_CHECK_INTERVAL_MS,
   * residual agents every RESIDUAL_SWEEP_INTERVAL_MS.
   */
  startLifecycleSweep(): void {
    if (this.processExitTimer) return;
    this.processExitTimer = setInterval(
      () => this.endExitedSessions(),
      PROCESS_EXIT_CHECK_INTERVAL_MS,
    );
    this.residualTimer = setInterval(() => this.sweepResidualAgents(), RESIDUAL_SWEEP_INTERVAL_MS);
    this.processExitTimer.unref?.();
    this.residualTimer.unref?.();
  }

  /**
   * End the session of every agent whose CLI has no session-end hook
   * (`sessionEndsWithProcess`) once the pid it reported is gone: the provider
   * is fed a synthetic SessionEnd, so the end takes the normal hook path
   * (normalize → handleSessionEnd → onSessionEnd).
   */
  endExitedSessions(): void {
    const ended: AgentState[] = [];
    for (const agent of this.store.values()) {
      if (agent.processPid === undefined || agent.leadAgentId !== undefined) continue;
      if (!agent.providerId || !agent.sessionId) continue;
      if (!this.hookEventHandler.providerFor(agent.providerId).sessionEndsWithProcess) continue;
      if (!this.isProcessAlive(agent.processPid)) ended.push(agent);
    }
    for (const agent of ended) {
      console.log(
        `[Pixel Agents] Agent ${agent.id}: ${agent.providerId} process ${agent.processPid} exited, ending session`,
      );
      this.handleHookEvent(agent.providerId!, {
        hook_event_name: 'SessionEnd',
        session_id: agent.sessionId,
        reason: 'process_exit',
      });
    }
  }

  /**
   * Remove residual agents: no event for more than RESIDUAL_IDLE_MS and no
   * live session or process (residualAgents.ts). An agent never stamped
   * (`lastDataAt` 0) is stamped now instead, so it gets the full grace period.
   */
  sweepResidualAgents(now = this.now()): void {
    const residual: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.lastDataAt <= 0) {
        agent.lastDataAt = now;
        continue;
      }
      const opts = { isProcessAlive: this.isProcessAlive, hasLiveTerminal: this.hasLiveTerminal };
      if (isResidualAgent(agent, now, opts)) residual.push(id);
    }
    for (const id of residual) {
      console.log(`[Pixel Agents] Agent ${id}: residual (no event, no live session), removing`);
      this.endSession(id);
    }
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
    // Hooks or not: no hook says when a paused background agent is gone.
    this.pausedSpawnTimer = setInterval(
      () => this.endQuietPausedSpawns(),
      PAUSED_SPAWN_CHECK_INTERVAL_MS,
    );
  }

  /**
   * Judge every lead's paused background spawns (an interim notice was their
   * last word) by their own transcripts: forget the pause of one that wrote
   * again, end one that stayed quiet too long (pausedSpawnFate).
   */
  endQuietPausedSpawns(now = Date.now()): void {
    for (const [leadId, lead] of this.store) {
      let sidecars: ReturnType<NonNullable<HookProvider['team']>['discoverTeammates']> | undefined;
      for (const [toolId, spawn] of lead.backgroundSpawns) {
        if (spawn.pausedAt === undefined) continue;
        sidecars ??=
          lead.sessionId && lead.projectDir
            ? (this.provider.team?.discoverTeammates(lead.projectDir, lead.sessionId) ?? [])
            : [];
        const sidecar = sidecars.find(
          (e) => (spawn.taskId && e.taskId === spawn.taskId) || e.toolUseId === toolId,
        );
        let writtenAt: number | undefined;
        try {
          if (sidecar) writtenAt = fs.statSync(sidecar.jsonlPath).mtimeMs;
        } catch {
          // Gone: as quiet as it gets.
        }
        const fate = pausedSpawnFate(spawn.pausedAt, writtenAt, now);
        if (fate === 'resumed') spawn.pausedAt = undefined;
        if (fate === 'ended') endBackgroundSpawn(leadId, lead, this.store, toolId);
      }
    }
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      if (isPersistedSpawnChild(p)) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      // The residual clock starts at the restore: a CLI still running sends
      // its next hook within the grace period (B2.5).
      const agent = createAgentState({
        ...restoredAgentInit(p),
        isExternal: true,
        lastDataAt: this.now(),
      });

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. */
  dispose(): void {
    this.stop();
    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }

  /**
   * Stop every scanner, watcher and timer, leaving the agents (and the saved
   * list) as they are: what a server stopping for good does, so the next one
   * restores whoever is still running. Agents whose processes end with the
   * server were already closed by their own exits.
   */
  stop(): void {
    this.hookEventHandler.dispose();
    this.subagentWatch.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.pausedSpawnTimer) {
      clearInterval(this.pausedSpawnTimer);
      this.pausedSpawnTimer = null;
    }
    if (this.processExitTimer) {
      clearInterval(this.processExitTimer);
      this.processExitTimer = null;
    }
    if (this.residualTimer) {
      clearInterval(this.residualTimer);
      this.residualTimer = null;
    }

    for (const id of this.store.keys()) this.stopWatching(id);
  }
}
