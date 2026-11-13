/**
 * Per-agent conversation and action history (Pixel Kaisha B2.2), the content
 * the Front opens when a character is clicked. See
 * docs/kaisha/protocol-history.md.
 *
 * Sources, by agent:
 *  - an agent with a transcript: its JSONL, re-read on each request (the tail
 *    only, HISTORY_READ_MAX_BYTES / HISTORY_READ_MAX_RECORDS);
 *  - a hooks-only agent (agy, Codex): the in-memory `historyLog` that
 *    syncAgentSummary keeps (agentHistoryLog.ts), lost on restart;
 *  - a Lead or Teammate: the Lead's (shared) session, every entry marked
 *    `shared`, plus the Teammate's own transcript when it has one.
 *
 * No model is called. Speech reuses agentSummary's `speechFromTranscriptRecord`
 * and `truncateSummary`, only with a longer cut. Never log the text handled
 * here: it may be the user's prompt.
 */

import * as fs from 'fs';

import type {
  AgentHistory,
  AgentHistoryEntry,
  AgentHistoryGroup,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { speechFromTranscriptRecord, truncateSummary } from './agentSummary.js';
import {
  HISTORY_ACTION_MAX,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_LIMIT_MAX,
  HISTORY_READ_MAX_BYTES,
  HISTORY_READ_MAX_RECORDS,
  HISTORY_TEXT_MAX,
} from './constants.js';
import type { AgentState } from './types.js';

/** A provider's tool label (`HookProvider.formatToolStatus`). */
export type ToolStatusFormatter = (toolName: string, input: Record<string, unknown>) => string;

/** An entry as read from a transcript, before team attribution. */
export interface TranscriptHistoryEntry extends AgentHistoryEntry {
  /** The record's `agentName` tag (team sessions), to find its author. */
  agentName?: string;
}

export interface TranscriptHistoryOptions {
  formatToolStatus: ToolStatusFormatter;
  /** Read sidechain records too: a Teammate's own transcript is sidechain
   *  top to bottom. Off for a Lead's or solo agent's transcript, where a
   *  sidechain is a Sub-agent's turn, not this agent's. */
  includeSidechain?: boolean;
}

/** The record's own time in epoch ms (`timestamp` ISO string or number, or
 *  `ts`), or undefined when it has none. */
export function recordTimestamp(record: Record<string, unknown>): number | undefined {
  for (const value of [record.timestamp, record.ts]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

/**
 * The history entries one transcript record carries, in order: its speech
 * (user prompt or assistant visible text, cut at HISTORY_TEXT_MAX) then one
 * action per `tool_use` (the provider's label cut at HISTORY_ACTION_MAX).
 * Skips everything speechFromTranscriptRecord skips (system, meta, tool
 * results, slash-command echoes) and, unless `includeSidechain`, sidechains.
 */
export function entriesFromTranscriptRecord(
  record: unknown,
  ts: number,
  opts: TranscriptHistoryOptions,
): TranscriptHistoryEntry[] {
  if (!record || typeof record !== 'object') return [];
  let rec = record as Record<string, unknown>;
  if (rec.type !== 'user' && rec.type !== 'assistant') return [];
  if (rec.isMeta === true) return [];
  if (rec.isSidechain === true) {
    if (!opts.includeSidechain) return [];
    rec = { ...rec, isSidechain: false };
  }
  const agentName = typeof rec.agentName === 'string' ? { agentName: rec.agentName } : {};
  const out: TranscriptHistoryEntry[] = [];
  const speech = speechFromTranscriptRecord(rec);
  if (speech !== undefined) {
    const text = truncateSummary(speech, HISTORY_TEXT_MAX);
    if (text)
      out.push({ ts, kind: 'speech', text, role: rec.type as 'user' | 'assistant', ...agentName });
  }
  if (rec.type === 'assistant') {
    const message = rec.message as { content?: unknown } | undefined;
    const content = message?.content ?? rec.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; name?: unknown; input?: unknown };
        if (b.type !== 'tool_use') continue;
        const toolName = typeof b.name === 'string' ? b.name : '';
        const input =
          b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
        const text = truncateSummary(opts.formatToolStatus(toolName, input), HISTORY_ACTION_MAX);
        if (!text) continue;
        out.push({
          ts,
          kind: 'action',
          text,
          ...(toolName ? { toolName } : {}),
          ...agentName,
        });
      }
    }
  }
  return out;
}

/**
 * Every entry of a transcript's lines, oldest first. A record without a time
 * of its own takes the previous record's (else `fallbackTs`, the file's
 * mtime), so file order is kept and paging by `before` stays stable.
 * Malformed lines are skipped.
 */
