/**
 * Residual agents (Pixel Kaisha B2.5): characters whose session ended without
 * telling us (a killed CLI, a lost SessionEnd, an old hook script). The rule,
 * as decided: remove an agent when it has had NO EVENT for more than
 * RESIDUAL_IDLE_MS AND it has NO ACTIVE SESSION OR PROCESS. An agent whose
 * session is active is never removed, however old its last event.
 *
 * Pure: the clock and the process probe are passed in. The runtime sweeps
 * every RESIDUAL_SWEEP_INTERVAL_MS (and after a turn ends), while the server
 * runs, whether or not a client is connected.
 */

import { RESIDUAL_IDLE_MS } from './constants.js';
import type { AgentState } from './types.js';

export { RESIDUAL_IDLE_MS, RESIDUAL_SWEEP_INTERVAL_MS } from './constants.js';

export interface ResidualOptions {
  /** Is this pid a running process? */
  isProcessAlive: (pid: number) => boolean;
  /** Does the host hold a live terminal (PTY) for this agent? */
  hasLiveTerminal?: (agentId: number) => boolean;
}

/** Is a process with this pid running? EPERM means it exists (another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Does the agent still have a live session or process? On any doubt, yes.
 *
 * - Launched by us (not external) or holding a terminal: its terminal owns
 *   its lifetime.
 * - A known CLI pid decides alone: running = live, gone = over (a turn the
 *   dead process left "active" is not a session any more).
 * - No pid, hooks-only agent (old hook script, or not Linux): the turn state
 *   is all there is. A turn in progress, a tool running or a background spawn
 *   = live; a finished turn (waiting) = no known session.
 * - No pid, transcript agent: nothing tells a quiet session from a dead one,
 *   so it is kept (the stale check drops it once its transcript is gone).
 */
export function hasActiveSession(agent: AgentState, opts: ResidualOptions): boolean {
  if (!agent.isExternal) return true;
  if (agent.terminalRef || opts.hasLiveTerminal?.(agent.id)) return true;
  if (agent.processPid !== undefined) return opts.isProcessAlive(agent.processPid);
  if (!agent.hooksOnly) return true;
  return (
    agent.turnActive === true ||
    !agent.isWaiting ||
    agent.activeToolIds.size > 0 ||
    agent.backgroundSpawns.size > 0 ||
    agent.currentHookToolId !== undefined
  );
}

/**
 * Should the sweep remove this agent? Sub-agents and teammates (leadAgentId)
 * go with their lead, never on their own; an agent between SessionEnd(clear)
 * and its SessionStart has its own grace timer. `lastDataAt === 0` (never
 * stamped) is not "idle since 1970": the runtime stamps it first.
 */
export function isResidualAgent(agent: AgentState, now: number, opts: ResidualOptions): boolean {
  if (agent.leadAgentId !== undefined) return false;
  if (agent.pendingClear) return false;
  if (agent.lastDataAt <= 0) return false;
  if (now - agent.lastDataAt <= RESIDUAL_IDLE_MS) return false;
  return !hasActiveSession(agent, opts);
}
