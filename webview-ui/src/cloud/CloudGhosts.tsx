import { useSyncExternalStore } from 'react';

import {
  CLOUD_GHOST_EYE_COLOR,
  ENGINE_BADGE_TEXT_COLOR,
  ENGINE_CODEX_COLOR,
} from '../constants.js';
import type { CloudTask } from './cloudStore.js';
import { cloudProviders, safeTaskUrl, subscribeCloud } from './cloudStore.js';
import { CHIP_TITLE_MAX, shortTitle } from './cloudSummary.js';
import { CLOUD_STATUS_VIEW } from './cloudView.js';
import { useShortScreen } from './useShortScreen.js';

// A 12×12 pixel ghost (our own art): 1 = body, 2 = eye.
const GHOST_ROWS = [
  '000111111000',
  '001111111100',
  '011111111110',
  '011221122110',
  '111221122111',
  '111111111111',
  '111111111111',
  '111111111111',
  '111111111111',
  '111111111111',
  '110110011011',
  '100100001001',
];

export function GhostSprite({ color, size }: { color: string; size: number }) {
  const rects = [];
  for (let y = 0; y < GHOST_ROWS.length; y++) {
    for (let x = 0; x < GHOST_ROWS[y].length; x++) {
      const c = GHOST_ROWS[y][x];
      if (c === '0') continue;
      rects.push(
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={1}
          height={1}
          fill={c === '2' ? CLOUD_GHOST_EYE_COLOR : color}
        />,
      );
    }
  }
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="shrink-0"
    >
      {rects}
    </svg>
  );
}

function openTask(task: CloudTask) {
  const url = safeTaskUrl(task.url);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

/** Short screen (~360×374): compact chip — ghost, status and the title
 *  wrapped over up to two lines; the full title stays in the tooltip and the
 *  accessible name. Tap opens the task. */
function GhostChip({ task, providerName }: { task: CloudTask; providerName: string }) {
  const view = CLOUD_STATUS_VIEW[task.status];
  const fullLabel = `${providerName}: ${task.title} (${task.rawStatus || view.label})`;
  return (
    <button
      type="button"
      onClick={() => openTask(task)}
      title={fullLabel}
      aria-label={fullLabel}
      data-testid="cloud-ghost"
      data-status={task.status}
      className="pixel-panel flex items-center gap-3 px-3 py-1 cursor-pointer text-2xs leading-none text-left"
      style={{ opacity: task.status === 'unavailable' ? 0.5 : 1, maxWidth: '100%' }}
    >
      <span
        className={`shrink-0 ${task.status === 'active' ? 'cloud-ghost-float' : ''}`}
        style={{ opacity: 0.6 }}
      >
        <GhostSprite color={view.color} size={16} />
      </span>
      <span className="flex flex-col gap-1 min-w-0">
        <span style={{ color: view.color }} data-testid="cloud-status">
          {view.label}
        </span>
        <span className="cloud-chip-title" data-testid="cloud-title">
          {shortTitle(task.title, CHIP_TITLE_MAX)}
        </span>
      </span>
    </button>
  );
}

function GhostCard({
  task,
  providerName,
  compact,
}: {
  task: CloudTask;
  providerName: string;
  compact: boolean;
}) {
  const view = CLOUD_STATUS_VIEW[task.status];
  const active = task.status === 'active';
  return (
    <button
      type="button"
      onClick={() => openTask(task)}
      title={`${providerName}: ${task.title} (${task.rawStatus || view.label})`}
      data-testid="cloud-ghost"
      data-status={task.status}
      className={`pixel-panel flex items-center text-left cursor-pointer ${compact ? 'gap-4 px-4 py-1' : 'gap-6 px-6 py-2'}`}
      style={{ opacity: task.status === 'unavailable' ? 0.5 : 1 }}
    >
      <span className={active ? 'cloud-ghost-float' : undefined} style={{ opacity: 0.6 }}>
        <GhostSprite color={view.color} size={compact ? 22 : 32} />
      </span>
      <span className="flex flex-col overflow-hidden" style={{ maxWidth: compact ? 190 : 220 }}>
        <span className="flex items-center gap-4 leading-none">
          <span className="text-2xs leading-none" aria-label="cloud">
            ☁
          </span>
          <span
            className="text-2xs leading-none px-2"
            style={{ background: ENGINE_CODEX_COLOR, color: ENGINE_BADGE_TEXT_COLOR }}
            data-testid="cloud-vendor"
          >
            {providerName}
          </span>
          <span
            className="text-2xs leading-none"
            style={{ color: view.color }}
            data-testid="cloud-status"
          >
            {view.label}
          </span>
        </span>
        <span
          className={`${compact ? 'text-2xs' : 'text-sm'} leading-none overflow-hidden text-ellipsis whitespace-nowrap`}
        >
          {task.title}
        </span>
      </span>
    </button>
  );
}

/** The ☁ ghosts of every cloud provider, docked at the top-right of the office. */
export function CloudGhosts({ compact = false }: { compact?: boolean }) {
  const providers = useSyncExternalStore(subscribeCloud, cloudProviders);
  const short = useShortScreen();
  if (providers.length === 0) return null;
  if (compact && short) {
    // Cover screen: a single ☁ header per provider and one-line chips.
    return (
      <div
        className="absolute z-10 flex flex-col items-end gap-1 right-2 mobile-safe-top pointer-events-auto"
        data-testid="cloud-ghosts"
        data-variant="cover"
        style={{ marginTop: 36, maxWidth: '62vw' }}
      >
        {providers.map((p) => (
          <div key={p.providerId} className="flex flex-col items-end gap-1">
            <span className="text-2xs leading-none pixel-panel px-3" data-testid="cloud-vendor">
              ☁ {p.providerName}
              {!p.available && ' · unavailable'}
            </span>
            {p.tasks.slice(0, 3).map((t) => (
              <GhostChip key={t.id} task={t} providerName={p.providerName} />
            ))}
            {p.tasks.length > 3 && (
              <span className="text-2xs leading-none">+{p.tasks.length - 3}</span>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      // Desktop: top-left, right of the zoom buttons (the agent cards own the
      // top-right). Phone: top-right, under the connection pill.
      className={`absolute z-10 flex flex-col pointer-events-auto ${compact ? 'gap-2 right-4 mobile-safe-top items-end' : 'gap-4 top-8 items-start'}`}
      data-testid="cloud-ghosts"
      style={compact ? { marginTop: 40 } : { left: 56 }}
    >
      {providers.map((p) => (
        <div
          key={p.providerId}
          className={`flex flex-col gap-2 ${compact ? 'items-end' : 'items-start'}`}
        >
          {!p.available && (
            <span
              className="text-2xs pixel-panel px-4"
              data-testid="cloud-unavailable"
              title={p.reason}
            >
              ☁ {p.providerName}: unavailable
            </span>
          )}
          {p.tasks.map((t) => (
            <GhostCard key={t.id} task={t} providerName={p.providerName} compact={compact} />
          ))}
        </div>
      ))}
    </div>
  );
}
