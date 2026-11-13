import { type RefObject, useEffect, useRef, useState } from 'react';

import type { AgentHistory as AgentHistoryMessage } from '../../../core/src/messages.js';
import {
  CONTROL_RECTS_REFRESH_MS,
  HISTORY_PANEL_CHROME_MIN_TOP_SHARE,
  HISTORY_PANEL_CHROME_SELECTOR,
  HISTORY_PANEL_EDGE_PX,
} from '../constants.js';
import {
  type ChromeRect,
  chronologicalEntries,
  historyPanelBottomInset,
} from './agentHistoryView.js';

interface Props {
  history: AgentHistoryMessage | null;
  agentId: number;
  agentName: string;
  mode: 'side' | 'overlay';
  onMode: (mode: 'side' | 'overlay') => void;
  onClose: () => void;
  onEarlier: () => void;
  names: ReadonlyMap<number, string>;
  /** The phone shell: the panel stays inside the viewport, above the bottom chrome. */
  phone?: boolean;
}

/** The phone panel's bottom inset, re-measured as the chrome moves (roster, keyboard, rotation). */
function useBottomInset(enabled: boolean, panel: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState<number>(HISTORY_PANEL_EDGE_PX);
  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const chrome: ChromeRect[] = [];
      for (const node of Array.from(
        document.querySelectorAll<HTMLElement>(HISTORY_PANEL_CHROME_SELECTOR),
      )) {
        if (panel.current?.contains(node)) continue;
        const r = node.getBoundingClientRect();
        chrome.push({
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          marked: node.hasAttribute('data-bottom-chrome'),
        });
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = historyPanelBottomInset(
        viewport,
        chrome,
        HISTORY_PANEL_EDGE_PX,
        HISTORY_PANEL_CHROME_MIN_TOP_SHARE,
      );
      setInset((current) => (current === next ? current : next));
    };
    measure();
    const timer = window.setInterval(measure, CONTROL_RECTS_REFRESH_MS);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [enabled, panel]);
  return inset;
}

export function AgentHistoryPanel({
  history,
  agentId,
  agentName,
  mode,
  onMode,
  onClose,
  onEarlier,
  names,
  phone = false,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const bottomInset = useBottomInset(phone, panelRef);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const entries = history?.id === agentId ? chronologicalEntries(history.entries) : [];
  // Phone: between the safe top and the bottom chrome (bottomInset), 8px from the sides;
  // the overlay is centred in that band by its auto margins, up to 560px.
  const placement = phone
    ? mode === 'side'
      ? 'fixed right-8 mobile-safe-top w-[min(380px,calc(100vw-16px))]'
      : 'fixed left-8 right-8 mobile-safe-top m-auto max-h-[560px] max-w-[560px]'
    : mode === 'side'
      ? 'absolute right-8 top-8 bottom-8 w-[min(380px,calc(100%-16px))]'
      : 'fixed left-1/2 top-1/2 h-[min(560px,calc(100dvh-16px))] w-[min(560px,calc(100vw-16px))] -translate-x-1/2 -translate-y-1/2';
  return (
    <section
      ref={panelRef}
      aria-label={`${agentName} history`}
      data-testid="agent-history-panel"
      className={`pixel-panel z-40 flex flex-col overflow-hidden ${placement}`}
      style={phone ? { bottom: bottomInset } : undefined}
    >
      <header className="flex shrink-0 items-center gap-4 border-b-2 border-border p-8">
        <div className="min-w-0 flex-1">
          <strong className="block truncate" title={agentName}>
            {agentName} · History
          </strong>
          {history?.group && (
            <span className="block truncate text-text-muted" title={history.group.teamName}>
              Group · {history.group.teamName}
            </span>
          )}
        </div>
        <button
          className="pixel-panel px-6 py-4 text-sm"
          onClick={() => onMode(mode === 'side' ? 'overlay' : 'side')}
          aria-label="Change history presentation"
        >
          {mode === 'side' ? 'Overlay' : 'Side panel'}
        </button>
        <button className="pixel-panel px-6 py-4" onClick={onClose} aria-label="Close history">
          ×
        </button>
      </header>
      {history?.reason ? (
        <p className="m-8 text-warning">History unavailable ({history.reason}).</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-8" data-testid="agent-history-entries">
        {!history && <p className="text-text-muted">Loading history…</p>}
        {history && entries.length === 0 && !history.reason && (
          <p className="text-text-muted">No history yet.</p>
        )}
        {entries.map((entry, index) => (
          <article
            key={`${entry.ts}-${index}`}
            className="mb-8 min-w-0 border-2 border-border bg-panel p-8"
            title={entry.text}
          >
            <div className="mb-4 flex flex-wrap items-center gap-x-8 text-text-muted">
              <time>
                {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
              <span>
                {entry.kind === 'speech'
                  ? `Speech${entry.role ? ` · ${entry.role}` : ''}`
                  : `Action${entry.toolName ? ` · ${entry.toolName}` : ''}`}
              </span>
              {entry.shared && (
                <span className="border border-accent px-4 text-text">
                  Shared{entry.teamName ? ` · ${entry.teamName}` : ''}
                </span>
              )}
              {entry.authorAgentId !== undefined && (
                <span>{names.get(entry.authorAgentId) ?? `Agent ${entry.authorAgentId}`}</span>
              )}
            </div>
            <p className="m-0 break-words [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
              {entry.text}
            </p>
          </article>
        ))}
      </div>
      {history?.more && (
        <button className="m-8 shrink-0 pixel-panel p-8" onClick={onEarlier}>
          Load earlier
        </button>
      )}
      <p className="m-0 border-t-2 border-border px-8 py-4 text-text-muted">
        Oldest first · scroll for newer entries
      </p>
    </section>
  );
}
