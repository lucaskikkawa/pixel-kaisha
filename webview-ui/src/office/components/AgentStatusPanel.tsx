import { useEffect, useRef, useState } from 'react';

import { agentEngineBadge } from '../../cloud/engineBadge.js';
import { formatElapsed, stateStartedAt } from '../agentStatusRow.js';
import type { OfficeState } from '../engine/officeState.js';

function statusLine(ch: ReturnType<OfficeState['characters']['get']>) {
  if (!ch) return { state: 'Idle', tool: '—' };
  if (ch.bubbleType === 'permission')
    return { state: 'Needs approval', tool: ch.currentTool || '—' };
  if (ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)
    return { state: 'Waiting for input', tool: '—' };
  if (ch.bubbleType === 'waiting') return { state: 'Done', tool: '—' };
  if (ch.isActive)
    return {
      state: ch.currentTool ? `Working (${ch.currentTool})` : 'Working',
      tool: ch.currentTool || '—',
    };
  return { state: 'Idle', tool: '—' };
}

export function AgentStatusPanel({
  officeState,
  agents,
  agentTools,
  agentStatuses,
  agentAwaitingInput,
}: {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, { status: string; done: boolean }[]>;
  agentStatuses: Record<number, string>;
  agentAwaitingInput: Record<number, boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  const since = useRef(new Map<number, { signature: string; at: number }>());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = now
    ? agents.map((id) => {
        const ch = officeState.characters.get(id);
        const derived = statusLine(ch);
        const active = agentTools[id]
          ?.slice()
          .reverse()
          .find((item) => !item.done);
        const state =
          agentStatuses[id] === 'waiting'
            ? agentAwaitingInput[id]
              ? 'Waiting for input'
              : 'Done'
            : derived.state;
        const signature = `${state}|${derived.tool}|${active?.status ?? ''}`;
        const old = stateStartedAt(since.current.get(id), signature, now);
        since.current.set(id, old);
        const started = old.at;
        const name = ch?.agentName || `Agent ${id}`;
        return {
          id,
          ch,
          name,
          state,
          tool: active?.status ?? derived.tool,
          source: agentEngineBadge(id).label,
          age: formatElapsed(Math.floor((now - started) / 1000)),
        };
      })
    : [];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="absolute top-10 right-10 z-40 pixel-panel px-10 py-6 text-xs pointer-events-auto"
        aria-expanded={open}
      >
        Status
      </button>
      {open && (
        <section
          className="absolute z-40 top-44 right-10 w-[min(560px,calc(100%-20px))] max-h-[calc(100%-100px)] overflow-auto pixel-panel p-10 text-xs pointer-events-auto"
          aria-label="Agent status"
        >
          <h2 className="mb-8 text-sm">Agent status</h2>
          <div className="grid grid-cols-[minmax(50px,1fr)_48px_minmax(78px,1.1fr)_minmax(70px,1.3fr)_42px] gap-x-6 border-b border-border pb-4 text-text-muted">
            <span>Name</span>
            <span>Source</span>
            <span>State</span>
            <span>Tool</span>
            <span>Time</span>
          </div>
          {rows.length ? (
            rows.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[minmax(50px,1fr)_48px_minmax(78px,1.1fr)_minmax(70px,1.3fr)_42px] gap-x-6 border-b border-border py-5"
              >
                {[row.name, row.source, row.state, row.tool, row.age].map((value, i) => (
                  <span
                    key={i}
                    title={value}
                    className="overflow-hidden text-ellipsis whitespace-nowrap"
                  >
                    {value}
                  </span>
                ))}
              </div>
            ))
          ) : (
            <p className="py-8 text-text-muted">No agents</p>
          )}
        </section>
      )}
    </>
  );
}
