import type { AgentHistoryEntry } from '../../../core/src/messages.js';

/** The protocol normally sends oldest-first; sort defensively and retain stable order for ties. */
export function chronologicalEntries(entries: readonly AgentHistoryEntry[]): AgentHistoryEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts - b.entry.ts || a.index - b.index)
    .map(({ entry }) => entry);
}

export function earlierHistoryRequest(id: number, entries: readonly AgentHistoryEntry[]) {
  const oldest = chronologicalEntries(entries)[0];
  return oldest ? { type: 'requestAgentHistory' as const, id, before: oldest.ts } : null;
}

export function mergeEarlierEntries(
  current: readonly AgentHistoryEntry[],
  earlier: readonly AgentHistoryEntry[],
): AgentHistoryEntry[] {
  return chronologicalEntries([...earlier, ...current]);
}
