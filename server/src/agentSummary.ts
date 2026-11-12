/**
 * Speech / action summaries for the office balloons (Pixel Kaisha B2.1).
 *
 * No model is ever called here: a summary is the newest visible text (speech)
 * or the provider's own tool label (action), squashed to one line and cut to a
 * fixed number of Unicode code points. See docs/kaisha/protocol-summary.md.
 *
 * Never log the text these functions handle: it may be the user's prompt.
 */

import { appendHistoryEntry } from './agentHistoryLog.js';
import type { AgentStateStore } from './agentStateStore.js';
import { HISTORY_ACTION_MAX, HISTORY_TEXT_MAX } from './constants.js';
import type { AgentState } from './types.js';

/** Longest speech summary, in Unicode code points (ellipsis included). */
export const SPEECH_MAX = 80;
/** Longest action summary, in Unicode code points (ellipsis included). */
export const ACTION_MAX = 60;

const ELLIPSIS = '…';

/**
 * Squash whitespace to single spaces and cut to `max` code points. A cut text
 * ends in `…` and is exactly `max` code points long. Splits on code points
 * (Array.from), so surrogate pairs (emoji) are never broken. Empty or
 * whitespace-only input gives `''`.
 */
export function truncateSummary(text: string, max: number = SPEECH_MAX): string {
  if (typeof text !== 'string') return '';
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  if (oneLine === '') return '';
  const points = Array.from(oneLine);
  if (points.length <= max) return oneLine;
  if (max <= 0) return '';
  if (max === 1) return ELLIPSIS;
  return points.slice(0, max - 1).join('') + ELLIPSIS;
}

/** Speech summary of a user prompt or assistant reply. */
export function speechFromUserOrAssistant(text: string): string {
  return truncateSummary(text, SPEECH_MAX);
}

/** Action summary of a label already produced by `HookProvider.formatToolStatus`. */
export function actionFromTool(formatToolStatusResult: string): string {
  return truncateSummary(formatToolStatusResult, ACTION_MAX);
}

/**
 * Visible text of a transcript message content: a plain string, or the `text`
 * blocks of a content array joined by spaces. Tool calls, tool results,
 * thinking and images are ignored. Returns `''` when there is no text.
 */
export function visibleTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join(' ');
}

/** CLI bookkeeping a transcript writes as a "user" message: slash-command
 *  echoes and their output. Not something the user said. */
const COMMAND_ECHO = /^<(command-[a-z-]+|local-command-[a-z-]+)>/;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Raw speech text carried by one transcript record (Claude JSONL shape:
 * `{ type: 'user' | 'assistant', message: { content } }`), or undefined when
 * the record says nothing visible: tool calls / results, system and meta
 * records, sidechains, slash-command echoes, empty blocks.
 */
export function speechFromTranscriptRecord(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const rec = record as Record<string, unknown>;
  if (rec.type !== 'user' && rec.type !== 'assistant') return undefined;
  if (rec.isMeta === true || rec.isSidechain === true) return undefined;
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content ?? rec.content;
  if (
    rec.type === 'user' &&
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result',
    )
  ) {
    return undefined;
  }
  const text = visibleTextOf(content).replace(SYSTEM_REMINDER, ' ').trim();
  if (!text || COMMAND_ECHO.test(text)) return undefined;
  return text;
}

/** The `agentSummary` wire shape: a full snapshot (both keys always present). */
export interface AgentSummarySnapshot {
  speech: string;
  /** `null` = no active tool. */
  action: string | null;
}

export function summarySnapshot(agent: AgentState): AgentSummarySnapshot {
  return { speech: agent.speech ?? '', action: agent.action ?? null };
}

/** The `agentSummary` message for an agent (full snapshot). */
export function agentSummaryMessage(id: number, agent: AgentState): Record<string, unknown> {
  return { type: 'agentSummary', id, ...summarySnapshot(agent) };
}

/** Whether the agent has anything worth putting in a snapshot. */
export function hasSummary(agent: AgentState): boolean {
  return !!agent.speech || !!agent.action;
}

/**
 * The action the agent is doing right now: the hook's current tool when a
 * hook announced one, else the newest tool still active in the transcript
 * (Map insertion order = start order). Undefined when no tool is active.
 */
export function currentAction(agent: AgentState): string | undefined {
  if (agent.hookToolStatus) return actionFromTool(agent.hookToolStatus) || undefined;
  let last: string | undefined;
  for (const status of agent.activeToolStatuses.values()) last = status;
  return last ? actionFromTool(last) || undefined : undefined;
}

/**
 * Bring `agent.speech` / `agent.action` up to date and broadcast an
 * `agentSummary` snapshot ONLY when one of them changed. `speech` is the new
 * raw text when the caller saw some (cut here); omit it to keep the current
 * speech. Action is always recomputed from the agent's tool state.
 * Returns true when a message went out.
 */
export function syncAgentSummary(
  agentId: number,
  agent: AgentState,
  agents: Pick<AgentStateStore, 'broadcast'>,
  speech?: string,
): boolean {
  let changed = false;
  if (speech !== undefined) {
    const next = speechFromUserOrAssistant(speech);
    // Empty text (whitespace-only block) never wipes the last speech.
    if (next && next !== (agent.speech ?? '')) {
      agent.speech = next;
      changed = true;
      // History (B2.2): a hooks-only agent has no transcript to re-read later.
      if (agent.hooksOnly) {
        appendHistoryEntry(agent, {
          ts: Date.now(),
          kind: 'speech',
          text: truncateSummary(speech, HISTORY_TEXT_MAX),
        });
      }
    }
  }
  const action = currentAction(agent);
  if (action !== agent.action) {
    agent.action = action;
    changed = true;
    // History (B2.2): each new tool of a hooks-only agent, with its longer label.
    if (action && agent.hooksOnly) {
      const label = agent.hookToolStatus ?? action;
      appendHistoryEntry(agent, {
        ts: Date.now(),
        kind: 'action',
        text: truncateSummary(label, HISTORY_ACTION_MAX),
        ...(agent.currentHookToolName ? { toolName: agent.currentHookToolName } : {}),
      });
    }
  }
  if (changed) agents.broadcast(agentSummaryMessage(agentId, agent));
  return changed;
}

/** `existingAgents.summaries`: only agents with a speech or an action. */
export function existingAgentSummaries(
  agents: Iterable<[number, AgentState]>,
): Record<string, AgentSummarySnapshot> {
  const out: Record<string, AgentSummarySnapshot> = {};
  for (const [id, agent] of agents) {
    if (hasSummary(agent)) out[String(id)] = summarySnapshot(agent);
  }
  return out;
}