export function entriesFromTranscriptLines(
  lines: readonly string[],
  fallbackTs: number,
  opts: TranscriptHistoryOptions,
): TranscriptHistoryEntry[] {
  const out: TranscriptHistoryEntry[] = [];
  let lastTs: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const ts = recordTimestamp(record as Record<string, unknown>) ?? lastTs ?? fallbackTs;
    lastTs = ts;
    out.push(...entriesFromTranscriptRecord(record, ts, opts));
  }
  return out;
}

/** A transcript's newest lines, and whether older ones were left unread. */
export interface TranscriptTail {
  lines: string[];
  /** True when the file holds more than was read (bytes or record cap). */
  truncated: boolean;
  mtimeMs: number;
}

/**
 * Read at most the last `maxBytes` of a transcript, and of those at most the
 * last `maxRecords` lines, without blocking the event loop. A cut through the
 * middle of a line drops that partial line. Undefined when unreadable.
 */
export async function readTranscriptTail(
  file: string,
  maxBytes: number = HISTORY_READ_MAX_BYTES,
  maxRecords: number = HISTORY_READ_MAX_RECORDS,
): Promise<TranscriptTail | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let lines = buffer.subarray(0, read).toString('utf-8').split('\n');
    let truncated = start > 0;
    // The first line starts mid-record when the read began past byte 0.
    if (truncated) lines = lines.slice(1);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > maxRecords) {
      lines = lines.slice(lines.length - maxRecords);
      truncated = true;
    }
    return { lines, truncated, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A `requestAgentHistory`, checked. */
export interface AgentHistoryRequest {
  id: number;
  before?: number;
  limit: number;
}

/** A `requestAgentHistory` request, or null when malformed: `id` not an
 *  integer, `limit` not an integer in 1..HISTORY_LIMIT_MAX, `before` not a
 *  positive integer. */
export function agentHistoryRequestFrom(msg: {
  id?: unknown;
  before?: unknown;
  limit?: unknown;
}): AgentHistoryRequest | null {
  const { id, before, limit } = msg;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > HISTORY_LIMIT_MAX)
  ) {
    return null;
  }
  if (
    before !== undefined &&
    (typeof before !== 'number' || !Number.isInteger(before) || before <= 0)
  ) {
    return null;
  }
  return {
    id,
    ...(before !== undefined ? { before } : {}),
    limit: (limit as number | undefined) ?? HISTORY_DEFAULT_LIMIT,
  };
}

/**
 * One page of chronological `entries`: those with `ts < before` (all when
 * unset), the newest `limit` of them, oldest first. `more`: older entries
 * exist past the page, or the source itself was cut (`sourceTruncated`).
 */
export function historyPage<T extends { ts: number }>(
  entries: readonly T[],
  { before, limit }: { before?: number; limit: number },
  sourceTruncated = false,
): { entries: T[]; more: boolean } {
  const eligible = before === undefined ? entries : entries.filter((e) => e.ts < before);
  const page = eligible.slice(Math.max(0, eligible.length - limit));
  return { entries: page, more: eligible.length > page.length || sourceTruncated };
}

/** The team session an agent belongs to, as the history needs it. */
export interface HistoryGroup extends AgentHistoryGroup {
  /** The Lead in the office, when it is there. */
  lead?: AgentState;
}

function inTeam(agent: AgentState): boolean {
  return agent.isTeamLead === true || agent.leadAgentId !== undefined || !!agent.teamName;
}

/**
 * The agent's team session, or undefined for a solo agent. The Lead: the
 * agent's `leadAgentId`, the agent itself when it is a Lead, else its team's
 * Lead in the office. Members: the agents now in the office sharing its
 * `teamName`, its Lead, or its Lead's session id (the agent itself always).
 */
export function historyGroupOf(id: number, store: AgentStateStore): HistoryGroup | undefined {
  const agent = store.get(id);
  if (!agent || !inTeam(agent)) return undefined;
  let leadAgentId: number | undefined;
  if (agent.leadAgentId !== undefined && store.get(agent.leadAgentId)) {
    leadAgentId = agent.leadAgentId;
  } else if (agent.isTeamLead) {
    leadAgentId = id;
  } else if (agent.teamName) {
    for (const [otherId, other] of store) {
      if (other.isTeamLead && other.teamName === agent.teamName) {
        leadAgentId = otherId;
        break;
      }
    }
  }
  const lead = leadAgentId !== undefined ? store.get(leadAgentId) : undefined;
  const teamName = agent.teamName ?? lead?.teamName;
  const members = new Set<number>([id]);
  for (const [otherId, other] of store) {
    if (
      otherId === leadAgentId ||
      (leadAgentId !== undefined && other.leadAgentId === leadAgentId) ||
      (!!teamName && other.teamName === teamName) ||
      (!!lead?.sessionId && other.sessionId === lead.sessionId)
    ) {
      members.add(otherId);
    }
  }
  return {
    ...(teamName ? { teamName } : {}),
    ...(leadAgentId !== undefined ? { leadAgentId } : {}),
    memberAgentIds: [...members].sort((a, b) => a - b),
    lead,
  };
}

