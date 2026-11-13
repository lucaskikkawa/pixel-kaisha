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

/** UI over the office, in viewport CSS px; `marked` = a `[data-bottom-chrome]` element. */
export interface ChromeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  marked?: boolean;
}

/**
 * Pixel Kaisha: how far (CSS px) above the viewport's bottom the phone's history panel
 * ends — clear of the bottom chrome (card bar, dock, radio hint) with `edge` px of air,
 * like the balloons. Controls off screen (the terminal page beside the office) or above
 * the lowest `minTopShare` of the viewport don't count, unless marked.
 */
export function historyPanelBottomInset(
  viewport: { width: number; height: number },
  chrome: readonly ChromeRect[],
  edge: number,
  minTopShare: number,
): number {
  let top = viewport.height;
  for (const r of chrome) {
    if (r.bottom <= r.top || r.right <= r.left) continue;
    if (r.right <= 0 || r.left >= viewport.width || r.top >= viewport.height || r.bottom <= 0) {
      continue;
    }
    if (!r.marked && r.top < viewport.height * minTopShare) continue;
    top = Math.min(top, Math.max(0, r.top));
  }
  return viewport.height - top + edge;
}
