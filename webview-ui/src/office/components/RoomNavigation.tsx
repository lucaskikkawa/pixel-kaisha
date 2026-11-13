import type { MutableRefObject } from 'react';

import type { OfficeState } from '../engine/officeState.js';

const ROOMS = [
  { id: 'work', label: 'Work' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'rest', label: 'Rest' },
] as const;

export function RoomNavigation({
  officeState,
  panRef,
  zoom,
  containerRef,
}: {
  officeState: OfficeState;
  panRef: MutableRefObject<{ x: number; y: number }>;
  zoom: number;
  containerRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const goTo = (room: (typeof ROOMS)[number]['id']) => {
    officeState.breakCameraFollow();
    const center = officeState.roomCenter(room);
    const bounds = containerRef.current?.getBoundingClientRect();
    const width = bounds?.width ?? window.innerWidth;
    const height = bounds?.height ?? window.innerHeight;
    panRef.current = {
      x: width / 2 - center.x * zoom,
      y: height / 2 - center.y * zoom,
    };
  };

  return (
    <nav
      aria-label="Office rooms"
      className="absolute z-30 top-10 left-1/2 -translate-x-1/2 flex gap-4 pixel-panel p-4 pointer-events-auto"
    >
      {ROOMS.map(({ id, label }) => (
        <button
          type="button"
          key={id}
          className="min-w-56 px-8 py-5 text-xs text-text hover:text-accent focus-visible:outline focus-visible:outline-1"
          onClick={() => goTo(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
