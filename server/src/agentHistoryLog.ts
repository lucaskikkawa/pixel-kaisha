/**
 * The in-memory history of a hooks-only agent (Pixel Kaisha B2.2): agy and
 * Codex have no transcript the server could re-read, so the speech / action
 * changes syncAgentSummary sees are kept on the agent instead. Lost on
 * restart by design (see docs/kaisha/protocol-history.md).
 *
 * Never log the text kept here: it may be the user's prompt.
 */

import type { AgentHistoryEntry } from '../../core/src/messages.js';
import { HISTORY_LIMIT_MAX } from './constants.js';
import type { AgentState } from './types.js';

/** Append `entry` to the agent's history buffer, dropping the oldest past HISTORY_LIMIT_MAX. */
export function appendHistoryEntry(agent: AgentState, entry: AgentHistoryEntry): void {
  const log = (agent.historyLog ??= []);
  log.push(entry);
  if (log.length > HISTORY_LIMIT_MAX) log.splice(0, log.length - HISTORY_LIMIT_MAX);
}