/** An agent's own entries: its transcript's tail, else its hooks-only buffer. */
async function ownEntries(
  agent: AgentState,
  opts: TranscriptHistoryOptions,
): Promise<{ entries: TranscriptHistoryEntry[]; truncated: boolean }> {
  if (agent.jsonlFile) {
    const tail = await readTranscriptTail(agent.jsonlFile);
    if (tail) {
      return {
        entries: entriesFromTranscriptLines(tail.lines, tail.mtimeMs, opts),
        truncated: tail.truncated,
      };
    }
  }
  return { entries: [...(agent.historyLog ?? [])], truncated: false };
}

/** Whether the agent runs in a Teammate's own transcript (sidechain records). */
function isTeammate(agent: AgentState): boolean {
  return agent.leadAgentId !== undefined || (!!agent.agentName && !agent.isTeamLead);
}

/**
 * The `agentHistory` reply to a `requestAgentHistory`. Never throws: a
 * malformed request answers `reason: 'invalid-request'`, an agent not in the
 * office `reason: 'unknown-agent'`, both with no entries.
 */
export async function buildAgentHistory(
  store: AgentStateStore,
  msg: { id?: unknown; before?: unknown; limit?: unknown },
  formatterFor: (agent: AgentState) => ToolStatusFormatter,
): Promise<AgentHistory> {
  const request = agentHistoryRequestFrom(msg);
  if (!request) {
    const id = typeof msg.id === 'number' && Number.isInteger(msg.id) ? msg.id : -1;
    return { type: 'agentHistory', id, entries: [], reason: 'invalid-request' };
  }
  const { id } = request;
  const agent = store.get(id);
  if (!agent) return { type: 'agentHistory', id, entries: [], reason: 'unknown-agent' };

  const group = historyGroupOf(id, store);
  let all: AgentHistoryEntry[];
  let truncated: boolean;
  if (!group) {
    const own = await ownEntries(agent, { formatToolStatus: formatterFor(agent) });
    all = own.entries.map(stripAgentName);
    truncated = own.truncated;
  } else {
    // The shared session: the Lead's, else (no Lead in the office) the agent's own.
    const source = group.lead ?? agent;
    const sourceId = group.lead ? group.leadAgentId! : id;
    const byName = new Map<string, number>();
    for (const memberId of group.memberAgentIds) {
      const name = store.get(memberId)?.agentName;
      if (name) byName.set(name, memberId);
    }
    const attribute = (entry: TranscriptHistoryEntry, fallbackAuthor?: number) => {
      const author =
        (entry.agentName !== undefined ? byName.get(entry.agentName) : undefined) ?? fallbackAuthor;
      return {
        ...stripAgentName(entry),
        shared: true,
        ...(group.teamName ? { teamName: group.teamName } : {}),
        ...(author !== undefined ? { authorAgentId: author } : {}),
      };
    };
    const shared = await ownEntries(source, {
      formatToolStatus: formatterFor(source),
      includeSidechain: source === agent && isTeammate(agent),
    });
    // The Lead's main chain is the Lead's unless a record's tag names a member.
    const leadAuthor = group.lead ? sourceId : undefined;
    all = shared.entries.map((e) => attribute(e, leadAuthor));
    truncated = shared.truncated;
    // A Teammate with a transcript of its own (own session): its entries too.
    const ownFile = source !== agent && agent.jsonlFile && agent.jsonlFile !== source.jsonlFile;
    const ownLog = source !== agent && !agent.jsonlFile && agent.historyLog?.length;
    if (ownFile || ownLog) {
      const own = await ownEntries(agent, {
        formatToolStatus: formatterFor(agent),
        includeSidechain: true,
      });
      all = all.concat(own.entries.map((e) => attribute(e, id)));
      truncated ||= own.truncated;
      // Stable: entries at the same ms keep their source order.
      all.sort((a, b) => a.ts - b.ts);
    }
  }

  const page = historyPage(all, request, truncated);
  const out: AgentHistory = {
    type: 'agentHistory',
    id,
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    entries: page.entries,
    ...(page.more ? { more: true } : {}),
  };
  if (group) {
    out.group = {
      ...(group.teamName ? { teamName: group.teamName } : {}),
      ...(group.leadAgentId !== undefined ? { leadAgentId: group.leadAgentId } : {}),
      memberAgentIds: group.memberAgentIds,
    };
  }
  return out;
}

function stripAgentName(entry: TranscriptHistoryEntry): AgentHistoryEntry {
  const { agentName: _agentName, ...rest } = entry;
  return rest;
}
